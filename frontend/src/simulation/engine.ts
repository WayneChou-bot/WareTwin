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
  TwinState, PerceivedObstacle, RobotState, TaskState, TwinEvent, AlertState, AiDecision, DecisionCandidate,
  GridCell, RobotFsmState, RobotStatus, EventType, Severity, TaskPriority, ScenarioInjection,
} from "../schema/twin_state";
import { THRESHOLDS } from "../schema/twin_state";
import { astar, cellKey, cellCenter, isWalkable, nearestWalkable, toCell, type NavGrid } from "./astar";
import { taskError } from "./rules";

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
  STATION_ARRIVE_CELLS: 2,   // 距工作站 ≤2 格且前方被佔、又沒有空的服務格 → 就地作業
  SERVICE_RADIUS: 1,         // 工作站/貨架 access point 周圍 (Chebyshev) 1 格內的可走格 = 服務格，一台一格
  MIN_SEP: 0.9,              // 任兩台中心距硬下限 (m)：一步會更靠近且低於此值就不走（物理防撞）
  // Phase 7：虛擬 LiDAR 與局部避障
  LIDAR_RANGE: 4.0,          // m
  LIDAR_FOV: Math.PI * 1.5,  // 270°
  PERC_STOP: 1.7,            // 前方動態障礙中心距 < 1.7 m → 停車（車身 1.3 m，留 0.4 m）
  PERC_SLOW: 2.8,            // < 2.8 m → 減速
  PERC_LOOKAHEAD: 3,         // 只對「位於我接下來 3 格路徑上」的動態障礙反應（不在路徑上的交會車不停）
  PERC_EVENT_TICKS: 200,     // 同一台機器人的感知事件節流
  // 電梯（規格書 §9.1；秒 × 10 = tick）
  LIFT_DOOR_TICKS: 12,       // 開/關門 1.2 s
  LIFT_TRAVEL_TICKS: 60,     // 垂直移動 6.0 s（smoothstep 緩動）
  LIFT_LEVEL_TICKS: 5,       // Leveling 0.5 s
  LIFT_COOLDOWN_TICKS: 20,   // 送完一趟的冷卻 2.0 s
  LIFT_BOARD_SPEED: 0.6,     // 進出轎廂的低速 (m/s)
  LIFT_QUEUE_SPEED: 0.9,     // 排隊遞補移動速度 (m/s)
  LIFT_RETRY_TICKS: 50,      // 電梯全故障時的重試間隔
  LIFT_XFLOOR_PENALTY_M: 40, // 跨樓層任務指派時的等效距離懲罰 (m)
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
  /** 感知：正前方最近動態障礙 (robot / person id) 與其中心距 */
  frontId: string | null;
  frontDist: number;
  lastPercEvent: number;
  /** 跨樓層：抵達電梯後要繼續前往的目標 */
  pending: { point: [number, number]; phase: RobotRt["phase"]; locId: string | null; floor: number } | null;
  liftId: string | null;
  /** 派工當下稽核記錄的電梯（round-6 P2）：planTo 跨樓層時優先使用，確保 Decision reasons 與實際路線一致 */
  plannedLiftId: string | null;
  /** 電梯子狀態機（規格書 §10）：null → TO_LIFT → QUEUED → BOARDING → RIDING → ALIGHTING → null */
  liftStage: null | "TO_LIFT" | "QUEUED" | "BOARDING" | "RIDING" | "ALIGHTING";
  liftEnqueuedTick: number;
  liftRetryTick: number;
  /** ALIGHTING 的固定出口點（一次選定；被擋太久才換），避免每 tick 換目標造成震盪 */
  liftExit: [number, number] | null;
  liftBlockedTicks: number;
}

export interface EngineOptions { seed?: number; initialState?: TwinState }

export class SimEngine {
  readonly layout: WarehouseLayout;
  /** 一樓網格（heatmap / 交通成本沿用）；各樓層網格見 grids */
  readonly grid: NavGrid;
  readonly grids: Record<number, NavGrid>;
  state: TwinState;
  /** 長期交通累計（每樓一份；衰減極慢）：HEATMAP 用、也當 A* 的擁塞成本 */
  traffic: Record<number, Float32Array>;
  /** 短期交通（每樓一份；衰減快，約 20 s 記憶）：TRAFFIC VIEW 用 */
  trafficShort: Record<number, Float32Array>;
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
    this.grid = buildNavGrid(layout, 1);
    this.grids = { 1: this.grid };
    for (const f of layout.floors ?? []) if (f.id !== 1) this.grids[f.id] = buildNavGrid(layout, f.id);
    const n = this.grid.cols * this.grid.rows;
    this.traffic = {}; this.trafficShort = {};
    for (const f of layout.floors ?? [{ id: 1 }]) { this.traffic[f.id] = new Float32Array(n); this.trafficShort[f.id] = new Float32Array(n); }
    this.loc = Object.fromEntries(layout.locations.map((l) => [l.id, l]));
    const seed = opts.seed ?? 42;
    this.rng = mulberry32(seed);
    for (const c of layout.charging_stations) this.chargerBusy[c.id] = null;
    this.state = opts.initialState ? JSON.parse(JSON.stringify(opts.initialState)) : this.buildInitialState(seed);
    for (const r of Object.values(this.state.robots)) { if (!r.perception) r.perception = { state: "CLEAR", ahead_m: SIM.LIDAR_RANGE, nearest_m: null, obstacles: [] }; if (r.floor === undefined) r.floor = 1; if (r.lift_id === undefined) r.lift_id = null; if (r.lift_stage === undefined) r.lift_stage = null; }
    if (!this.state.lifts) this.state.lifts = {};
    for (const id of Object.keys(this.state.robots)) this.rt[id] = { backingOff: false, resumePoint: null, dwell: 0, waitTicks: 0, target: null, goalLoc: null, phase: null, chargerId: null, idleTicks: 0, lastBatteryAlert: "NONE", frontId: null, frontDist: Infinity, lastPercEvent: -1e9, pending: null, liftId: null, plannedLiftId: null, liftStage: null, liftEnqueuedTick: 0, liftRetryTick: 0, liftExit: null, liftBlockedTicks: 0 };
    this.nextTaskTick = this.state.sim.tick + 10;
    if (opts.initialState) this.rehydrate();   // WS 斷線 → LOCAL 接手：從公開狀態反推私有 runtime，模擬才真正連續
  }

  /** 從公開 TwinState 反推引擎私有 runtime（round-6 P1）：行進中的機器人不會「瞬間抵達」、
   *  電梯行程不中斷、任務/事件/決策序號延續不重複。反推不出來的個案安全釋放資源後重新規劃。 */
  private rehydrate() {
    const S = this.state;
    const num = (id: string) => { const m = /(\d+)$/.exec(id); return m ? parseInt(m[1], 10) : 0; };
    for (const id in S.tasks) this.taskSeq = Math.max(this.taskSeq, num(id) + 1);
    for (const e of S.recent_events) this.eventSeq = Math.max(this.eventSeq, num(e.id));
    for (const d of S.recent_decisions) this.decisionSeq = Math.max(this.decisionSeq, num(d.id));
    this.completedCount = S.kpi.operation.completed_today;
    this.onTime = Math.round(S.kpi.operation.on_time_rate * this.completedCount);
    const series = S.kpi.throughput_series;
    this.lastSeriesTick = series.length ? series[series.length - 1].tick : S.sim.tick;
    for (const zid in S.zones) if (S.zones[zid].blocked_reason) this.blockedZones.add(zid);
    for (const aid in S.alerts) if (aid.startsWith("traffic-")) { const zid = aid.slice(8); this.congestedZones.set(zid, { level: Math.max(0.3, S.zones[zid]?.congestion ?? 0.5), until: S.sim.tick + 600 }); }
    for (const rid in S.robots) {
      const r = S.robots[rid]; const rt = this.rt[rid];
      const task = r.current_task_id ? S.tasks[r.current_task_id] : undefined;
      rt.phase = r.fsm === "NAVIGATING" || r.fsm === "TASK_ASSIGNED" ? "TO_SOURCE"
        : r.fsm === "TRANSPORTING" ? "TO_DEST"
        : r.fsm === "GOING_TO_CHARGE" || r.fsm === "CHARGING" ? "TO_CHARGER"
        : null;
      rt.goalLoc = r.destination;
      if (r.path.length && r.path_index < r.path.length) { const last = r.path[r.path.length - 1]; rt.target = [last[0], last[1]]; }
      if (r.fsm === "PICKING") rt.dwell = Math.max(1, SIM.PICK_TICKS - (S.sim.tick - r.fsm_since_tick));
      if (r.fsm === "DELIVERING") rt.dwell = Math.max(1, SIM.DROP_TICKS - (S.sim.tick - r.fsm_since_tick));
      if ((r.fsm === "GOING_TO_CHARGE" || r.fsm === "CHARGING") && r.destination && r.destination in this.chargerBusy) { rt.chargerId = r.destination; this.chargerBusy[r.destination] = rid; }
      rt.lastBatteryAlert = r.battery < THRESHOLDS.BATTERY_CRITICAL ? "CRIT" : r.battery < THRESHOLDS.BATTERY_WARNING ? "WARN" : "NONE";
      if (r.lift_stage) {
        // 電梯行程：queue / occupant / reserved_by 本來就在 state.lifts 裡，這裡補回 pending 與子狀態
        let liftId = r.lift_id;
        if (!liftId) for (const lid in S.lifts) { const L = S.lifts[lid]; if (L.occupant === rid || L.reserved_by === rid || L.queue["1"].includes(rid) || L.queue["2"].includes(rid)) { liftId = lid; break; } }
        const loc = r.destination ? this.loc[r.destination] : undefined;
        const chg = !loc && r.destination ? this.layout.charging_stations.find((c) => c.id === r.destination) : undefined;
        const goal = loc ? { point: [loc.access_point[0], loc.access_point[1]] as [number, number], floor: loc.floor ?? 1 }
          : chg ? { point: [chg.access_point[0], chg.access_point[1]] as [number, number], floor: 1 } : null;
        if (liftId && goal) {
          rt.liftId = liftId; rt.liftStage = r.lift_stage;
          rt.pending = { point: goal.point, phase: rt.phase ?? "TO_SOURCE", locId: r.destination, floor: goal.floor };
          rt.liftEnqueuedTick = S.sim.tick;
          if (r.lift_stage !== "TO_LIFT") rt.target = null;   // QUEUED / BOARDING / RIDING / ALIGHTING 走 microMove，不走網格
        } else {
          // 反推不出完整行程：安全釋放電梯資源，回頭重新規劃（比帶著半套狀態亂走安全）
          this.releaseRobotFromLift(rid);
          r.path = []; r.path_index = 0; rt.target = null; rt.pending = null; rt.phase = null;
          this.setFsm(r, task ? "TASK_ASSIGNED" : "IDLE");
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // 初始狀態
  // ─────────────────────────────────────────────────────────
  private buildInitialState(seed: number): TwinState {
    const L = this.layout;
    const robots: Record<string, RobotState> = {};
    for (const sp of L.spawn.robots) {
      robots[sp.id] = {
        id: sp.id, model: "AMR-L", position: [Math.floor(sp.position[0]) + 0.5, 0, Math.floor(sp.position[2]) + 0.5], heading: sp.heading, velocity: 0, max_speed: SIM.MAX_SPEED, floor: sp.floor ?? 1, lift_id: null, lift_stage: null,
        battery: sp.battery, status: "IDLE", fsm: "IDLE", health: 95 + Math.floor(this.rng() * 5), current_task_id: null, destination: null,
        path: [], path_index: 0, load: { current: 0, capacity: 4 }, zone: null, eta_s: null, fsm_since_tick: 0,
        stats: { distance_m: 0, tasks_completed: 0, energy_wh: 0, busy_ticks: 0, wait_ticks: 0 },
        perception: { state: "CLEAR", ahead_m: SIM.LIDAR_RANGE, nearest_m: null, obstacles: [] },
      };
    }
    return {
      schema_version: "1.0", layout_id: L.id,
      sim: { tick: 0, tick_ms: THRESHOLDS.TICK_MS, speed: 1, mode: "LIVE", seed, baseline_snapshot_id: null },
      robots, tasks: {},
      lifts: Object.fromEntries((L.lifts ?? []).map((l) => [l.id, {
        id: l.id, state: "IDLE" as const, floor: 1, target_floor: null, y: 0,
        door_f1: "CLOSED" as const, door_f2: "CLOSED" as const,
        occupant: null, reserved_by: null, queue: { "1": [], "2": [] } as Record<string, string[]>,
        until_tick: 0, fault: false, fault_remaining: 0, trips: 0, busy_ticks: 0, wait_total_ticks: 0, wait_n: 0,
      }])),
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
        lifts: { trips: 0, utilization: 0, avg_wait_s: 0, faults: 0 },
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
      case "LIFT_FAULT": { const L = S.lifts[targetId]; if (L && L.fault) { L.fault = false; L.until_tick = S.sim.tick + L.fault_remaining; L.fault_remaining = 0; this.resolveAlert(`lift-${targetId}`); this.emit("LIFT_FAULT", "LIFT", "INFO", `${targetId} restored — resuming`, {}); } break; }
      default: break;
    }
  }

  /** 使用者手動建立任務 */
  createTask(t: { type: TaskState["type"]; priority: TaskPriority; source: string; destination: string; load_units?: number }): TaskState {
    const err = taskError(this.loc, t.type, t.source, t.destination);
    if (err) throw new Error(err);
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
    this.stepLifts();
    for (const id of Object.keys(S.robots)) this.updatePerception(S.robots[id], this.rt[id]);
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
      const srcFloor = src.floor ?? 1;
      const liftPick: Record<string, string> = {};   // 每台候選當下算出的最佳電梯（round-6 P2：稽核與實際路線綁定）
      const cands: DecisionCandidate[] = idle.map((r) => {
        // 跨樓層：地面距離 + 固定懲罰 + 「實際電梯狀態」的預估等待（排隊長度/忙碌/所在樓層），換算成等效距離
        const flat = Math.hypot(r.position[0] - src.access_point[0], r.position[2] - src.access_point[1]);
        let d = flat, liftInfo: { id: string; waitS: number } | null = null;
        if (r.floor !== srcFloor) {
          const best = [...this.layout.lifts].map((l) => ({ l, cost: this.liftCost(r, l) })).sort((a, b) => a.cost - b.cost || a.l.id.localeCompare(b.l.id))[0];
          const waitS = best && best.cost < Infinity
            ? Math.round((best.cost - Math.hypot(r.position[0] - (best.l.cell[0] - 1.5), r.position[2] - (best.l.cell[1] + 0.5)) / (SIM.MAX_SPEED * 0.8)) * 10) / 10
            : 60;
          liftInfo = { id: best && best.cost < Infinity ? best.l.id : "—", waitS };
          if (liftInfo.id !== "—") liftPick[r.id] = liftInfo.id;
          d = flat + SIM.LIFT_XFLOOR_PENALTY_M + waitS * SIM.MAX_SPEED * 0.8;
        }
        const zone = r.zone ? S.zones[r.zone] : null;
        const cong = zone ? zone.congestion : 0;
        const workload: DecisionCandidate["workload"] = r.stats.tasks_completed > 8 ? "HIGH" : r.stats.tasks_completed > 4 ? "MEDIUM" : "LOW";
        const score = weights.distance * (1 - Math.min(1, d / 120)) + weights.battery * (r.battery / 100) + weights.workload * (workload === "LOW" ? 1 : workload === "MEDIUM" ? 0.6 : 0.2) + weights.congestion * (1 - cong) + weights.health * (r.health / 100);
        const reasons: string[] = liftInfo
          ? [`${flat.toFixed(0)}m ground`, `+${SIM.LIFT_XFLOOR_PENALTY_M}m cross-floor via ${liftInfo.id}`, `est. lift wait ${liftInfo.waitS}s`, `${r.battery.toFixed(0)}% battery`]
          : [`${d.toFixed(0)}m from task`, `${r.battery.toFixed(0)}% battery`, `${workload.toLowerCase()} workload`];
        if (cong < 0.3) reasons.push("no route congestion");
        return { robot_id: r.id, score: Math.round(score * 1000) / 1000, distance_m: Math.round(d), battery: Math.round(r.battery), workload, congestion: Math.round(cong * 100) / 100, health: r.health, reasons, rejected_reason: null };
      }).sort((a, b) => b.score - a.score);
      const best = cands[0];
      for (const c of cands.slice(1)) c.rejected_reason = c.battery < 40 ? "battery too low" : c.distance_m > best.distance_m * 1.5 ? "farther from task" : c.workload === "HIGH" ? "high workload" : "lower score";
      const robot = S.robots[best.robot_id];
      idle.splice(idle.indexOf(robot), 1);
      task.status = "ASSIGNED"; task.assigned_robot = robot.id; task.assigned_tick = S.sim.tick;
      robot.current_task_id = task.id;
      this.rt[robot.id].plannedLiftId = liftPick[robot.id] ?? null;   // planTo 跨樓層時優先使用稽核記錄的電梯
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

  // ─────────────────────────────────────────────────────────
  // 電梯（規格書 §6/§9/§10/§11/§13/§14）
  //  後端（此引擎）是唯一權威：門、平台高度、預約、排隊、上/下車全在這裡；前端只做插值渲染。
  //  節點：slot0(=approach/exit) → slot1 → slot2 在井道西側；cabin = 電梯格中心。
  // ─────────────────────────────────────────────────────────
  private liftLayout(id: string) { return this.layout.lifts.find((l) => l.id === id)!; }
  private elevOf(floor: number): number { return this.layout.floors.find((f) => f.id === floor)?.elevation ?? 0; }
  private liftSlot(l: (typeof this.layout.lifts)[number], i: number): [number, number] { return [l.cell[0] - 2 - i + 0.5, l.cell[1] + 0.5]; }
  private liftCabin(l: (typeof this.layout.lifts)[number]): [number, number] { return [l.cell[0] + 0.5, l.cell[1] + 0.5]; }
  /** 出口節點（規格書 §6.4）：與排隊線分開，且「從轎廂到出口的直線」必須避開所有站著的機器人（排隊/閒置），
   *  一次選定（sticky），被擋太久才換下一個候選 —— 避免每 tick 換目標造成的原地震盪。 */
  private pickLiftExit(l: (typeof this.layout.lifts)[number], floor: number, skip = 0): [number, number] {
    const grid = this.grids[floor];
    const cabin = this.liftCabin(l);
    const cand: Array<[number, number]> = [[-2, -2], [-2, 2], [-3, -1], [-3, 1], [-1, -2], [-1, 2], [-2, 0]];
    const clear = (to: [number, number]) => {
      for (const o of Object.values(this.state.robots)) {
        if (o.floor !== floor || o.lift_id) continue;
        if (o.velocity > 0.1) continue;                     // 只避開站著不動的
        // 點到線段距離
        const [ax, az] = cabin, [bx, bz] = to;
        const dx = bx - ax, dz = bz - az; const len2 = dx * dx + dz * dz;
        const t = Math.max(0, Math.min(1, ((o.position[0] - ax) * dx + (o.position[2] - az) * dz) / (len2 || 1)));
        const d = Math.hypot(o.position[0] - (ax + dx * t), o.position[2] - (az + dz * t));
        if (d < SIM.MIN_SEP) return false;
      }
      return true;
    };
    const ok: Array<[number, number]> = [];
    for (const [dc, dr] of cand) {
      const c = l.cell[0] + dc, r = l.cell[1] + dr;
      if (!isWalkable(grid, c, r)) continue;
      const p: [number, number] = [c + 0.5, r + 0.5];
      if (clear(p)) ok.push(p);
    }
    if (ok.length) return ok[skip % ok.length];
    return [l.cell[0] - 2 + 0.5, l.cell[1] - 2 + 0.5];
  }

  /** 直線微移動（進出轎廂 / 排隊遞補；不經過網格）。回傳是否已到達。 */
  private microMove(r: RobotState, to: [number, number], speed: number, floorOverride: number | null = null): boolean {
    const fl = floorOverride ?? r.floor;
    const dx = to[0] - r.position[0], dz = to[1] - r.position[2];
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) { r.velocity = 0; return true; }
    const step = Math.min(dist, speed * SIM.TICK_S);
    const nx = r.position[0] + (dx / dist) * step, nz = r.position[2] + (dz / dist) * step;
    // 排隊/進出轎廂也要維持物理間距（MIN_SEP），不能疊在前一台上
    for (const id in this.state.robots) {
      if (id === r.id) continue; const o = this.state.robots[id];
      if (o.floor !== fl || o.lift_id) continue;
      const dn = Math.hypot(nx - o.position[0], nz - o.position[2]);
      if (dn < SIM.MIN_SEP && dn < Math.hypot(r.position[0] - o.position[0], r.position[2] - o.position[2])) { r.velocity = 0; return false; }
    }
    r.position[0] = nx; r.position[2] = nz;
    r.heading = Math.atan2(dz, dx); r.velocity = speed;
    return false;
  }

  private setLiftStage(r: RobotState, rt: RobotRt, stage: RobotRt["liftStage"]) { rt.liftStage = stage; r.lift_stage = stage; }

  /** 機器人從電梯流程中移除（故障重選 / 機器人離線 / 任務取消） */
  releaseRobotFromLift(robotId: string) {
    const S = this.state;
    for (const lid in S.lifts) {
      const L = S.lifts[lid];
      for (const f of ["1", "2"]) { const i = L.queue[f].indexOf(robotId); if (i >= 0) L.queue[f].splice(i, 1); }
      if (L.reserved_by === robotId) { L.reserved_by = null; this.emit("LIFT_RESERVATION_RELEASED", "LIFT", "LOW", `${lid} reservation released (${robotId})`, { robot_id: robotId }); }
      if (L.occupant === robotId) { L.occupant = null; if (L.state === "BOARDING" || L.state === "ALIGHTING") { L.state = "DOOR_CLOSING_AFTER_EXIT"; L.until_tick = this.state.sim.tick + SIM.LIFT_DOOR_TICKS; } }
    }
    const r = S.robots[robotId]; const rt = this.rt[robotId];
    if (r && rt) { r.lift_id = null; this.setLiftStage(r, rt, null); }
  }

  /** 每 tick 推進所有電梯的狀態機（在機器人之前跑） */
  private stepLifts() {
    const S = this.state; const tick = S.sim.tick;
    for (const lid of Object.keys(S.lifts).sort()) {
      const L = S.lifts[lid];
      if (L.fault) continue;                             // FAULT：全部凍結（含平台高度），等 clear
      if (L.state !== "IDLE" && L.state !== "COOLDOWN") L.busy_ticks++;
      // 平台高度插值（MOVING 時 smoothstep；其餘吸附樓層）
      if (L.state === "MOVING_UP" || L.state === "MOVING_DOWN") {
        const t = Math.min(1, Math.max(0, 1 - (L.until_tick - tick) / SIM.LIFT_TRAVEL_TICKS));
        const e = t * t * (3 - 2 * t);
        const y0 = this.elevOf(L.state === "MOVING_UP" ? 1 : 2), y1 = this.elevOf(L.state === "MOVING_UP" ? 2 : 1);
        L.y = y0 + (y1 - y0) * e;
      } else if (L.floor !== null) L.y = this.elevOf(L.floor);
      if (tick < L.until_tick) continue;
      switch (L.state) {
        case "IDLE": {
          // 排程：FIFO — 兩層 queue 各取隊首，比進入時間（先到先服務），同分取一樓
          if (!L.reserved_by) {
            const heads: Array<[string, number]> = [];
            for (const f of ["1", "2"]) if (L.queue[f].length) { const rid = L.queue[f][0]; heads.push([rid, this.rt[rid]?.liftEnqueuedTick ?? 0]); }
            heads.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
            if (heads.length) { L.reserved_by = heads[0][0]; this.emit("LIFT_RESERVED", "LIFT", "INFO", `${lid} reserved by ${L.reserved_by}`, { robot_id: L.reserved_by }); }
          }
          if (L.reserved_by) {
            const rr = S.robots[L.reserved_by];
            if (!rr || rr.status === "OFFLINE") { this.releaseRobotFromLift(L.reserved_by!); break; }
            if (L.floor === rr.floor) { L.state = "DOOR_OPENING"; L.until_tick = tick + SIM.LIFT_DOOR_TICKS; }
            else { L.target_floor = rr.floor; L.state = rr.floor === 2 ? "MOVING_UP" : "MOVING_DOWN"; L.floor = null; L.until_tick = tick + SIM.LIFT_TRAVEL_TICKS; }
          }
          break;
        }
        case "MOVING_UP": case "MOVING_DOWN": { L.state = "LEVELING"; L.until_tick = tick + SIM.LIFT_LEVEL_TICKS; this.emit("LIFT_LEVELING", "LIFT", "LOW", `${lid} leveling at Floor ${L.target_floor}`, {}); break; }
        case "LEVELING": {
          L.floor = L.target_floor!; L.target_floor = null; L.y = this.elevOf(L.floor);
          L.state = L.occupant ? "DOOR_OPENING_AT_DESTINATION" : "DOOR_OPENING";
          L.until_tick = tick + SIM.LIFT_DOOR_TICKS;
          this.emit("LIFT_ARRIVED", "LIFT", "INFO", `${lid} arrived at Floor ${L.floor}`, {});
          break;
        }
        case "DOOR_OPENING": {
          (L.floor === 1 ? (L.door_f1 = "OPEN") : (L.door_f2 = "OPEN"));
          L.state = "BOARDING";                          // 等 reserved robot 走進來（robot 端驅動）
          this.emit("LIFT_GATE_OPENED", "LIFT", "LOW", `${lid} Floor ${L.floor} gate opened`, {});
          break;
        }
        case "BOARDING": {
          const rr = L.reserved_by ? S.robots[L.reserved_by] : null;
          if (!rr || rr.status === "OFFLINE") {          // 預約者消失 → 關門回 IDLE
            if (L.reserved_by) this.releaseRobotFromLift(L.reserved_by);
            L.door_f1 = "CLOSED"; L.door_f2 = "CLOSED"; L.state = "COOLDOWN"; L.until_tick = tick + SIM.LIFT_COOLDOWN_TICKS;
            this.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", `${lid} cooldown`, {});
          }
          break;                                          // occupant 由 robot 端設定 → DOOR_CLOSING
        }
        case "DOOR_CLOSING": {
          L.door_f1 = "CLOSED"; L.door_f2 = "CLOSED";
          if (L.occupant) {
            const rr = S.robots[L.occupant]; const dest = this.rt[L.occupant]?.pending?.floor ?? (rr.floor === 1 ? 2 : 1);
            L.target_floor = dest; L.state = dest === 2 ? "MOVING_UP" : "MOVING_DOWN"; L.floor = null; L.until_tick = tick + SIM.LIFT_TRAVEL_TICKS;
            L.trips++;
            this.emit("LIFT_DEPARTED", "LIFT", "INFO", `${lid} departed → Floor ${dest} (${L.occupant})`, { robot_id: L.occupant });
          } else { L.state = "COOLDOWN"; L.until_tick = tick + SIM.LIFT_COOLDOWN_TICKS; this.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", `${lid} cooldown`, {}); }
          break;
        }
        case "DOOR_OPENING_AT_DESTINATION": {
          (L.floor === 1 ? (L.door_f1 = "OPEN") : (L.door_f2 = "OPEN"));
          L.state = "ALIGHTING";                          // robot 端會把 occupant 走出去
          this.emit("LIFT_GATE_OPENED", "LIFT", "LOW", `${lid} Floor ${L.floor} gate opened`, {});
          break;
        }
        case "ALIGHTING": break;                          // robot 端清 occupant → DOOR_CLOSING_AFTER_EXIT
        case "DOOR_CLOSING_AFTER_EXIT": { L.door_f1 = "CLOSED"; L.door_f2 = "CLOSED"; L.state = "COOLDOWN"; L.until_tick = tick + SIM.LIFT_COOLDOWN_TICKS; this.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", `${lid} cooldown`, {}); break; }
        case "COOLDOWN": { L.state = "IDLE"; break; }
        default: break;
      }
    }
  }

  /** 機器人端的電梯流程。回傳 true = 這個 tick 已被電梯流程消化（FSM 不往下跑）。 */
  private handleLift(r: RobotState, rt: RobotRt): boolean {
    const S = this.state; const tick = S.sim.tick;
    const stage = rt.liftStage;
    if (stage === null || stage === "TO_LIFT") {
      if (rt.target !== null) return false;              // 還在走 A* 前往排隊格
      // 抵達排隊格 → 入隊
      const L = S.lifts[rt.liftId!];
      if (L.fault) return this.reRouteLift(r, rt);
      const f = String(r.floor);
      if (!L.queue[f].includes(r.id)) { L.queue[f].push(r.id); rt.liftEnqueuedTick = tick; this.emit("LIFT_QUEUE_ENTERED", "LIFT", "LOW", `${r.id} queued at ${rt.liftId} (F${r.floor}, #${L.queue[f].length})`, { robot_id: r.id }); }
      this.setLiftStage(r, rt, "QUEUED");
      return true;
    }
    const L = S.lifts[rt.liftId!];
    const lay = this.liftLayout(rt.liftId!);
    if (L.fault && stage !== "RIDING" && stage !== "ALIGHTING") return this.reRouteLift(r, rt);   // 已在轎廂/出轎廂則原地等待復原
    switch (stage) {
      case "QUEUED": {
        const f = String(r.floor);
        const pos = L.queue[f].indexOf(r.id);
        if (pos < 0) { this.setLiftStage(r, rt, "TO_LIFT"); return true; }
        // 遞補到自己該站的排隊格
        this.microMove(r, this.liftSlot(lay, Math.min(pos, 2)), SIM.LIFT_QUEUE_SPEED);
        // 隊首 + 我的預約 + 門開著 → 開始上車
        if (pos === 0 && L.reserved_by === r.id && L.state === "BOARDING" && L.floor === r.floor) {
          this.setLiftStage(r, rt, "BOARDING");
          this.emit("ROBOT_BOARDING_STARTED", "LIFT", "INFO", `${r.id} boarding ${rt.liftId} → Floor ${rt.pending!.floor}`, { robot_id: r.id });
        }
        return true;
      }
      case "BOARDING": {
        if (this.microMove(r, this.liftCabin(lay), SIM.LIFT_BOARD_SPEED)) {
          const f = String(r.floor);
          const i = L.queue[f].indexOf(r.id); if (i >= 0) L.queue[f].splice(i, 1);
          L.occupant = r.id; L.reserved_by = null; r.lift_id = rt.liftId;
          L.wait_total_ticks += tick - rt.liftEnqueuedTick; L.wait_n++;
          L.state = "DOOR_CLOSING"; L.until_tick = tick + SIM.LIFT_DOOR_TICKS;
          this.setLiftStage(r, rt, "RIDING");
          this.emit("ROBOT_BOARDED", "LIFT", "INFO", `${r.id} boarded ${rt.liftId}`, { robot_id: r.id });
        }
        return true;
      }
      case "RIDING": {
        r.velocity = 0;                                   // 位置固定在轎廂中心，y 由前端跟著 L.y 畫
        const c = this.liftCabin(lay); r.position[0] = c[0]; r.position[2] = c[1];
        if (L.state === "ALIGHTING" && L.floor === rt.pending!.floor) {
          // 門已開 → 開始下車。樓層【還不能】翻（規格 §2.2：完全離開轎廂/門區才切換）
          this.setLiftStage(r, rt, "ALIGHTING");
          this.emit("ROBOT_ALIGHTING_STARTED", "LIFT", "INFO", `${r.id} alighting ${rt.liftId} at Floor ${L.floor}`, { robot_id: r.id });
        }
        return true;
      }
      case "ALIGHTING": {
        const tf = rt.pending!.floor;                      // 出口與間距全用目的樓層計算；r.floor 到抵達出口那一刻才翻
        if (!rt.liftExit) { rt.liftExit = this.pickLiftExit(lay, tf); rt.liftBlockedTicks = 0; }
        const arrived = this.microMove(r, rt.liftExit, SIM.LIFT_BOARD_SPEED, tf);
        if (!arrived && r.velocity === 0) {
          if (++rt.liftBlockedTicks % 40 === 0) rt.liftExit = this.pickLiftExit(lay, tf, rt.liftBlockedTicks / 40);   // 被擋 4 秒換一個出口
        } else if (r.velocity > 0) rt.liftBlockedTicks = 0;
        if (arrived) {
          r.floor = tf;                                    // ✅ 完全離開門區的這一刻才進入目的樓層網格
          L.occupant = null; r.lift_id = null;
          L.state = "DOOR_CLOSING_AFTER_EXIT"; L.until_tick = tick + SIM.LIFT_DOOR_TICKS;
          this.emit("ROBOT_EXITED", "LIFT", "INFO", `${r.id} exited ${rt.liftId} on Floor ${r.floor}`, { robot_id: r.id });
          const p = rt.pending!; rt.pending = null; this.setLiftStage(r, rt, null); rt.liftId = null; rt.liftExit = null; rt.liftBlockedTicks = 0;
          this.planTo(r, rt, p.point, p.phase, p.locId, p.floor);   // REPLANNING_AFTER_LIFT
        }
        return true;
      }
      default: return false;
    }
  }

  /** 電梯故障：離開這座電梯的隊伍，改選另一座；兩座都故障就原地定期重試 */
  private reRouteLift(r: RobotState, rt: RobotRt): boolean {
    const tick = this.state.sim.tick;
    if (tick < rt.liftRetryTick) { r.velocity = 0; return true; }
    rt.liftRetryTick = tick + SIM.LIFT_RETRY_TICKS;
    const p = rt.pending!;
    this.releaseRobotFromLift(r.id);
    rt.pending = p;                                       // release 會清 stage，pending 要留著
    const alive = this.layout.lifts.filter((l) => !this.state.lifts[l.id].fault);
    if (!alive.length) { r.velocity = 0; return true; }   // 全故障：原地等，LIFT_RETRY_TICKS 後再試
    this.planTo(r, rt, p.point, p.phase, p.locId, p.floor);
    this.emit("ROUTE_REPLANNED", "LIFT", "MEDIUM", `${r.id} rerouted to ${rt.liftId} (lift fault)`, { robot_id: r.id });
    return true;
  }

  private stepRobot(r: RobotState, rt: RobotRt) {
    const S = this.state; const tick = S.sim.tick;
    if (r.fsm === "OFFLINE") { r.velocity = 0; return; }
    this.batteryTick(r, rt);
    const task = r.current_task_id ? S.tasks[r.current_task_id] : undefined;
    if (rt.pending && this.handleLift(r, rt)) {
      r.status = this.statusOf(r);
      if (r.fsm !== "IDLE" && r.fsm !== "CHARGING") r.stats.busy_ticks++;
      r.zone = this.zoneAt(r.position[0], r.position[2], r.floor);
      return;
    }

    switch (r.fsm) {
      case "IDLE": {
        r.velocity = 0; rt.idleTicks++;
        if (r.battery < THRESHOLDS.BATTERY_WARNING + 15 && this.freeCharger()) { this.goCharge(r, rt); break; }
        if (rt.idleTicks > SIM.IDLE_TO_PARK_TICKS && !rt.phase && r.floor === 1) { const p = this.parkSpot(r); if (p) { this.planTo(r, rt, p, "TO_PARK"); } }
        if (rt.phase === "TO_PARK") { this.moveAlongPath(r, rt); if (rt.target === null && !rt.pending) rt.phase = null; }
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
        if (rt.target === null && !rt.pending) { rt.dwell = SIM.PICK_TICKS; this.setFsm(r, "PICKING"); }
        break;
      }
      case "PICKING": {
        r.velocity = 0;
        if (--rt.dwell <= 0 && task) {
          const dest = this.loc[task.destination];
          if (!dest) { // 防禦：目的地不存在 → 任務失敗、機器人回 IDLE，不讓迴圈炸掉
            task.status = "FAILED"; task.completed_tick = tick;
            this.emit("TASK_FAILED", "SIMULATION", "HIGH", `Task #${task.id} failed: unknown destination ${task.destination}`, { robot_id: r.id, task_id: task.id });
            r.current_task_id = null; r.destination = null; rt.phase = null; rt.goalLoc = null; this.setFsm(r, "IDLE"); break;
          }
          r.load.current = Math.min(r.load.capacity, task.load_units);
          this.emit("TASK_STARTED", "ROBOT", "INFO", `${r.id} picked item at ${this.pretty(task.source)}`, { robot_id: r.id, task_id: task.id });
          this.planTo(r, rt, dest.access_point, "TO_DEST", task.destination);
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
        if (rt.target === null && !rt.pending) { rt.dwell = SIM.DROP_TICKS * this.stationSlowdown(task.destination); this.setFsm(r, "DELIVERING"); }
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
        if (rt.target === null && !rt.pending) { this.setFsm(r, "CHARGING"); this.emit("ROBOT_STATE_CHANGED", "ROBOT", "INFO", `${r.id} charging started (${r.battery.toFixed(0)}%)`, { robot_id: r.id }); }
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
          const blocked = this.blockedCells(r.id, r.floor);
          const p = astar(this.grids[r.floor], toCell(r.position[0], r.position[2]), rt.target, { blocked, costMap: this.congestionCost(r.floor) });
          if (p) { r.path = p; r.path_index = 0; rt.waitTicks = 0; this.emit("ROUTE_REPLANNED", "PLANNER", "LOW", `${r.id} rerouted (${p.length} cells)`, { robot_id: r.id, task_id: r.current_task_id ?? undefined }); }
        }
        this.setFsm(r, rt.phase === "TO_DEST" ? "TRANSPORTING" : rt.phase === "TO_CHARGER" ? "GOING_TO_CHARGE" : rt.phase === "TO_PARK" ? "IDLE" : "NAVIGATING");
        break;
      }
      case "ERROR": { r.velocity = 0; break; }
    }
    r.status = this.statusOf(r);
    if (r.fsm !== "IDLE" && r.fsm !== "CHARGING") r.stats.busy_ticks++;
    r.zone = this.zoneAt(r.position[0], r.position[2], r.floor);
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
  /** 工作站/貨架的服務格：access point 周圍可走、且沒被其他機器人當目標或佔用的格，挑離自己最近的；都滿了回傳 null */
  private freeServiceCell(r: RobotState, point: [number, number]): GridCell | null {
    const grid = this.grids[r.floor];
    const ap = nearestWalkable(grid, point[0], point[1]);
    const claimed = new Set<string>();
    for (const id in this.state.robots) { if (id === r.id) continue; const o = this.state.robots[id]; if (o.floor !== r.floor) continue; const t = this.rt[id].target; if (t) claimed.add(cellKey(t[0], t[1])); const c = toCell(o.position[0], o.position[2]); claimed.add(cellKey(c[0], c[1])); }
    const my = toCell(r.position[0], r.position[2]);
    let best: GridCell | null = null, bestD = Infinity;
    for (let dr = -SIM.SERVICE_RADIUS; dr <= SIM.SERVICE_RADIUS; dr++) for (let dc = -SIM.SERVICE_RADIUS; dc <= SIM.SERVICE_RADIUS; dc++) {
      const c: GridCell = [ap[0] + dc, ap[1] + dr];
      if (!isWalkable(grid, c[0], c[1]) || claimed.has(cellKey(c[0], c[1]))) continue;
      const d = Math.hypot(c[0] - my[0], c[1] - my[1]) + Math.hypot(dc, dr) * 0.01; // 近的優先，同距離時靠近 access point 的優先
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /** 選電梯：優先空閒、其次距離近；同分取 id 小的（確定性） */
  /** 電梯成本（規格書 §7.2）：走到電梯時間 + 排隊估計 + 電梯就位估計；FAULT 不選。回傳 null = 沒有可用電梯 */
  liftCost(r: RobotState, l: (typeof this.layout.lifts)[number]): number {
    const L = this.state.lifts[l.id];
    if (L.fault) return Infinity;
    const approach = Math.hypot(r.position[0] - (l.cell[0] - 1.5), r.position[2] - (l.cell[1] + 0.5)) / (SIM.MAX_SPEED * 0.8);
    // 預約者上車前仍留在 queue 裡，只有「不在任一 queue」（已離隊上車中）才額外 +1，避免重複計等待成本
    const reservedExtra = L.reserved_by && !L.queue["1"].includes(L.reserved_by) && !L.queue["2"].includes(L.reserved_by) ? 1 : 0;
    const queueLen = L.queue["1"].length + L.queue["2"].length + reservedExtra;
    const perService = (SIM.LIFT_DOOR_TICKS * 4 + SIM.LIFT_TRAVEL_TICKS + SIM.LIFT_LEVEL_TICKS + SIM.LIFT_COOLDOWN_TICKS + 40) * SIM.TICK_S;
    const busy = L.state === "IDLE" ? 0 : perService * 0.5;
    const wrongFloor = L.floor !== null && L.floor !== r.floor ? SIM.LIFT_TRAVEL_TICKS * SIM.TICK_S : 0;
    return approach + queueLen * perService + busy + wrongFloor;
  }

  private pickLift(r: RobotState): (typeof this.layout.lifts)[number] | null {
    const c = [...this.layout.lifts].map((l) => ({ l, cost: this.liftCost(r, l) })).sort((a, b) => a.cost - b.cost || a.l.id.localeCompare(b.l.id));
    return c.length && c[0].cost < Infinity ? c[0].l : null;
  }

  private planTo(r: RobotState, rt: RobotRt, point: [number, number], phase: RobotRt["phase"], locId: string | null = null, targetFloor: number | null = null) {
    const tf = targetFloor ?? (locId ? this.loc[locId]?.floor ?? 1 : r.floor);
    if (tf !== r.floor) {
      // 跨樓層（規格書 §7）：Origin → 排隊格（A*）→ 電梯狀態機（stepLifts/handleLift）→ 目的樓層重新規劃
      // 派工時稽核記錄了哪座電梯就優先用哪座（只有它已 FAULT 才重挑），用完即清（round-6 P2）
      const preferred = rt.plannedLiftId ? this.layout.lifts.find((l) => l.id === rt.plannedLiftId && !this.state.lifts[l.id].fault) ?? null : null;
      rt.plannedLiftId = null;
      const lift = preferred ?? this.pickLift(r);
      rt.pending = { point, phase, locId, floor: tf };
      if (!lift) { rt.liftId = this.layout.lifts[0]?.id ?? null; this.setLiftStage(r, rt, "TO_LIFT"); rt.target = null; r.path = []; r.path_index = 0; rt.liftRetryTick = this.state.sim.tick + SIM.LIFT_RETRY_TICKS; return; }
      rt.liftId = lift.id;
      this.setLiftStage(r, rt, "TO_LIFT");
      this.emit("LIFT_REQUESTED", "LIFT", "LOW", `${r.id} requested ${lift.id} (F${r.floor} → F${tf})`, { robot_id: r.id });
      const L = this.state.lifts[lift.id];
      const slotIdx = Math.min(L.queue[String(r.floor)].length, 2);
      const sp = this.liftSlot(lift, slotIdx);
      const start = toCell(r.position[0], r.position[2]);
      const goal: GridCell = [Math.floor(sp[0]), Math.floor(sp[1])];
      const grid = this.grids[r.floor];
      const path = astar(grid, start, goal, { blocked: this.blockedCells(r.id, r.floor), costMap: this.congestionCost(r.floor) }) ?? astar(grid, start, goal) ?? [];
      r.path = path; r.path_index = 0; rt.target = goal; rt.phase = phase; rt.goalLoc = locId; rt.waitTicks = 0; rt.backingOff = false; rt.resumePoint = null;
      r.destination = locId;
      if (path.length === 0 && (start[0] !== goal[0] || start[1] !== goal[1])) rt.target = null;
      this.updateEta(r);
      return;
    }
    const start = toCell(r.position[0], r.position[2]);
    const grid = this.grids[r.floor];
    const goal = (locId ? this.freeServiceCell(r, point) : null) ?? nearestWalkable(grid, point[0], point[1]);
    const path = astar(grid, start, goal, { blocked: this.blockedCells(r.id, r.floor), costMap: this.congestionCost(r.floor) }) ?? astar(grid, start, goal) ?? [];
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
    // 感知層：正前方 < PERC_STOP 有動態障礙（別台機器人 / 人）也視為被擋 —— 比格子預約早一格停下，車身不再貼在一起
    let blockedBy: string | null = entering && occ && occ !== r.id ? occ : null;
    const percStop = rt.frontId !== null && rt.frontDist < SIM.PERC_STOP;
    if (!blockedBy && percStop) blockedBy = rt.frontId;
    if (blockedBy) {
      occ = blockedBy;
      // 前往電梯途中在大廳口被排隊的機器人擋住：直接視為到達，入隊後由排隊邏輯遞補到自己的格位
      if (rt.liftStage === "TO_LIFT" && r.path.length - r.path_index <= 2) {
        rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; rt.waitTicks = 0; return;
      }
      if (percStop && r.perception.state !== "STOPPED") {
        r.perception.state = "STOPPED";
        if (this.state.sim.tick - rt.lastPercEvent > SIM.PERC_EVENT_TICKS && rt.frontId && this.state.robots[rt.frontId]) {
          rt.lastPercEvent = this.state.sim.tick;
          this.emit("OBSTACLE_DETECTED", "ROBOT", "LOW", `${r.id} LiDAR: ${rt.frontId} ahead ${rt.frontDist.toFixed(1)} m — holding`, { robot_id: r.id });
        }
      }
      const remaining0 = r.path.length - r.path_index;
      // 工作站前排隊：距目標 ≤ N 格就視為到達、就地作業（避免 10 台排同一格造成死鎖）
      if (!rt.backingOff && remaining0 <= SIM.STATION_ARRIVE_CELLS && (rt.phase === "TO_SOURCE" || rt.phase === "TO_DEST")) {
        // 先找另一個空的服務格（每台一格，不會疊在一起）；真的都滿了才就地作業
        const loc = rt.goalLoc ? this.loc[rt.goalLoc] : null;
        const alt = loc ? this.freeServiceCell(r, loc.access_point) : null;
        if (alt && (alt[0] !== rt.target![0] || alt[1] !== rt.target![1])) {
          const p = astar(this.grids[r.floor], myCell, alt, { blocked: this.blockedCells(r.id, r.floor) });
          if (p && p.length) { r.path = p; r.path_index = 0; rt.target = alt; rt.waitTicks = 0; return; }
        }
        rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; r.eta_s = 0; rt.waitTicks = 0; return;
      }
      r.velocity = Math.max(0, r.velocity - SIM.ACCEL * SIM.TICK_S * 2);
      rt.waitTicks++; r.stats.wait_ticks++;
      const other = this.state.robots[occ];
      // 互相擋住：對方下一格是我這格，或對方的 LiDAR 正前方也是我（面對面）
      const mutual = !!other && ((other.path_index < other.path.length && other.path[other.path_index][0] === myCell[0] && other.path[other.path_index][1] === myCell[1]) || this.rt[other.id].frontId === r.id);
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
    const slowing = rt.frontId !== null && rt.frontDist < SIM.PERC_SLOW;
    if (slowing) r.perception.state = "SLOWING";
    const vmax = r.max_speed * (turning ? SIM.TURN_SLOW : 1) * (remaining <= 1 ? 0.5 : 1) * (this.grids[r.floor].cells[next[1] * this.grid.cols + next[0]] === 2 ? 0.6 : 1) * (this.congestedZones.size ? this.zoneSpeedFactor(next, r.floor) : 1) * (slowing ? 0.45 : 1);
    r.velocity = Math.min(vmax, r.velocity + SIM.ACCEL * SIM.TICK_S);
    r.heading += Math.sign(dh) * Math.min(Math.abs(dh), 4.0 * SIM.TICK_S);
    const stepLen = Math.min(dist, r.velocity * SIM.TICK_S);
    if (dist > 1e-6) {
      const nx = r.position[0] + (dx / dist) * stepLen, nz = r.position[2] + (dz / dist) * stepLen;
      // 物理防撞：這一步會讓我跟某台的中心距低於 MIN_SEP 且比現在更近 → 不走（等下一 tick 或重新規劃）
      for (const id in this.state.robots) {
        if (id === r.id) continue; const o = this.state.robots[id];
        if (o.floor !== r.floor) continue;   // 不同樓層 2D 座標會重疊，物理間距只看同樓層
        const dn = Math.hypot(nx - o.position[0], nz - o.position[2]);
        if (dn < SIM.MIN_SEP && dn < Math.hypot(r.position[0] - o.position[0], r.position[2] - o.position[2])) { r.velocity = 0; rt.waitTicks++; r.stats.wait_ticks++; if (rt.waitTicks >= SIM.WAIT_BACKOFF_TICKS) this.backOff(r, rt); return; }
      }
      r.position[0] = nx; r.position[2] = nz;
    }
    r.stats.distance_m += stepLen;
    // 交通熱圖
    { const ci = myCell[1] * this.grid.cols + myCell[0]; const T = this.traffic[r.floor], TS = this.trafficShort[r.floor]; if (T && ci >= 0 && ci < T.length) { T[ci] += 1; TS[ci] += 1; } }
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
    for (const id in this.state.robots) { const o = this.state.robots[id]; if (o.id === r.id || o.floor !== r.floor) continue; const c = toCell(o.position[0], o.position[2]); claimed.add(cellKey(c[0], c[1])); for (let i = o.path_index; i < Math.min(o.path.length, o.path_index + 4); i++) claimed.add(cellKey(o.path[i][0], o.path[i][1])); }
    let best: GridCell | null = null, bestD = Infinity;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      if (!dr && !dc) continue;
      const c: GridCell = [my[0] + dc, my[1] + dr];
      if (!isWalkable(this.grids[r.floor], c[0], c[1]) || claimed.has(cellKey(c[0], c[1]))) continue;
      const d = Math.abs(dr) + Math.abs(dc); if (d < bestD) { bestD = d; best = c; }
    }
    rt.waitTicks = 0;
    if (!best) return;
    const p = astar(this.grids[r.floor], my, best, { blocked: claimed });
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

  // ─────────────────────────────────────────────────────────
  // Phase 7：虛擬 LiDAR 感知（270° / 4 m）
  //  - 動態障礙：其他機器人、人員（需在視野內且無貨架遮擋）
  //  - 靜態：沿航向射線步進到第一個不可走格 → ahead_m
  //  - 正前方（方位 < 40°、橫向偏移 < 0.75 m）最近的動態障礙決定 STOPPED / SLOWING
  // ─────────────────────────────────────────────────────────
  private lineOfSight(grid: NavGrid, x0: number, z0: number, x1: number, z1: number): boolean {
    const d = Math.hypot(x1 - x0, z1 - z0); const n = Math.max(1, Math.ceil(d / 0.5));
    for (let i = 1; i < n; i++) { const t = i / n; const c = toCell(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t); if (!isWalkable(grid, c[0], c[1])) return false; }
    return true;
  }
  private updatePerception(r: RobotState, rt: RobotRt) {
    const P = r.perception;
    if (r.fsm === "OFFLINE") { P.state = "OFF"; P.obstacles = []; P.nearest_m = null; P.ahead_m = 0; rt.frontId = null; rt.frontDist = Infinity; return; }
    const [x, , z] = r.position; const h = r.heading; const cosH = Math.cos(h), sinH = Math.sin(h);
    const grid = this.grids[r.floor];
    const obs: PerceivedObstacle[] = [];
    const consider = (kind: "ROBOT" | "HUMAN", id: string, ox: number, oz: number) => {
      const dx = ox - x, dz = oz - z; const dist = Math.hypot(dx, dz);
      if (dist > SIM.LIDAR_RANGE || dist < 1e-6) return;
      let b = Math.atan2(dz, dx) - h; while (b > Math.PI) b -= 2 * Math.PI; while (b < -Math.PI) b += 2 * Math.PI;
      if (Math.abs(b) > SIM.LIDAR_FOV / 2) return;
      if (!this.lineOfSight(grid, x, z, ox, oz)) return;
      obs.push({ kind, id, distance_m: Math.round(dist * 10) / 10, bearing_deg: Math.round((-b * 180) / Math.PI) });
    };
    for (const id in this.state.robots) { if (id === r.id) continue; const o = this.state.robots[id]; if (o.floor !== r.floor) continue; consider("ROBOT", id, o.position[0], o.position[2]); }
    for (const id in this.state.people) { const p = this.state.people[id]; if ((p.floor ?? 1) !== r.floor) continue; consider("HUMAN", id, p.position[0], p.position[2]); }
    // 正前方射線（靜態）
    let ahead = SIM.LIDAR_RANGE;
    for (let d = 0.5; d <= SIM.LIDAR_RANGE; d += 0.25) { const c = toCell(x + cosH * d, z + sinH * d); if (!isWalkable(grid, c[0], c[1])) { ahead = d; break; } }
    if (ahead < SIM.LIDAR_RANGE) obs.push({ kind: "RACK", id: null, distance_m: Math.round(ahead * 10) / 10, bearing_deg: 0 });
    obs.sort((a, b) => a.distance_m - b.distance_m || (a.id ?? "").localeCompare(b.id ?? ""));
    // 會擋到我的動態障礙：位於我接下來 PERC_LOOKAHEAD 格路徑上（含斜向的正交鄰格）的最近一個
    let frontId: string | null = null, frontDist = Infinity;
    if (r.path_index < r.path.length) {
      const onPath = new Set<string>(); let prev = toCell(x, z);
      for (let i = r.path_index; i < Math.min(r.path.length, r.path_index + SIM.PERC_LOOKAHEAD); i++) {
        const c = r.path[i]; onPath.add(cellKey(c[0], c[1]));
        if (c[0] !== prev[0] && c[1] !== prev[1]) { onPath.add(cellKey(c[0], prev[1])); onPath.add(cellKey(prev[0], c[1])); }
        prev = c;
      }
      for (const o of obs) {
        if (o.kind === "RACK" || o.id === null) continue;
        const pos = o.kind === "ROBOT" ? this.state.robots[o.id].position : this.state.people[o.id].position;
        const c = toCell(pos[0], pos[2]);
        if (onPath.has(cellKey(c[0], c[1])) && o.distance_m < frontDist) { frontDist = o.distance_m; frontId = o.id; }
      }
    }
    rt.frontId = frontId; rt.frontDist = frontDist;
    P.obstacles = obs.slice(0, 5);
    P.nearest_m = obs.length ? obs[0].distance_m : null;
    P.ahead_m = Math.round(Math.min(ahead, frontId ? frontDist : ahead) * 10) / 10;
    P.state = "CLEAR"; // moveAlongPath 視情況改成 SLOWING / STOPPED
  }

  private fkey(floor: number, c: number, r: number) { return `${floor}:${cellKey(c, r)}`; }

  private rebuildOccupancy() {
    this.occupancy.clear();
    for (const id in this.state.robots) {
      const r = this.state.robots[id];
      const c = toCell(r.position[0], r.position[2]); this.occupancy.set(this.fkey(r.floor, c[0], c[1]), id);
      // 也預約下一格，避免兩台同時進入；斜向移動時連兩個正交鄰格一起預約（防止 X 形交叉擦撞）
      if (r.path_index < r.path.length) {
        const n = r.path[r.path_index]; if (!this.occupancy.has(this.fkey(r.floor, n[0], n[1]))) this.occupancy.set(this.fkey(r.floor, n[0], n[1]), id);
        if (n[0] !== c[0] && n[1] !== c[1]) { for (const k of [this.fkey(r.floor, n[0], c[1]), this.fkey(r.floor, c[0], n[1])]) if (!this.occupancy.has(k)) this.occupancy.set(k, id); }
      }
    }
  }
  /** 指定樓層的被佔用格（occupancy key 有樓層前綴，回傳時剝掉，餵給該樓層的 A*） */
  private blockedCells(selfId: string, floor: number): Set<string> {
    const s = new Set<string>();
    const pre = `${floor}:`;
    for (const [k, id] of this.occupancy) if (id !== selfId && k.startsWith(pre)) s.add(k.slice(pre.length));
    for (const zid of this.blockedZones) { const z = this.layout.zones.find((zz) => zz.id === zid); if (!z || (z.floor ?? 1) !== floor) continue; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); for (let c = Math.floor(Math.min(...xs)); c < Math.max(...xs); c++) for (let r = Math.floor(Math.min(...zs)); r < Math.max(...zs); r++) s.add(cellKey(c, r)); }
    return s;
  }
  private congestionCost(floor = 1): Float32Array | undefined {
    // 用該樓層的交通熱圖當額外成本，讓機器人自然分散到不同走道；注入的交通擁塞 zone 再加一層高成本
    const T = this.traffic[floor]; if (!T) return undefined;
    const out = new Float32Array(T.length);
    let max = 0; for (let i = 0; i < T.length; i++) if (T[i] > max) max = T[i];
    const zonesOnFloor = [...this.congestedZones.keys()].filter((zid) => (this.layout.zones.find((z) => z.id === zid)?.floor ?? 1) === floor);
    if (max < 1 && zonesOnFloor.length === 0) return undefined;
    if (max >= 1) for (let i = 0; i < out.length; i++) out[i] = (T[i] / max) * 0.8;
    for (const zid of zonesOnFloor) { const cz = this.congestedZones.get(zid)!; const z = this.layout.zones.find((zz) => zz.id === zid)!; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); for (let c = Math.floor(Math.min(...xs)); c < Math.max(...xs); c++) for (let r = Math.floor(Math.min(...zs)); r < Math.max(...zs); r++) out[r * this.grid.cols + c] += 3 * cz.level; }
    return out;
  }
  /** 注入的交通擁塞：zone 內速度上限比例 */
  private zoneSpeedFactor(cell: GridCell, floor: number): number {
    for (const [zid, cz] of this.congestedZones) { const z = this.layout.zones.find((zz) => zz.id === zid); if (!z || (z.floor ?? 1) !== floor) continue; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); if (cell[0] >= Math.min(...xs) && cell[0] < Math.max(...xs) && cell[1] >= Math.min(...zs) && cell[1] < Math.max(...zs)) return 1 - 0.7 * cz.level; }
    return 1;
  }
  private decayTraffic() {
    if (this.state.sim.tick % 5 !== 0) return;
    for (const f in this.traffic) { const T = this.traffic[f], TS = this.trafficShort[f]; for (let i = 0; i < T.length; i++) { T[i] *= 0.9985; TS[i] *= 0.975; } }
  }

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
  private zoneAt(x: number, z: number, floor = 1): string | null {
    for (const zn of this.layout.zones) { if ((zn.floor ?? 1) !== floor) continue; const xs = zn.polygon.map((p) => p[0]), zs = zn.polygon.map((p) => p[1]); if (x >= Math.min(...xs) && x <= Math.max(...xs) && z >= Math.min(...zs) && z <= Math.max(...zs)) return zn.id; }
    return null;
  }
  private updateZones() {
    const S = this.state;
    const counts: Record<string, number> = {};
    for (const id in S.robots) { const z = S.robots[id].zone; if (z) counts[z] = (counts[z] ?? 0) + 1; }
    for (const zid in S.zones) {
      const z = S.zones[zid]; z.robot_count = counts[zid] ?? 0;
      const cap = (this.layout.zones.find((zz) => zz.id === zid)?.floor ?? 1) === 2 ? SIM.ZONE_CAPACITY + 2 : SIM.ZONE_CAPACITY;
      z.congestion = Math.min(1, z.robot_count / cap);
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
    const lifts = Object.values(S.lifts);
    K.lifts = {
      trips: lifts.reduce((a, l) => a + l.trips, 0),
      utilization: S.sim.tick && lifts.length ? Math.round((lifts.reduce((a, l) => a + l.busy_ticks, 0) / (lifts.length * S.sim.tick)) * 1000) / 1000 : 0,
      avg_wait_s: (() => { const n = lifts.reduce((a, l) => a + l.wait_n, 0); return n ? Math.round((lifts.reduce((a, l) => a + l.wait_total_ticks, 0) / n) * SIM.TICK_S * 10) / 10 : 0; })(),
      faults: lifts.filter((l) => l.fault).length,
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
        case "LIFT_FAULT": {
          const L = S.lifts[inj.lift_id]; if (!L || L.fault) break;
          L.fault = true;
          L.fault_remaining = Math.max(0, L.until_tick - now);   // 凍結計時器：解除時從剩餘進度續跑，平台不瞬移
          // 尚未上車的預約/排隊者會在下個 tick 由 reRouteLift 改走另一座；已在轎廂者停在原地（不得瞬移）
          this.emit("LIFT_FAULT", "LIFT", L.occupant ? "CRITICAL" : "HIGH", `${inj.lift_id} FAULT${L.occupant ? ` — ${L.occupant} inside, platform stalled` : ""}`, { robot_id: L.occupant ?? undefined });
          this.raiseAlert(`lift-${inj.lift_id}`, L.occupant ? "CRITICAL" : "HIGH", `${inj.lift_id}  Fault`, L.occupant ? `Platform stalled with ${L.occupant} aboard` : "Out of service", {});
          break;
        }
        case "ROBOT_FAILURE": { const r = S.robots[inj.robot_id]; if (r) { this.setFsm(r, "OFFLINE"); r.velocity = 0; const t = r.current_task_id ? S.tasks[r.current_task_id] : null; if (t) { t.status = "TRANSFERRED"; t.completed_tick = now; const nt = this.createTask({ type: t.type, priority: "HIGH", source: t.source, destination: t.destination }); nt.parent_task_id = t.id; } r.current_task_id = null; r.path = []; this.releaseRobotFromLift(r.id); this.rt[r.id].pending = null; this.emit("ROBOT_OFFLINE", "USER", "CRITICAL", `${r.id} failure injected — OFFLINE`, { robot_id: r.id }); this.raiseAlert(`off-${r.id}`, "CRITICAL", `${r.id}  Offline`, "Robot failure", { robot_id: r.id }); } break; }
        case "ROBOT_BATTERY_SET": { const r = S.robots[inj.robot_id]; if (r) { r.battery = inj.battery; this.rt[r.id].lastBatteryAlert = "NONE"; } break; }
        case "CONVEYOR_FAILURE": { const c = S.conveyors[inj.conveyor_id]; if (c) { c.status = "ERROR"; c.speed_mps = 0; this.emit("CONVEYOR_STATUS_CHANGED", "CONVEYOR", "HIGH", `${inj.conveyor_id} failure — STOPPED`, { conveyor_id: c.id }); this.raiseAlert(`cv-${c.id}`, "HIGH", `Conveyor ${c.id}  Error`, "Throughput impact: HIGH", { conveyor_id: c.id }); } break; }
        case "CAMERA_OFFLINE": { const c = S.cameras[inj.camera_id]; if (c) { c.status = "OFFLINE"; S.subsystems.CCTV = "WARNING"; this.emit("CAMERA_STATUS_CHANGED", "CAMERA", "MEDIUM", `${c.id} offline`, { camera_id: c.id }); } break; }
        case "HUMAN_INTRUSION": {
          const z = this.layout.zones.find((zz) => zz.id === inj.zone_id); if (!z) break;
          const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
          const pid = `H-${inj.zone_id}-${now}`;
          S.people[pid] = { id: pid, kind: "WORKER", position: [(Math.min(...xs) + Math.max(...xs)) / 2, 0, Math.min(...zs) + 6.3], heading: 0, zone: inj.zone_id, floor: z.floor ?? 1, expires_tick: now + inj.duration_ticks };
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
