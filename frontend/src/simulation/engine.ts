/**
 * Digital Twin 模擬引擎（Phase 2：本地執行；Phase 3 原樣搬到 Python 後端）
 *
 * 原則
 *  - 確定性：所有亂數來自 seed 決定的 PRNG，不讀時鐘。同 seed + 同輸入 → 同結果。
 *  - 純資料：state 是 TwinState，可 JSON 序列化、可複製（What-if）。
 *  - 固定 tick = 100 ms 模擬時間。
 *
 * 每 tick 的順序：任務產生 → 任務指派 → 每台機器人 FSM/移動/電池 → Zone/擁塞統計 → KPI → 事件整理
 */
import type { WarehouseLayout, LayoutLocation } from "../layout/types";
import { buildNavGrid } from "../layout/navgrid";
import type {
  TwinState, RobotState, TaskState, TwinEvent, AlertState, AiDecision, DecisionCandidate,
  GridCell, RobotFsmState, RobotStatus, EventType, Severity, TaskPriority, ScenarioInjection,
} from "../schema/twin_state";
import { THRESHOLDS } from "../schema/twin_state";
import { astar, cellKey, cellCenter, isWalkable, nearestWalkable, toCell, type NavGrid } from "./astar";

// ─────────────────────────────────────────────────────────────
// 參數（集中一處，之後可由 UI 調整）
// ─────────────────────────────────────────────────────────────
export const SIM = {
  TICK_S: THRESHOLDS.TICK_MS / 1000,
  MAX_SPEED: 1.5,            // m/s
  ACCEL: 1.2,                // m/s²
  TURN_SLOW: 0.5,            // 轉彎時速度上限比例
  PICK_TICKS: 40,            // 取貨停留 4 s
  DROP_TICKS: 30,
  BATTERY_MOVE: 0.010,       // %/tick @ 全速
  BATTERY_LOAD: 0.004,       // 載貨額外
  BATTERY_IDLE: 0.0008,
  CHARGE_RATE: 0.06,         // %/tick  → 0 → 95% 約 160 s
  TASK_INTERVAL_TICKS: 70,   // 平均每 7 s 一個新任務
  MAX_WAITING_TASKS: 12,
  WAIT_REPLAN_TICKS: 25,     // 被擋 2.5 s 後重新規劃
  WAIT_BACKOFF_TICKS: 80,    // 被擋 8 s 仍無解 → 讓路 (deadlock breaker)
  STATION_ARRIVE_CELLS: 3,   // 距工作站 ≤3 格且前方被佔 → 就地作業 (多台同時上貨，不排單一格)
  ON_TIME_LIMIT_TICKS: 2400, // 4 min 內完成算準時
  IDLE_TO_PARK_TICKS: 300,   // 閒置 30 s 回停車區
  KPI_EVERY: 10,
  SERIES_EVERY: 600,         // throughput 曲線每 60 s 一點
  EVENT_RING: THRESHOLDS.EVENT_RING_SIZE,
  ZONE_CAPACITY: 6,          // 一個 zone 超過幾台算擁塞
};

export function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 引擎私有、不進 TwinState 的每台機器人運行資料 */
interface RobotRt {
  /** 讓路中：暫時走到旁邊的格，到達後回到 resumePoint 重新規劃 */
  backingOff: boolean;
  resumePoint: [number, number] | null;
  dwell: number;                 // 剩餘停留 ticks
  waitTicks: number;             // 被擋住累計
  target: GridCell | null;       // 目前路徑的終點
  goalLoc: string | null;        // 目前要去的 location id
  phase: "TO_SOURCE" | "TO_DEST" | "TO_CHARGER" | "TO_PARK" | null;
  chargerId: string | null;
  idleTicks: number;
  lastBatteryAlert: "NONE" | "WARN" | "CRIT";
}

export interface EngineOptions { seed?: number; initialState?: TwinState }

export class SimEngine {
  readonly layout: WarehouseLayout;
  readonly grid: NavGrid;
  state: TwinState;
  /** 長期交通累計（cols*rows，衰減極慢）：HEATMAP 用、也當 A* 的擁塞成本 */
  traffic: Float32Array;
  /** 短期交通（衰減快，約 20 s 記憶）：TRAFFIC VIEW 用 */
  trafficShort: Float32Array;
  private rng: () => number;
  private rt: Record<string, RobotRt> = {};
  private loc: Record<string, LayoutLocation>;
  private occupancy = new Map<string, string>(); // cellKey → robotId
  private nextTaskTick = 0;
  private taskSeq = 3812;
  private eventSeq = 0;
  private decisionSeq = 0;
  private chargerBusy: Record<string, string | null> = {};
  private blockedZones = new Set<string>();
  /** 交通擁塞注入：zone → { level, until } */
  private congestedZones = new Map<string, { level: number; until: number }>();
  private pendingInjections: ScenarioInjection[] = [];
  private taskTimes: number[] = [];
  private onTime = 0; private completedCount = 0;
  private lastSeriesTick = 0;

  constructor(layout: WarehouseLayout, opts: EngineOptions = {}) {
    this.layout = layout;
    this.grid = buildNavGrid(layout);
    this.traffic = new Float32Array(this.grid.cols * this.grid.rows);
    this.trafficShort = new Float32Array(this.grid.cols * this.grid.rows);
    this.loc = Object.fromEntries(layout.locations.map((l) => [l.id, l]));
    const seed = opts.seed ?? 42;
    this.rng = mulberry32(seed);
    for (const c of layout.charging_stations) this.chargerBusy[c.id] = null;
    this.state = opts.initialState ? JSON.parse(JSON.stringify(opts.initialState)) : this.buildInitialState(seed);
    for (const id of Object.keys(this.state.robots)) this.rt[id] = { backingOff: false, resumePoint: null, dwell: 0, waitTicks: 0, target: null, goalLoc: null, phase: null, chargerId: null, idleTicks: 0, lastBatteryAlert: "NONE" };
    this.nextTaskTick = this.state.sim.tick + 10;
  }

  // ─────────────────────────────────────────────────────────
  // 初始狀態
  // ─────────────────────────────────────────────────────────
  private buildInitialState(seed: number): TwinState {
    const L = this.layout;
    const robots: Record<string, RobotState> = {};
    for (const sp of L.spawn.robots) {
      robots[sp.id] = {
        id: sp.id, model: "AMR-L", position: [Math.floor(sp.position[0]) + 0.5, 0, Math.floor(sp.position[2]) + 0.5], heading: sp.heading, velocity: 0, max_speed: SIM.MAX_SPEED,
        battery: sp.battery, status: "IDLE", fsm: "IDLE", health: 95 + Math.floor(this.rng() * 5), current_task_id: null, destination: null,
        path: [], path_index: 0, load: { current: 0, capacity: 4 }, zone: null, eta_s: null, fsm_since_tick: 0,
        stats: { distance_m: 0, tasks_completed: 0, energy_wh: 0, busy_ticks: 0, wait_ticks: 0 },
      };
    }
    return {
      schema_version: "1.0", layout_id: L.id,
      sim: { tick: 0, tick_ms: THRESHOLDS.TICK_MS, speed: 1, mode: "LIVE", seed, baseline_snapshot_id: null },
      robots, tasks: {},
      zones: Object.fromEntries(L.zones.map((z) => [z.id, { id: z.id, status: "NORMAL" as const, robot_count: 0, congestion: 0, blocked_reason: null, blocked_since_tick: null }])),
      conveyors: Object.fromEntries(L.conveyors.map((c) => [c.id, { id: c.id, status: "RUNNING" as const, speed_mps: c.speed_mps, items_on_belt: 4, throughput_per_min: 4 }])),
      cameras: Object.fromEntries(L.cameras.map((c) => [c.id, { id: c.id, zone: c.zone, status: "ONLINE" as const, last_observation: null }])),
      sensors: Object.fromEntries(L.sensors.map((s) => [s.id, { id: s.id, kind: s.kind as never, zone: s.zone, status: "ONLINE" as const, value: null, unit: null }])),
      people: {}, alerts: {}, recent_events: [], recent_decisions: [],
      kpi: {
        tick: 0, fleet: { total: Object.keys(robots).length, active: 0, charging: 0, idle: Object.keys(robots).length, warning: 0, error: 0, offline: 0 },
        operation: { throughput_per_min: 0, completed_today: 0, completed_target: 150, pending: 0, ongoing: 0, avg_task_time_s: 0, on_time_rate: 1, avg_utilization: 0 },
        efficiency: { avg_travel_distance_m: 0, avg_wait_time_s: 0, congestion_index: 0, energy_kwh: 0 },
        throughput_series: [{ tick: 0, completed: 0, target: 0 }],
      },
      subsystems: { WAREHOUSE: "NORMAL", CONVEYORS: "NORMAL", CHARGING: "NORMAL", CCTV: "NORMAL", NETWORK: "NORMAL" },
    };
  }

  // ─────────────────────────────────────────────────────────
  // 公開 API
  // ─────────────────────────────────────────────────────────
  /** 注入情境（Phase 4 的故障注入 / Phase 6 What-if 共用） */
  inject(inj: ScenarioInjection) {
    this.pendingInjections.push(inj);
    this.emit("SCENARIO_INJECTED", "USER", "INFO", `Scenario injected: ${inj.kind}${"zone_id" in inj ? " (Zone " + inj.zone_id + ")" : "robot_id" in inj ? " (" + inj.robot_id + ")" : "conveyor_id" in inj ? " (" + inj.conveyor_id + ")" : "camera_id" in inj ? " (" + inj.camera_id + ")" : ""}`);
  }

  /** 解除注入：機器人恢復上線、輸送帶恢復、攝影機上線、人員離開、交通擁塞解除 */
  clearInjection(kind: ScenarioInjection["kind"], targetId: string) {
    const S = this.state;
    switch (kind) {
      case "ROBOT_FAILURE": { const r = S.robots[targetId]; if (r && r.fsm === "OFFLINE") { this.setFsm(r, "IDLE"); this.rt[r.id].phase = null; this.rt[r.id].target = null; this.resolveAlert(`off-${r.id}`); this.emit("ROBOT_ONLINE", "USER", "INFO", `${r.id} back online`, { robot_id: r.id }); } break; }
      case "CONVEYOR_FAILURE": { const c = S.conveyors[targetId]; const lc = this.layout.conveyors.find((x) => x.id === targetId); if (c && lc) { c.status = "RUNNING"; c.speed_mps = lc.speed_mps; this.resolveAlert(`cv-${c.id}`); this.emit("CONVEYOR_STATUS_CHANGED", "CONVEYOR", "INFO", `${c.id} restored — RUNNING`, { conveyor_id: c.id }); } break; }
      case "CAMERA_OFFLINE": { const c = S.cameras[targetId]; if (c) { c.status = "ONLINE"; if (Object.values(S.cameras).every((x) => x.status === "ONLINE")) S.subsystems.CCTV = "NORMAL"; this.emit("CAMERA_STATUS_CHANGED", "CAMERA", "INFO", `${c.id} online`, { camera_id: c.id }); } break; }
      case "HUMAN_INTRUSION": { for (const pid in S.people) if (S.people[pid].zone === targetId) S.people[pid].expires_tick = S.sim.tick; break; }
      case "TRAFFIC_CONGESTION": { this.congestedZones.delete(targetId); this.emit("ZONE_UNBLOCKED", "USER", "INFO", `Zone ${targetId} traffic restriction lifted`, { zone_id: targetId }); break; }
      default: break;
    }
  }

  /** 使用者手動建立任務 */
  createTask(t: { type: TaskState["type"]; priority: TaskPriority; source: string; destination: string; load_units?: number }): TaskState {
    const id = `A${this.taskSeq++}`;
    const task: TaskState = { id, type: t.type, priority: t.priority, status: "WAITING", source: t.source, destination: t.destination, assigned_robot: null, parent_task_id: null, created_tick: this.state.sim.tick, assigned_tick: null, started_tick: null, completed_tick: null, deadline_tick: this.state.sim.tick + SIM.ON_TIME_LIMIT_TICKS, eta_s: null, load_units: t.load_units ?? 1 };
    this.state.tasks[id] = task;
    this.emit("TASK_CREATED", "SIMULATION", "INFO", `Task #${id} created (${t.type} ${this.pretty(t.source)} → ${this.pretty(t.destination)})`, { task_id: id });
    return task;
  }

  /** 前進一個 tick */
  step() {
    const S = this.state; S.sim.tick++;
    const tick = S.sim.tick;
    this.applyInjections();
    this.generateTasks();
    this.assignTasks();
    this.rebuildOccupancy();
    for (const id of Object.keys(S.robots)) this.stepRobot(S.robots[id], this.rt[id]);
    this.updateZones();
    this.decayTraffic();
    if (tick % SIM.KPI_EVERY === 0) { this.updateKpi(); this.updateDevices(); }
    if (tick - this.lastSeriesTick >= SIM.SERIES_EVERY) this.pushSeries();
    this.pruneTasks();
  }

  /** 產生給 UI 的新參考快照（淺拷貝，讓 React 偵測變更） */
  snapshot(): TwinState {
    const S = this.state;
    const robots: Record<string, RobotState> = {};
    for (const id in S.robots) robots[id] = { ...S.robots[id], position: [...S.robots[id].position] as [number, number, number], path: S.robots[id].path };
    return { ...S, sim: { ...S.sim }, robots, tasks: { ...S.tasks }, zones: { ...S.zones }, alerts: { ...S.alerts }, kpi: { ...S.kpi }, recent_events: S.recent_events.slice(), recent_decisions: S.recent_decisions.slice() };
  }

  // ─────────────────────────────────────────────────────────
  // 任務
  // ─────────────────────────────────────────────────────────
  private generateTasks() {
    const S = this.state;
    if (S.sim.tick < this.nextTaskTick) return;
    this.nextTaskTick = S.sim.tick + Math.round(SIM.TASK_INTERVAL_TICKS * (0.5 + this.rng()));
    const waiting = Object.values(S.tasks).filter((t) => t.status === "WAITING").length;
    if (waiting >= SIM.MAX_WAITING_TASKS) return;
    const shelves = this.layout.locations.filter((l) => l.kind === "SHELF");
    const packs = this.layout.locations.filter((l) => l.kind === "PACKING" || l.kind === "SORTING");
    const inbound = this.layout.locations.filter((l) => l.kind === "INBOUND");
    const outbound = this.layout.locations.filter((l) => l.kind === "OUTBOUND");
    const pick = <T,>(a: T[]) => a[Math.floor(this.rng() * a.length)];
    const r = this.rng();
    const pr: TaskPriority = r < 0.15 ? "HIGH" : r < 0.18 ? "CRITICAL" : "NORMAL";
    if (r < 0.55) this.createTask({ type: "PICK", priority: pr, source: pick(shelves).id, destination: pick(packs).id });
    else if (r < 0.8) this.createTask({ type: "REPLENISH", priority: pr, source: pick(inbound).id, destination: pick(shelves).id });
    else this.createTask({ type: "TRANSPORT", priority: pr, source: pick(packs).id, destination: pick(outbound).id });
  }

  /** Fleet Manager（簡化版）：距離 + 電量 + 負載 + 擁塞 + 健康 的加權分數，附可解釋的候選清單 */
  private assignTasks() {
    const S = this.state;
    const prioRank: Record<TaskPriority, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
    const waiting = Object.values(S.tasks).filter((t) => t.status === "WAITING").sort((a, b) => prioRank[a.priority] - prioRank[b.priority] || a.created_tick - b.created_tick);
    if (!waiting.length) return;
    const idle = Object.values(S.robots).filter((r) => r.fsm === "IDLE" && r.status !== "OFFLINE" && r.status !== "ERROR" && r.battery > THRESHOLDS.BATTERY_WARNING);
    const weights = { distance: 0.35, battery: 0.25, workload: 0.15, congestion: 0.15, health: 0.10 };
    for (const task of waiting) {
      if (!idle.length) return;
      const src = this.loc[task.source]; if (!src) { task.status = "FAILED"; continue; }
      const cands: DecisionCandidate[] = idle.map((r) => {
        const d = Math.hypot(r.position[0] - src.access_point[0], r.position[2] - src.access_point[1]);
        const zone = r.zone ? S.zones[r.zone] : null;
        const cong = zone ? zone.congestion : 0;
        const workload: DecisionCandidate["workload"] = r.stats.tasks_completed > 8 ? "HIGH" : r.stats.tasks_completed > 4 ? "MEDIUM" : "LOW";
        const score = weights.distance * (1 - Math.min(1, d / 120)) + weights.battery * (r.battery / 100) + weights.workload * (workload === "LOW" ? 1 : workload === "MEDIUM" ? 0.6 : 0.2) + weights.congestion * (1 - cong) + weights.health * (r.health / 100);
        const reasons: string[] = [`${d.toFixed(0)}m from task`, `${r.battery.toFixed(0)}% battery`, `${workload.toLowerCase()} workload`];
        if (cong < 0.3) reasons.push("no route congestion");
        return { robot_id: r.id, score: Math.round(score * 1000) / 1000, distance_m: Math.round(d), battery: Math.round(r.battery), workload, congestion: Math.round(cong * 100) / 100, health: r.health, reasons, rejected_reason: null };
      }).sort((a, b) => b.score - a.score);
      const best = cands[0];
      for (const c of cands.slice(1)) c.rejected_reason = c.battery < 40 ? "battery too low" : c.distance_m > best.distance_m * 1.5 ? "farther from task" : c.workload === "HIGH" ? "high workload" : "lower score";
      const robot = S.robots[best.robot_id];
      idle.splice(idle.indexOf(robot), 1);
      task.status = "ASSIGNED"; task.assigned_robot = robot.id; task.assigned_tick = S.sim.tick;
      robot.current_task_id = task.id;
      this.setFsm(robot, "TASK_ASSIGNED");
      const decision: AiDecision = { id: `D${++this.decisionSeq}`, tick: S.sim.tick, kind: "TASK_ASSIGNMENT", task_id: task.id, selected_robot: robot.id, candidates: cands.slice(0, 5), weights, narrative: null };
      S.recent_decisions.unshift(decision); if (S.recent_decisions.length > 50) S.recent_decisions.pop();
      this.emit("TASK_ASSIGNED", "FLEET_MANAGER", "INFO", `Task #${task.id} assigned to ${robot.id} (${best.distance_m}m, ${best.battery}%)`, { task_id: task.id, robot_id: robot.id });
    }
  }

  private pruneTasks() {
    const S = this.state; const tick = S.sim.tick;
    for (const id in S.tasks) { const t = S.tasks[id]; if ((t.status === "COMPLETED" || t.status === "FAILED" || t.status === "TRANSFERRED" || t.status === "CANCELLED") && t.completed_tick !== null && tick - t.completed_tick > 3000) delete S.tasks[id]; }
  }

  // ─────────────────────────────────────────────────────────
  // 機器人 FSM
  // ─────────────────────────────────────────────────────────
  private setFsm(r: RobotState, fsm: RobotFsmState) {
    if (r.fsm === fsm) return;
    r.fsm = fsm; r.fsm_since_tick = this.state.sim.tick;
    r.status = this.statusOf(r);
  }
  private statusOf(r: RobotState): RobotStatus {
    if (r.fsm === "OFFLINE") return "OFFLINE";
    if (r.fsm === "ERROR") return "ERROR";
    if (r.fsm === "CHARGING") return "CHARGING";
    if (r.battery < THRESHOLDS.BATTERY_CRITICAL) return "ERROR";
    if (r.battery < THRESHOLDS.BATTERY_WARNING) return "WARNING";
    if (r.fsm === "IDLE") return "IDLE";
    return "ACTIVE";
  }

  private stepRobot(r: RobotState, rt: RobotRt) {
    const S = this.state; const tick = S.sim.tick;
    if (r.fsm === "OFFLINE") { r.velocity = 0; return; }
    this.batteryTick(r, rt);
    const task = r.current_task_id ? S.tasks[r.current_task_id] : undefined;

    switch (r.fsm) {
      case "IDLE": {
        r.velocity = 0; rt.idleTicks++;
        if (r.battery < THRESHOLDS.BATTERY_WARNING + 15 && this.freeCharger()) { this.goCharge(r, rt); break; }
        if (rt.idleTicks > SIM.IDLE_TO_PARK_TICKS && !rt.phase) { const p = this.parkSpot(r); if (p) { this.planTo(r, rt, p, "TO_PARK"); } }
        if (rt.phase === "TO_PARK") { this.moveAlongPath(r, rt); if (rt.target === null) rt.phase = null; }
        break;
      }
      case "TASK_ASSIGNED": {
        rt.idleTicks = 0;
        if (!task) { this.setFsm(r, "IDLE"); break; }
        const src = this.loc[task.source];
        this.planTo(r, rt, src.access_point, "TO_SOURCE", task.source);
        task.status = "IN_PROGRESS"; task.started_tick = tick;
        this.setFsm(r, "NAVIGATING");
        break;
      }
      case "NAVIGATING": {
        if (!task) { this.setFsm(r, "IDLE"); break; }
        this.moveAlongPath(r, rt);
        if (rt.target === null) { rt.dwell = SIM.PICK_TICKS; this.setFsm(r, "PICKING"); }
        break;
      }
      case "PICKING": {
        r.velocity = 0;
        if (--rt.dwell <= 0 && task) {
          r.load.current = Math.min(r.load.capacity, task.load_units);
          this.emit("TASK_STARTED", "ROBOT", "INFO", `${r.id} picked item at ${this.pretty(task.source)}`, { robot_id: r.id, task_id: task.id });
          this.planTo(r, rt, this.loc[task.destination].access_point, "TO_DEST", task.destination);
          this.setFsm(r, "TRANSPORTING");
        }
        break;
      }
      case "TRANSPORTING": {
        if (!task) { this.setFsm(r, "IDLE"); break; }
        // 低電量：估計剩餘距離是否足夠，否則轉移任務
        if (r.battery < THRESHOLDS.BATTERY_WARNING && rt.lastBatteryAlert !== "CRIT") {
          const remain = this.remainingPathLength(r);
          const need = remain * (SIM.BATTERY_MOVE + SIM.BATTERY_LOAD) / (SIM.MAX_SPEED * SIM.TICK_S) + 3;
          if (need > r.battery - THRESHOLDS.BATTERY_CRITICAL) { this.setFsm(r, "LOW_BATTERY"); break; }
        }
        this.moveAlongPath(r, rt);
        if (rt.target === null) { rt.dwell = SIM.DROP_TICKS * this.stationSlowdown(task.destination); this.setFsm(r, "DELIVERING"); }
        break;
      }
      case "DELIVERING": {
        r.velocity = 0;
        if (--rt.dwell <= 0) { this.completeTask(r, rt); }
        break;
      }
      case "COMPLETED": {
        this.setFsm(r, "IDLE"); rt.idleTicks = 0;
        break;
      }
      case "LOW_BATTERY": {
        r.velocity = 0;
        this.setFsm(r, "TASK_TRANSFER");
        break;
      }
      case "TASK_TRANSFER": {
        if (task) {
          task.status = "TRANSFERRED"; task.completed_tick = tick;
          const nt = this.createTask({ type: task.type, priority: task.priority === "NORMAL" ? "HIGH" : task.priority, source: task.source, destination: task.destination, load_units: task.load_units });
          nt.parent_task_id = task.id;
          this.emit("TASK_TRANSFERRED", "FLEET_MANAGER", "MEDIUM", `${r.id} low battery — task #${task.id} re-queued as #${nt.id}`, { robot_id: r.id, task_id: nt.id });
          r.load.current = 0; r.current_task_id = null;
        }
        this.goCharge(r, rt);
        break;
      }
      case "GOING_TO_CHARGE": {
        this.moveAlongPath(r, rt);
        if (rt.target === null) { this.setFsm(r, "CHARGING"); this.emit("ROBOT_STATE_CHANGED", "ROBOT", "INFO", `${r.id} charging started (${r.battery.toFixed(0)}%)`, { robot_id: r.id }); }
        break;
      }
      case "CHARGING": {
        r.velocity = 0;
        r.battery = Math.min(100, r.battery + SIM.CHARGE_RATE);
        if (r.battery >= THRESHOLDS.BATTERY_CHARGE_TO) {
          if (rt.chargerId) this.chargerBusy[rt.chargerId] = null; rt.chargerId = null;
          rt.lastBatteryAlert = "NONE"; this.resolveAlert(`bat-${r.id}`);
          this.setFsm(r, "IDLE"); rt.idleTicks = 0;
          this.emit("ROBOT_STATE_CHANGED", "ROBOT", "INFO", `${r.id} charging complete`, { robot_id: r.id });
        }
        break;
      }
      case "OBSTACLE_DETECTED": { this.setFsm(r, "REPLANNING"); break; }
      case "REPLANNING": {
        // 以目前被佔用的格為臨時障礙重新規劃
        if (rt.target) {
          const blocked = this.blockedCells(r.id);
          const p = astar(this.grid, toCell(r.position[0], r.position[2]), rt.target, { blocked, costMap: this.congestionCost() });
          if (p) { r.path = p; r.path_index = 0; rt.waitTicks = 0; this.emit("ROUTE_REPLANNED", "PLANNER", "LOW", `${r.id} rerouted (${p.length} cells)`, { robot_id: r.id, task_id: r.current_task_id ?? undefined }); }
        }
        this.setFsm(r, rt.phase === "TO_DEST" ? "TRANSPORTING" : rt.phase === "TO_CHARGER" ? "GOING_TO_CHARGE" : rt.phase === "TO_PARK" ? "IDLE" : "NAVIGATING");
        break;
      }
      case "ERROR": { r.velocity = 0; break; }
    }
    r.status = this.statusOf(r);
    if (r.fsm !== "IDLE" && r.fsm !== "CHARGING") r.stats.busy_ticks++;
    r.zone = this.zoneAt(r.position[0], r.position[2]);
  }

  private completeTask(r: RobotState, rt: RobotRt) {
    const S = this.state; const task = r.current_task_id ? S.tasks[r.current_task_id] : undefined;
    if (task) {
      task.status = "COMPLETED"; task.completed_tick = S.sim.tick;
      const dur = S.sim.tick - (task.created_tick);
      this.taskTimes.push(dur); if (this.taskTimes.length > 200) this.taskTimes.shift();
      this.completedCount++; if (task.deadline_tick === null || S.sim.tick <= task.deadline_tick) this.onTime++;
      r.stats.tasks_completed++;
      this.emit("TASK_COMPLETED", "ROBOT", "INFO", `${r.id} completed task #${task.id} at ${this.pretty(task.destination)}`, { robot_id: r.id, task_id: task.id });
    }
    r.load.current = 0; r.current_task_id = null; r.destination = null; rt.phase = null; rt.goalLoc = null;
    this.setFsm(r, "COMPLETED");
  }

  // ─────────────────────────────────────────────────────────
  // 路徑與移動
  // ─────────────────────────────────────────────────────────
  private planTo(r: RobotState, rt: RobotRt, point: [number, number], phase: RobotRt["phase"], locId: string | null = null) {
    const start = toCell(r.position[0], r.position[2]);
    const goal = nearestWalkable(this.grid, point[0], point[1]);
    const path = astar(this.grid, start, goal, { blocked: this.blockedCells(r.id), costMap: this.congestionCost() }) ?? astar(this.grid, start, goal) ?? [];
    r.path = path; r.path_index = 0; rt.target = goal; rt.phase = phase; rt.goalLoc = locId; rt.waitTicks = 0; rt.backingOff = false; rt.resumePoint = null;
    r.destination = locId;
    if (path.length === 0 && (start[0] !== goal[0] || start[1] !== goal[1])) { rt.target = null; }
    this.updateEta(r);
  }

  private moveAlongPath(r: RobotState, rt: RobotRt) {
    if (rt.target === null) return;
    if (r.path_index >= r.path.length) { rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; return; }
    const next = r.path[r.path_index];
    const [tx, tz] = cellCenter(next);
    const dx = tx - r.position[0], dz = tz - r.position[2];
    const dist = Math.hypot(dx, dz);
    // 佔用檢查：下一格若被其他機器人佔用就等待
    let occ = this.occupancy.get(cellKey(next[0], next[1]));
    const myCell = toCell(r.position[0], r.position[2]);
    const entering = !(myCell[0] === next[0] && myCell[1] === next[1]);
    // 斜向移動時，兩個正交鄰格也不能有別台機器人（否則會在角落擦撞）
    if (entering && !occ && next[0] !== myCell[0] && next[1] !== myCell[1]) {
      const a = this.occupancy.get(cellKey(next[0], myCell[1])), b = this.occupancy.get(cellKey(myCell[0], next[1]));
      if (a && a !== r.id) occ = a; else if (b && b !== r.id) occ = b;
    }
    if (entering && occ && occ !== r.id) {
      const remaining0 = r.path.length - r.path_index;
      // 工作站前排隊：距目標 ≤ N 格就視為到達、就地作業（避免 10 台排同一格造成死鎖）
      if (!rt.backingOff && remaining0 <= SIM.STATION_ARRIVE_CELLS && (rt.phase === "TO_SOURCE" || rt.phase === "TO_DEST")) {
        rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; r.eta_s = 0; rt.waitTicks = 0; return;
      }
      r.velocity = Math.max(0, r.velocity - SIM.ACCEL * SIM.TICK_S * 2);
      rt.waitTicks++; r.stats.wait_ticks++;
      const other = this.state.robots[occ];
      const mutual = !!other && other.path_index < other.path.length && other.path[other.path_index][0] === myCell[0] && other.path[other.path_index][1] === myCell[1];
      if (mutual && rt.waitTicks > 10 && this.yieldsTo(r, other)) { this.backOff(r, rt); return; }
      if (rt.waitTicks === SIM.WAIT_REPLAN_TICKS) { this.emit("OBSTACLE_DETECTED", "ROBOT", "LOW", `${r.id} blocked by ${occ} — replanning`, { robot_id: r.id }); this.setFsm(r, "OBSTACLE_DETECTED"); }
      else if (rt.waitTicks >= SIM.WAIT_BACKOFF_TICKS) { this.backOff(r, rt); }
      return;
    }
    rt.waitTicks = 0;
    // 立刻預約下一格，同一 tick 內其他機器人就不會也選它
    if (entering) {
      this.occupancy.set(cellKey(next[0], next[1]), r.id);
      // 斜向：把兩個正交鄰格也預約起來，別台就不會在這一 tick 切進角落
      if (next[0] !== myCell[0] && next[1] !== myCell[1]) { const k1 = cellKey(next[0], myCell[1]), k2 = cellKey(myCell[0], next[1]); if (!this.occupancy.has(k1)) this.occupancy.set(k1, r.id); if (!this.occupancy.has(k2)) this.occupancy.set(k2, r.id); }
    }
    // 速度：加速到上限，轉彎與接近終點時減速
    const desiredHeading = Math.atan2(dz, dx);
    let dh = desiredHeading - r.heading; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    const turning = Math.abs(dh) > 0.3;
    const remaining = r.path.length - r.path_index;
    const vmax = r.max_speed * (turning ? SIM.TURN_SLOW : 1) * (remaining <= 1 ? 0.5 : 1) * (this.grid.cells[next[1] * this.grid.cols + next[0]] === 2 ? 0.6 : 1) * (this.congestedZones.size ? this.zoneSpeedFactor(next) : 1);
    r.velocity = Math.min(vmax, r.velocity + SIM.ACCEL * SIM.TICK_S);
    r.heading += Math.sign(dh) * Math.min(Math.abs(dh), 4.0 * SIM.TICK_S);
    const stepLen = Math.min(dist, r.velocity * SIM.TICK_S);
    if (dist > 1e-6) { r.position[0] += (dx / dist) * stepLen; r.position[2] += (dz / dist) * stepLen; }
    r.stats.distance_m += stepLen;
    // 交通熱圖
    const ci = myCell[1] * this.grid.cols + myCell[0]; if (ci >= 0 && ci < this.traffic.length) { this.traffic[ci] += 1; this.trafficShort[ci] += 1; }
    if (dist - stepLen < 0.08) {
      r.path_index++;
      this.occupancy.set(cellKey(next[0], next[1]), r.id);
      if (r.path_index >= r.path.length) {
        rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; r.eta_s = 0;
        if (rt.backingOff && rt.resumePoint) { const rp = rt.resumePoint; rt.backingOff = false; rt.resumePoint = null; this.planTo(r, rt, rp, rt.phase, rt.goalLoc); }
      }
    }
    if (this.state.sim.tick % 10 === 0) this.updateEta(r);
  }

  /** 誰讓路：空車讓載貨車；都一樣時編號大的讓 */
  private yieldsTo(me: RobotState, other: RobotState): boolean {
    if ((me.load.current > 0) !== (other.load.current > 0)) return me.load.current === 0;
    return me.id > other.id;
  }
  /** 讓路：走到附近一個沒人要經過的空格，之後回到原目標重新規劃 */
  private backOff(r: RobotState, rt: RobotRt) {
    if (rt.backingOff || !rt.target) { rt.waitTicks = 0; return; }
    const my = toCell(r.position[0], r.position[2]);
    const claimed = new Set<string>();
    for (const id in this.state.robots) { const o = this.state.robots[id]; if (o.id === r.id) continue; const c = toCell(o.position[0], o.position[2]); claimed.add(cellKey(c[0], c[1])); for (let i = o.path_index; i < Math.min(o.path.length, o.path_index + 4); i++) claimed.add(cellKey(o.path[i][0], o.path[i][1])); }
    let best: GridCell | null = null, bestD = Infinity;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      if (!dr && !dc) continue;
      const c: GridCell = [my[0] + dc, my[1] + dr];
      if (!isWalkable(this.grid, c[0], c[1]) || claimed.has(cellKey(c[0], c[1]))) continue;
      const d = Math.abs(dr) + Math.abs(dc); if (d < bestD) { bestD = d; best = c; }
    }
    rt.waitTicks = 0;
    if (!best) return;
    const p = astar(this.grid, my, best, { blocked: claimed });
    if (!p || !p.length) return;
    const [gx, gz] = cellCenter(rt.target);
    rt.resumePoint = [gx, gz]; rt.backingOff = true; rt.target = best;
    r.path = p; r.path_index = 0;
    this.emit("ROBOT_COLLISION_AVOIDED", "PLANNER", "LOW", `${r.id} yields (back-off ${p.length} cells)`, { robot_id: r.id });
  }

  private remainingPathLength(r: RobotState): number {
    let len = 0; let [px, pz] = [r.position[0], r.position[2]];
    for (let i = r.path_index; i < r.path.length; i++) { const [cx, cz] = cellCenter(r.path[i]); len += Math.hypot(cx - px, cz - pz); px = cx; pz = cz; }
    return len;
  }
  private updateEta(r: RobotState) { r.eta_s = r.path.length ? Math.round(this.remainingPathLength(r) / (r.max_speed * 0.8)) : null; }

  private rebuildOccupancy() {
    this.occupancy.clear();
    for (const id in this.state.robots) {
      const r = this.state.robots[id];
      const c = toCell(r.position[0], r.position[2]); this.occupancy.set(cellKey(c[0], c[1]), id);
      // 也預約下一格，避免兩台同時進入；斜向移動時連兩個正交鄰格一起預約（防止 X 形交叉擦撞）
      if (r.path_index < r.path.length) {
        const n = r.path[r.path_index]; if (!this.occupancy.has(cellKey(n[0], n[1]))) this.occupancy.set(cellKey(n[0], n[1]), id);
        if (n[0] !== c[0] && n[1] !== c[1]) { for (const k of [cellKey(n[0], c[1]), cellKey(c[0], n[1])]) if (!this.occupancy.has(k)) this.occupancy.set(k, id); }
      }
    }
  }
  private blockedCells(selfId: string): Set<string> {
    const s = new Set<string>();
    for (const [k, id] of this.occupancy) if (id !== selfId) s.add(k);
    for (const zid of this.blockedZones) { const z = this.layout.zones.find((zz) => zz.id === zid); if (!z) continue; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); for (let c = Math.floor(Math.min(...xs)); c < Math.max(...xs); c++) for (let r = Math.floor(Math.min(...zs)); r < Math.max(...zs); r++) s.add(cellKey(c, r)); }
    return s;
  }
  private congestionCost(): Float32Array | undefined {
    // 用交通熱圖當作額外成本，讓機器人自然分散到不同走道；注入的交通擁塞 zone 再加一層高成本
    const out = new Float32Array(this.traffic.length);
    let max = 0; for (let i = 0; i < this.traffic.length; i++) if (this.traffic[i] > max) max = this.traffic[i];
    if (max < 1 && this.congestedZones.size === 0) return undefined;
    if (max >= 1) for (let i = 0; i < out.length; i++) out[i] = (this.traffic[i] / max) * 0.8;
    for (const [zid, cz] of this.congestedZones) { const z = this.layout.zones.find((zz) => zz.id === zid); if (!z) continue; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); for (let c = Math.floor(Math.min(...xs)); c < Math.max(...xs); c++) for (let r = Math.floor(Math.min(...zs)); r < Math.max(...zs); r++) out[r * this.grid.cols + c] += 3 * cz.level; }
    return out;
  }
  /** 注入的交通擁塞：zone 內速度上限比例 */
  private zoneSpeedFactor(cell: GridCell): number {
    for (const [zid, cz] of this.congestedZones) { const z = this.layout.zones.find((zz) => zz.id === zid); if (!z) continue; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); if (cell[0] >= Math.min(...xs) && cell[0] < Math.max(...xs) && cell[1] >= Math.min(...zs) && cell[1] < Math.max(...zs)) return 1 - 0.7 * cz.level; }
    return 1;
  }
  private decayTraffic() { if (this.state.sim.tick % 5 === 0) for (let i = 0; i < this.traffic.length; i++) { this.traffic[i] *= 0.9985; this.trafficShort[i] *= 0.975; } }

  // ─────────────────────────────────────────────────────────
  // 電池與充電
  // ─────────────────────────────────────────────────────────
  private batteryTick(r: RobotState, rt: RobotRt) {
    if (r.fsm === "CHARGING") return;
    const moving = r.velocity > 0.05;
    const drain = moving ? SIM.BATTERY_MOVE * (r.velocity / r.max_speed) + (r.load.current > 0 ? SIM.BATTERY_LOAD : 0) : SIM.BATTERY_IDLE;
    r.battery = Math.max(0, r.battery - drain);
    r.stats.energy_wh += drain * 0.5; // 假設 50 Wh 電池
    if (r.battery < THRESHOLDS.BATTERY_CRITICAL && rt.lastBatteryAlert !== "CRIT") {
      rt.lastBatteryAlert = "CRIT";
      this.emit("ROBOT_BATTERY_CRITICAL", "ROBOT", "CRITICAL", `${r.id} Battery Critical (${r.battery.toFixed(0)}%)`, { robot_id: r.id, zone_id: r.zone ?? undefined });
      this.raiseAlert(`bat-${r.id}`, "CRITICAL", `${r.id}  Battery Critical`, `${r.battery.toFixed(0)}% remaining`, { robot_id: r.id, zone_id: r.zone ?? undefined });
    } else if (r.battery < THRESHOLDS.BATTERY_WARNING && rt.lastBatteryAlert === "NONE") {
      rt.lastBatteryAlert = "WARN";
      this.emit("ROBOT_BATTERY_LOW", "ROBOT", "HIGH", `${r.id} Battery Low (${r.battery.toFixed(0)}%)`, { robot_id: r.id, zone_id: r.zone ?? undefined });
      this.raiseAlert(`bat-${r.id}`, "HIGH", `${r.id}  Battery Low`, `${r.battery.toFixed(0)}% remaining`, { robot_id: r.id, zone_id: r.zone ?? undefined });
    }
    if (r.battery <= 0 && r.fsm !== "ERROR") { this.setFsm(r, "ERROR"); this.emit("ROBOT_OFFLINE", "ROBOT", "CRITICAL", `${r.id} battery depleted — stopped`, { robot_id: r.id }); }
  }
  /** 供應該工作站的輸送帶故障時，卸貨要等人工處理：停留時間 ×4（這就是 Demo 04 的瓶頸來源） */
  private stationSlowdown(locId: string): number {
    const cv = this.layout.conveyors.find((c) => c.feeds === locId);
    if (!cv) return 1;
    const st = this.state.conveyors[cv.id]?.status;
    return st === "ERROR" || st === "STOPPED" ? 4 : st === "WARNING" || st === "MAINTENANCE" ? 2 : 1;
  }
  /** 每 10 tick：感測器讀值、輸送帶吞吐（裝飾性但由真實狀態推導） */
  private updateDevices() {
    const S = this.state; const robots = Object.values(S.robots);
    for (const id in S.sensors) {
      const s = S.sensors[id]; const ls = this.layout.sensors.find((x) => x.id === id); if (!ls || s.status === "OFFLINE") continue;
      const near = robots.filter((r) => Math.hypot(r.position[0] - ls.position[0], r.position[2] - ls.position[2]) < 10).length;
      if (s.kind === "PRESENCE") { s.value = near > 0 ? 1 : 0; s.unit = "bool"; }
      else if (s.kind === "LIDAR") { s.value = near; s.unit = "objects"; }
      else if (s.kind === "TEMP") { s.value = Math.round((21 + Math.sin(S.sim.tick / 3000) * 1.5) * 10) / 10; s.unit = "°C"; }
      else if (s.kind === "WEIGHT") { const cv = Object.values(S.conveyors).find((c) => c.id === "CV03"); s.value = cv ? cv.items_on_belt * 12 : 0; s.unit = "kg"; }
    }
    for (const id in S.conveyors) {
      const c = S.conveyors[id]; const lc = this.layout.conveyors.find((x) => x.id === id);
      if (c.status === "RUNNING") { const deliveries = robots.filter((r) => r.fsm === "DELIVERING" && lc && r.destination === lc.feeds).length; c.items_on_belt = Math.max(0, Math.min(12, c.items_on_belt + deliveries - (S.sim.tick % 30 === 0 ? 1 : 0))); c.throughput_per_min = Math.round((2 + c.items_on_belt * 0.3) * 10) / 10; }
      else { c.throughput_per_min = 0; }
    }
  }
  private freeCharger(): string | null { for (const id in this.chargerBusy) if (!this.chargerBusy[id]) return id; return null; }
  private goCharge(r: RobotState, rt: RobotRt) {
    const id = this.freeCharger();
    if (!id) { this.setFsm(r, "IDLE"); return; }
    const c = this.layout.charging_stations.find((cc) => cc.id === id)!;
    this.chargerBusy[id] = r.id; rt.chargerId = id;
    this.planTo(r, rt, c.access_point, "TO_CHARGER", id);
    this.setFsm(r, "GOING_TO_CHARGE");
  }
  private parkSpot(r: RobotState): [number, number] | null {
    const p = this.layout.parking[0]; if (!p) return null;
    const i = parseInt(r.id.replace(/\D/g, ""), 10) - 1;
    const x = Math.floor(p.rect[0] + 1 + (i % 10) * 2) + 0.5, z = Math.floor(p.rect[1] + 1 + Math.floor(i / 10) * 2.2) + 0.5;
    if (Math.hypot(r.position[0] - x, r.position[2] - z) < 1.5) return null;
    return [x, z];
  }

  // ─────────────────────────────────────────────────────────
  // Zone / KPI / 事件
  // ─────────────────────────────────────────────────────────
  private zoneAt(x: number, z: number): string | null {
    for (const zn of this.layout.zones) { const xs = zn.polygon.map((p) => p[0]), zs = zn.polygon.map((p) => p[1]); if (x >= Math.min(...xs) && x <= Math.max(...xs) && z >= Math.min(...zs) && z <= Math.max(...zs)) return zn.id; }
    return null;
  }
  private updateZones() {
    const S = this.state;
    const counts: Record<string, number> = {};
    for (const id in S.robots) { const z = S.robots[id].zone; if (z) counts[z] = (counts[z] ?? 0) + 1; }
    for (const zid in S.zones) {
      const z = S.zones[zid]; z.robot_count = counts[zid] ?? 0;
      z.congestion = Math.min(1, z.robot_count / SIM.ZONE_CAPACITY);
      if (this.blockedZones.has(zid)) { z.status = "BLOCKED"; continue; }
      const inj = this.congestedZones.get(zid); if (inj) z.congestion = Math.max(z.congestion, inj.level);
      const was = z.status;
      z.status = z.congestion >= THRESHOLDS.CONGESTION_WARNING ? "CONGESTED" : "NORMAL";
      if (z.status === "CONGESTED" && was !== "CONGESTED") this.emit("ZONE_CONGESTION_HIGH", "SIMULATION", "MEDIUM", `Zone ${zid} congestion high (${z.robot_count} robots)`, { zone_id: zid });
    }
  }
  private updateKpi() {
    const S = this.state; const K = S.kpi; const robots = Object.values(S.robots); const tasks = Object.values(S.tasks);
    K.tick = S.sim.tick;
    K.fleet = { total: robots.length, active: 0, charging: 0, idle: 0, warning: 0, error: 0, offline: 0 };
    for (const r of robots) K.fleet[r.status.toLowerCase() as keyof typeof K.fleet]++;
    const win = 3000; // 5 min
    const recent = tasks.filter((t) => t.status === "COMPLETED" && t.completed_tick !== null && S.sim.tick - t.completed_tick < win).length;
    K.operation = {
      throughput_per_min: Math.round((recent / Math.min(5, Math.max(1, S.sim.tick / 600))) * 10) / 10,
      completed_today: this.completedCount, completed_target: 150,
      pending: tasks.filter((t) => t.status === "WAITING").length,
      ongoing: tasks.filter((t) => t.status === "ASSIGNED" || t.status === "IN_PROGRESS").length,
      avg_task_time_s: this.taskTimes.length ? Math.round((this.taskTimes.reduce((a, b) => a + b, 0) / this.taskTimes.length) * SIM.TICK_S) : 0,
      on_time_rate: this.completedCount ? this.onTime / this.completedCount : 1,
      avg_utilization: S.sim.tick ? robots.reduce((a, r) => a + r.stats.busy_ticks, 0) / (robots.length * S.sim.tick) : 0,
    };
    const cong = Object.values(S.zones).reduce((a, z) => a + z.congestion, 0) / Math.max(1, Object.keys(S.zones).length);
    K.efficiency = {
      avg_travel_distance_m: Math.round(robots.reduce((a, r) => a + r.stats.distance_m, 0) / Math.max(1, this.completedCount)),
      avg_wait_time_s: Math.round((robots.reduce((a, r) => a + r.stats.wait_ticks, 0) / robots.length) * SIM.TICK_S),
      congestion_index: Math.round(cong * 100) / 100,
      energy_kwh: Math.round(robots.reduce((a, r) => a + r.stats.energy_wh, 0)) / 1000,
    };
    S.subsystems.CHARGING = Object.values(this.chargerBusy).every(Boolean) ? "WARNING" : "NORMAL";
    S.subsystems.CONVEYORS = Object.values(S.conveyors).some((c) => c.status === "ERROR") ? "ERROR" : Object.values(S.conveyors).some((c) => c.status !== "RUNNING") ? "WARNING" : "NORMAL";
    S.subsystems.WAREHOUSE = this.blockedZones.size ? "WARNING" : "NORMAL";
  }
  private pushSeries() {
    const S = this.state; this.lastSeriesTick = S.sim.tick;
    const minutes = S.sim.tick / 600;
    S.kpi.throughput_series.push({ tick: S.sim.tick, completed: this.completedCount, target: Math.round(minutes * 1.25) });
    if (S.kpi.throughput_series.length > THRESHOLDS.THROUGHPUT_SERIES_SIZE) S.kpi.throughput_series.shift();
  }

  private emit(type: EventType, source: TwinEvent["source"], severity: Severity, message: string, rel: Partial<Pick<TwinEvent, "robot_id" | "task_id" | "zone_id" | "conveyor_id" | "camera_id">> = {}) {
    const ev: TwinEvent = { id: `E${++this.eventSeq}`, tick: this.state.sim.tick, type, source, severity, message, ...rel };
    this.state.recent_events.unshift(ev);
    if (this.state.recent_events.length > SIM.EVENT_RING) this.state.recent_events.pop();
    return ev;
  }
  private raiseAlert(id: string, severity: Severity, title: string, detail: string, rel: Partial<Pick<AlertState, "robot_id" | "zone_id" | "conveyor_id">> = {}) {
    const ev = this.state.recent_events[0];
    this.state.alerts[id] = { id, created_tick: this.state.sim.tick, severity, title, detail, source_event_id: ev?.id ?? "", acknowledged: false, resolved_tick: null, ...rel };
  }
  private resolveAlert(id: string) { delete this.state.alerts[id]; }
  ackAlert(id: string) { const a = this.state.alerts[id]; if (a) a.acknowledged = true; }

  // ─────────────────────────────────────────────────────────
  // 情境注入（Phase 4 正式使用；此處先實作核心幾種）
  // ─────────────────────────────────────────────────────────
  private applyInjections() {
    const S = this.state;
    const now = S.sim.tick;
    const keep: ScenarioInjection[] = [];
    for (const inj of this.pendingInjections) {
      if (inj.at_tick !== undefined && inj.at_tick > now) { keep.push(inj); continue; }
      switch (inj.kind) {
        case "ROBOT_FAILURE": { const r = S.robots[inj.robot_id]; if (r) { this.setFsm(r, "OFFLINE"); r.velocity = 0; const t = r.current_task_id ? S.tasks[r.current_task_id] : null; if (t) { t.status = "TRANSFERRED"; t.completed_tick = now; const nt = this.createTask({ type: t.type, priority: "HIGH", source: t.source, destination: t.destination }); nt.parent_task_id = t.id; } r.current_task_id = null; r.path = []; this.emit("ROBOT_OFFLINE", "USER", "CRITICAL", `${r.id} failure injected — OFFLINE`, { robot_id: r.id }); this.raiseAlert(`off-${r.id}`, "CRITICAL", `${r.id}  Offline`, "Robot failure", { robot_id: r.id }); } break; }
        case "ROBOT_BATTERY_SET": { const r = S.robots[inj.robot_id]; if (r) { r.battery = inj.battery; this.rt[r.id].lastBatteryAlert = "NONE"; } break; }
        case "CONVEYOR_FAILURE": { const c = S.conveyors[inj.conveyor_id]; if (c) { c.status = "ERROR"; c.speed_mps = 0; this.emit("CONVEYOR_STATUS_CHANGED", "CONVEYOR", "HIGH", `${inj.conveyor_id} failure — STOPPED`, { conveyor_id: c.id }); this.raiseAlert(`cv-${c.id}`, "HIGH", `Conveyor ${c.id}  Error`, "Throughput impact: HIGH", { conveyor_id: c.id }); } break; }
        case "CAMERA_OFFLINE": { const c = S.cameras[inj.camera_id]; if (c) { c.status = "OFFLINE"; S.subsystems.CCTV = "WARNING"; this.emit("CAMERA_STATUS_CHANGED", "CAMERA", "MEDIUM", `${c.id} offline`, { camera_id: c.id }); } break; }
        case "HUMAN_INTRUSION": {
          const z = this.layout.zones.find((zz) => zz.id === inj.zone_id); if (!z) break;
          const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
          const pid = `H-${inj.zone_id}-${now}`;
          S.people[pid] = { id: pid, kind: "WORKER", position: [(Math.min(...xs) + Math.max(...xs)) / 2, 0, Math.min(...zs) + 6.3], heading: 0, zone: inj.zone_id, expires_tick: now + inj.duration_ticks };
          this.blockedZones.add(inj.zone_id); S.zones[inj.zone_id].blocked_reason = "Human detected"; S.zones[inj.zone_id].blocked_since_tick = now;
          this.emit("HUMAN_DETECTED", "VLM", "HIGH", `Human detected — Zone ${inj.zone_id}`, { zone_id: inj.zone_id });
          this.emit("ZONE_BLOCKED", "SIMULATION", "HIGH", `Zone ${inj.zone_id} marked BLOCKED`, { zone_id: inj.zone_id });
          this.raiseAlert(`zone-${inj.zone_id}`, "HIGH", `Zone ${inj.zone_id}  Human Detected`, "Route blocked", { zone_id: inj.zone_id });
          for (const id in S.robots) { const r = S.robots[id]; if (r.path.length && r.path.slice(r.path_index).some(([c, rr]) => c >= Math.min(...xs) && c < Math.max(...xs) && rr >= Math.min(...zs) && rr < Math.max(...zs))) this.setFsm(r, "OBSTACLE_DETECTED"); }
          break;
        }
        case "TRAFFIC_CONGESTION": {
          this.congestedZones.set(inj.zone_id, { level: inj.level, until: now + inj.duration_ticks });
          this.emit("ZONE_CONGESTION_HIGH", "USER", "MEDIUM", `Traffic congestion injected — Zone ${inj.zone_id} (level ${Math.round(inj.level * 100)}%)`, { zone_id: inj.zone_id });
          this.raiseAlert(`traffic-${inj.zone_id}`, "MEDIUM", `Zone ${inj.zone_id}  Traffic Delay`, `Speed limited to ${Math.round((1 - 0.7 * inj.level) * 100)}%`, { zone_id: inj.zone_id });
          for (const id in S.robots) { const r = S.robots[id]; if (r.path.length > r.path_index + 3 && r.fsm !== "IDLE") this.setFsm(r, "OBSTACLE_DETECTED"); }
          break;
        }
        case "TASK_BURST": { for (let i = 0; i < inj.count; i++) { this.nextTaskTick = now; this.generateTasks(); } break; }
      }
    }
    this.pendingInjections = keep;
    for (const [zid, cz] of this.congestedZones) if (now >= cz.until) { this.congestedZones.delete(zid); this.resolveAlert(`traffic-${zid}`); this.emit("ZONE_UNBLOCKED", "SIMULATION", "INFO", `Zone ${zid} traffic back to normal`, { zone_id: zid }); }
    // 人員到期離開
    for (const pid in S.people) { const p = S.people[pid]; if (p.expires_tick !== null && now >= p.expires_tick) { delete S.people[pid]; if (p.zone && !Object.values(S.people).some((q) => q.zone === p.zone)) { this.blockedZones.delete(p.zone); S.zones[p.zone].blocked_reason = null; S.zones[p.zone].blocked_since_tick = null; this.resolveAlert(`zone-${p.zone}`); this.emit("HUMAN_CLEARED", "VLM", "INFO", `Zone ${p.zone} clear`, { zone_id: p.zone }); this.emit("ZONE_UNBLOCKED", "SIMULATION", "INFO", `Zone ${p.zone} unblocked`, { zone_id: p.zone }); } } }
  }

  private pretty(locId: string): string {
    const l = this.loc[locId]; if (!l) return locId;
    if (l.kind === "SHELF") return `Shelf ${locId.replace("SHELF-", "")}`;
    if (l.kind === "PACKING") return locId.replace("PACK-", "Packing ");
    if (l.kind === "SORTING") return "Sorting";
    if (l.kind === "CHARGING") return locId.replace("CHG-", "Charger ");
    return locId.replace("-", " ");
  }
}
