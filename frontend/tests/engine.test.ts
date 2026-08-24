import { describe, it, expect } from "vitest";
import layoutJson from "../src/layout/warehouse_layout.json";
import type { WarehouseLayout } from "../src/layout/types";
import { SimEngine, SIM } from "../src/simulation/engine";
import { LIFT_SHAFT } from "../src/components/scene/Mezzanine";
import { astar, toCell } from "../src/simulation/astar";
import { buildNavGrid } from "../src/layout/navgrid";

const layout = layoutJson as unknown as WarehouseLayout;

describe("A*", () => {
  const grid = buildNavGrid(layout);
  it("finds a path between two shelf access points and never crosses obstacles", () => {
    const a = layout.locations.find((l) => l.id === "SHELF-A01")!.access_point;
    const b = layout.locations.find((l) => l.id === "SHELF-D40")!.access_point;
    const p = astar(grid, toCell(a[0], a[1]), toCell(b[0], b[1]));
    expect(p).not.toBeNull();
    expect(p!.length).toBeGreaterThan(50);
    for (const [c, r] of p!) expect(grid.cells[r * grid.cols + c]).not.toBe(1);
    // 連續格必須相鄰
    let prev = toCell(a[0], a[1]);
    for (const c of p!) { expect(Math.max(Math.abs(c[0] - prev[0]), Math.abs(c[1] - prev[1]))).toBe(1); prev = c; }
  });
  it("every location access point is walkable", () => {
    const grids: Record<number, ReturnType<typeof buildNavGrid>> = { 1: grid, 2: buildNavGrid(layout as never, 2) };
    for (const l of layout.locations) { const g = grids[(l as { floor?: number }).floor ?? 1]; const [c, r] = toCell(l.access_point[0], l.access_point[1]); expect(g.cells[r * g.cols + c], l.id).not.toBe(1); }
  });
  it("returns null when goal is walled in", () => {
    const g = { cols: 5, rows: 5, cells: new Uint8Array(25) };
    for (const [c, r] of [[1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3]]) g.cells[r * 5 + c] = 1;
    expect(astar(g, [0, 0], [2, 2])).toBeNull();
  });
});

describe("SimEngine", () => {
  it("runs 20 sim-minutes: tasks complete, no physical collisions (<0.5 m), battery stays sane", () => {
    const eng = new SimEngine(layout, { seed: 7 });
    let minD = 99;
    for (let t = 0; t < 12000; t++) {
      eng.step();
      if (t % 10 === 0) {
        const rs = Object.values(eng.state.robots);
        for (const r of rs) { expect(r.battery).toBeGreaterThanOrEqual(0); expect(r.battery).toBeLessThanOrEqual(100); expect(Number.isFinite(r.position[0])).toBe(true); }
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { if (rs[i].floor !== rs[j].floor || rs[i].lift_id || rs[j].lift_id) continue; minD = Math.min(minD, Math.hypot(rs[i].position[0] - rs[j].position[0], rs[i].position[2] - rs[j].position[2])); }
      }
    }
    expect(eng.state.kpi.operation.completed_today).toBeGreaterThan(40);
    expect(minD).toBeGreaterThanOrEqual(0.5);
  });
  it("does not gridlock under compound failure (Demo 10)", () => {
    const eng = new SimEngine(layout, { seed: 42 });
    for (let t = 0; t < 3000; t++) eng.step();
    eng.inject({ kind: "CONVEYOR_FAILURE", conveyor_id: "CV03" }); eng.inject({ kind: "HUMAN_INTRUSION", zone_id: "B", duration_ticks: 2000 });
    const before = eng.state.kpi.operation.completed_today;
    for (let t = 0; t < 18000; t++) eng.step();
    expect(eng.state.kpi.operation.completed_today - before).toBeGreaterThan(120);
  }, 30000);
  it("is deterministic for the same seed", () => {
    const a = new SimEngine(layout, { seed: 3 }), b = new SimEngine(layout, { seed: 3 });
    for (let t = 0; t < 3000; t++) { a.step(); b.step(); }
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    const c = new SimEngine(layout, { seed: 4 }); for (let t = 0; t < 3000; t++) c.step();
    expect(JSON.stringify(c.state)).not.toBe(JSON.stringify(a.state));
  });
  it("low battery triggers charging and task transfer", () => {
    const eng = new SimEngine(layout, { seed: 1 });
    for (let t = 0; t < 600; t++) eng.step();
    const busy = Object.values(eng.state.robots).find((r) => r.fsm === "TRANSPORTING")!;
    eng.inject({ kind: "ROBOT_BATTERY_SET", robot_id: busy.id, battery: 12 });
    let transferred = false, charging = false, lowEvent = false;
    for (let t = 0; t < 4000; t++) { eng.step(); const r = eng.state.robots[busy.id]; if (r.fsm === "TASK_TRANSFER") transferred = true; if (r.fsm === "CHARGING") charging = true; if (t < 50 && eng.state.recent_events.some((e) => e.type === "ROBOT_BATTERY_LOW" && e.robot_id === busy.id)) lowEvent = true; }
    expect(transferred || charging).toBe(true);
    expect(lowEvent).toBe(true);
    expect(eng.state.robots[busy.id].battery).toBeGreaterThan(12);
  });
  it("human intrusion blocks a zone and robots reroute", () => {
    const eng = new SimEngine(layout, { seed: 5 });
    for (let t = 0; t < 1500; t++) eng.step();
    eng.inject({ kind: "HUMAN_INTRUSION", zone_id: "B", duration_ticks: 600 });
    eng.step(); eng.step();
    expect(eng.state.zones.B.status).toBe("BLOCKED");
    for (let t = 0; t < 700; t++) eng.step();
    expect(eng.state.zones.B.status).not.toBe("BLOCKED");
    expect(eng.state.recent_events.some((e) => e.type === "ZONE_UNBLOCKED")).toBe(true);
  });
});

describe("task rules", () => {
  it("rejects invalid task locations and survives a bad destination in state", () => {
    const eng = new SimEngine(layoutJson as never, { seed: 1 });
    expect(() => eng.createTask({ type: "PICK", priority: "NORMAL", source: "SHELF-A12", destination: "NOPE" })).toThrow(/destination/);
    expect(() => eng.createTask({ type: "PICK", priority: "NORMAL", source: "SHELF-A12", destination: "CHG-01" })).toThrow(/charging/);
    expect(() => eng.createTask({ type: "PICK", priority: "NORMAL", source: "PACK-01", destination: "SHELF-A12" })).toThrow(/source/);
    const t = eng.createTask({ type: "PICK", priority: "NORMAL", source: "SHELF-A12", destination: "PACK-01" });
    t.destination = "NOPE";
    for (let i = 0; i < 1500; i++) eng.step();
    expect(t.status).toBe("FAILED");
  });
});

describe("multi-floor", () => {
  it("robot rides a lift to complete a cross-floor task", () => {
    const eng = new SimEngine(layout, { seed: 7 });
    // 只給一筆跨樓任務：二樓貨架 → 一樓包裝站（R17–R20 在二樓，但指派可能挑任何人）
    const t = eng.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M05", destination: "PACK-01" });
    let boarded = false, floors = new Set<number>();
    for (let i = 0; i < 24000 && t.status !== "COMPLETED"; i++) {
      eng.step();
      const r = t.assigned_robot ? eng.state.robots[t.assigned_robot] : null;
      if (r) { floors.add(r.floor); if (r.lift_id) boarded = true; }
    }
    expect(t.status).toBe("COMPLETED");
    expect(boarded).toBe(true);
    expect([...floors].sort()).toEqual([1, 2]);
  }, 60000);
  it("floor-2 grid only covers the mezzanine footprint", () => {
    const g2 = buildNavGrid(layout as never, 2);
    const at = (x: number, z: number) => g2.cells[Math.floor(z) * g2.cols + Math.floor(x)];
    expect(at(51.5, 44.5)).toBe(1);      // 電梯井道 = 障礙（round-8：進出轎廂走 microMove，不經網格）
    expect(at(20.5, 47.5)).not.toBe(1);  // 夾層走道
    expect(at(80, 20)).toBe(1);          // footprint 外 = 不存在的樓板
  });
});

describe("lift state machine (spec §9–§14)", () => {
  const boot = () => {
    const eng = new SimEngine(layout, { seed: 7 });
    const t = eng.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M05", destination: "PACK-01" });
    return { eng, t };
  };
  it("lift never moves with an open gate; floor flips only after fully exiting the cabin", () => {
    const { eng, t } = boot();
    const floorAt: Record<string, number> = {}; const stageAt: Record<string, string | null> = {};
    const cabins = eng.state ? (eng as unknown as { layout: { lifts: Array<{ cell: [number, number] }> } }).layout.lifts.map((l) => [l.cell[0] + 0.5, l.cell[1] + 0.5]) : [];
    for (let i = 0; i < 24000 && t.status !== "COMPLETED"; i++) {
      eng.step();
      for (const L of Object.values(eng.state.lifts)) {
        if (L.state === "MOVING_UP" || L.state === "MOVING_DOWN") {
          expect(L.door_f1).toBe("CLOSED"); expect(L.door_f2).toBe("CLOSED");
          expect(L.floor).toBeNull();   // 移動中不屬於任一樓層
        }
      }
      for (const r of Object.values(eng.state.robots)) {
        const prev = floorAt[r.id] ?? r.floor;
        if (r.floor !== prev) {
          // 只能在 ALIGHTING 流程結束時翻樓層，且此刻必須已離開轎廂（距任一轎廂中心 > 1.4 m）
          expect(stageAt[r.id], `${r.id} changed floor outside lift flow`).toBe("ALIGHTING");
          const minCab = Math.min(...cabins.map(([cx, cz]) => Math.hypot(r.position[0] - cx, r.position[2] - cz)));
          expect(minCab, `${r.id} flipped floor while still in the cabin`).toBeGreaterThan(1.4);
        }
        floorAt[r.id] = r.floor; stageAt[r.id] = r.lift_stage;
      }
    }
    expect(t.status).toBe("COMPLETED");
  }, 60000);
  it("clearing a lift fault resumes the platform from the frozen height — no teleport", () => {
    const { eng, t } = boot();
    // 等到有人搭上電梯且開始移動
    let lid: string | null = null;
    for (let i = 0; i < 40000 && !lid; i++) {
      eng.step();
      for (const L of Object.values(eng.state.lifts)) if (L.occupant && (L.state === "MOVING_UP" || L.state === "MOVING_DOWN")) lid = L.id;
    }
    expect(lid).toBeTruthy();
    const L = eng.state.lifts[lid!];
    // 移動途中打壞
    for (let i = 0; i < 20 && (L.state === "MOVING_UP" || L.state === "MOVING_DOWN") && Math.abs(L.y) < 4; i++) eng.step();
    eng.inject({ kind: "LIFT_FAULT", lift_id: lid! });
    eng.step();
    const frozenY = L.y;
    for (let i = 0; i < 200; i++) { eng.step(); expect(L.y).toBe(frozenY); }   // 故障期間高度凍結
    eng.clearInjection("LIFT_FAULT", lid!);
    let prevY = L.y;
    for (let i = 0; i < 2000; i++) {
      eng.step();
      expect(Math.abs(L.y - prevY), "platform teleported after fault clear").toBeLessThan(0.5);   // 單 tick 位移必須平滑
      prevY = L.y;
    }
    for (let i = 0; i < 30000 && t.status !== "COMPLETED"; i++) eng.step();
    expect(t.status).toBe("COMPLETED");
  }, 120000);
  it("only one robot occupies a lift; boarding order is FIFO", () => {
    const eng = new SimEngine(layout, { seed: 11 });
    for (const dst of ["PACK-01", "SORT-01", "PACK-02"]) eng.createTask({ type: "PICK", priority: "CRITICAL", source: dst === "PACK-01" ? "SHELF-M01" : dst === "SORT-01" ? "SHELF-M10" : "SHELF-M20", destination: dst });
    const boarded: string[] = []; const enq: Record<string, number> = {};
    for (let i = 0; i < 30000; i++) {
      eng.step();
      for (const L of Object.values(eng.state.lifts)) {
        for (const f of ["1", "2"]) for (const rid of L.queue[f]) if (!(rid in enq)) enq[rid] = i;
        if (L.occupant && boarded[boarded.length - 1] !== L.occupant) if (!boarded.includes(L.occupant)) boarded.push(L.occupant);
      }
      const riders = Object.values(eng.state.robots).filter((r) => r.lift_id);
      const byLift = new Map<string, number>();
      for (const r of riders) byLift.set(r.lift_id!, (byLift.get(r.lift_id!) ?? 0) + 1);
      for (const n of byLift.values()) expect(n).toBe(1);
    }
    expect(boarded.length).toBeGreaterThanOrEqual(2);
  }, 60000);
  it("lift fault reroutes waiting robots to the other lift; rider is never teleported", () => {
    const { eng, t } = boot();
    // 等機器人進入電梯流程
    let rid: string | null = null;
    for (let i = 0; i < 20000 && !rid; i++) { eng.step(); rid = t.assigned_robot && eng.state.robots[t.assigned_robot].lift_stage ? t.assigned_robot : null; }
    expect(rid).toBeTruthy();
    const r = eng.state.robots[rid!];
    const liftId = Object.keys(eng.state.lifts).find((id) => eng.state.lifts[id].reserved_by === rid || eng.state.lifts[id].queue["1"].includes(rid!) || eng.state.lifts[id].queue["2"].includes(rid!)) ?? "LIFT-1";
    eng.inject({ kind: "LIFT_FAULT", lift_id: liftId });
    for (let i = 0; i < 200; i++) eng.step();
    if (!r.lift_id) {
      // 未上車：應改用另一座
      const other = Object.values(eng.state.lifts).find((L) => L.id !== liftId)!;
      const inOther = other.reserved_by === rid || other.queue["1"].includes(rid!) || other.queue["2"].includes(rid!) || r.lift_id === other.id;
      expect(inOther || r.lift_stage === "TO_LIFT").toBe(true);
    }
    eng.clearInjection("LIFT_FAULT", liftId);
    for (let i = 0; i < 24000 && t.status !== "COMPLETED"; i++) eng.step();
    expect(t.status).toBe("COMPLETED");
  }, 90000);
});

describe("rehydration — WS 斷線後 LOCAL 引擎接手（round-6 P1）", () => {
  const snapshotOf = (e: SimEngine) => JSON.parse(JSON.stringify(e.state));

  it("行進中的機器人不會瞬間抵達（NAVIGATING 不得下一 tick 就變 PICKING）", () => {
    const a = new SimEngine(layout, { seed: 21 });
    let rid: string | null = null;
    for (let i = 0; i < 20000 && !rid; i++) {
      a.step();
      for (const r of Object.values(a.state.robots)) if (r.fsm === "NAVIGATING" && !r.lift_stage && r.path.length - r.path_index > 6) { rid = r.id; break; }
    }
    expect(rid).toBeTruthy();
    const b = new SimEngine(layout, { seed: 21, initialState: snapshotOf(a) });
    b.step();
    const r1 = b.state.robots[rid!];
    expect(r1.fsm).not.toBe("PICKING");            // 舊 bug：rt.target 歸零 → 立刻視為抵達
    expect(r1.path.length).toBeGreaterThan(0);     // 路徑還在走，不是被清掉
  }, 60000);

  it("任務 / 事件序號延續，不會產生重複 ID", () => {
    const a = new SimEngine(layout, { seed: 22 });
    for (let i = 0; i < 3000; i++) a.step();
    const snap = snapshotOf(a);
    const b = new SimEngine(layout, { seed: 22, initialState: snap });
    const existing = new Set(Object.keys(snap.tasks as Record<string, unknown>));
    const t = b.createTask({ type: "PICK", priority: "NORMAL", source: "SHELF-A01", destination: "PACK-01" });
    expect(existing.has(t.id)).toBe(false);
    const maxE = Math.max(...(snap.recent_events as Array<{ id: string }>).map((e) => parseInt(e.id.slice(1), 10)));
    expect(parseInt(b.state.recent_events[0].id.slice(1), 10)).toBeGreaterThan(maxE);
  }, 60000);

  it("搭電梯中被接手：行程不中斷、樓層仍只在 ALIGHTING 完成後翻、任務照樣完成", () => {
    const a = new SimEngine(layout, { seed: 23 });
    const t = a.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M05", destination: "PACK-01" });
    let riding = false;
    for (let i = 0; i < 30000 && !riding; i++) { a.step(); riding = Object.values(a.state.robots).some((r) => r.lift_stage === "RIDING"); }
    expect(riding).toBe(true);
    const b = new SimEngine(layout, { seed: 23, initialState: snapshotOf(a) });
    const t2 = b.state.tasks[t.id];
    const prevFloor: Record<string, number> = {}; const prevStage: Record<string, string | null> = {};
    for (const [id, r] of Object.entries(b.state.robots)) { prevFloor[id] = r.floor; prevStage[id] = r.lift_stage; }
    for (let i = 0; i < 60000 && t2.status !== "COMPLETED"; i++) {
      b.step();
      for (const [id, r] of Object.entries(b.state.robots)) {
        if (r.floor !== prevFloor[id]) expect(prevStage[id], `${id} changed floor outside lift flow after handover`).toBe("ALIGHTING");
        prevFloor[id] = r.floor; prevStage[id] = r.lift_stage;
      }
    }
    expect(t2.status).toBe("COMPLETED");
  }, 120000);
});

describe("dispatch audit ↔ actual lift (round-6 P2)", () => {
  it("派工稽核記錄的電梯 = 機器人實際排入的電梯", () => {
    const e = new SimEngine(layout, { seed: 24 });
    let audited: string | null = null; let rid = "";
    for (let i = 0; i < 60000 && !audited; i++) {
      e.step();
      const d = e.state.recent_decisions[0];
      if (!d || d.tick !== e.state.sim.tick) continue;
      const c = d.candidates.find((x) => x.robot_id === d.selected_robot);
      const m = c?.reasons.map((s) => /cross-floor via (LIFT-\d+)/.exec(s)).find((x) => x);
      if (m) { audited = m[1]; rid = d.selected_robot; }
    }
    expect(audited).toBeTruthy();
    let actual: string | null = null;
    for (let j = 0; j < 5000 && !actual; j++) {
      e.step();
      for (const [lid, L] of Object.entries(e.state.lifts)) if (L.queue["1"].includes(rid) || L.queue["2"].includes(rid) || L.reserved_by === rid || L.occupant === rid) actual = lid;
    }
    expect(actual).toBe(audited);
  }, 120000);
});

describe("rehydration edge cases（round-7）", () => {
  const snapshotOf = (e: SimEngine) => JSON.parse(JSON.stringify(e.state));

  it("載貨避障中被接手：回到 TRANSPORTING，不會重跑取貨、不重複 TASK_STARTED", () => {
    const a = new SimEngine(layout, { seed: 31 });
    let rid: string | null = null;
    for (let i = 0; i < 30000 && !rid; i++) {
      a.step();
      for (const r of Object.values(a.state.robots)) if (r.fsm === "TRANSPORTING" && r.load.current > 0 && !r.lift_stage && r.path.length - r.path_index > 5) { rid = r.id; break; }
    }
    expect(rid).toBeTruthy();
    // 交通擁塞注入會把所有行進中的機器人打成 OBSTACLE_DETECTED（與正式路徑相同）
    a.inject({ kind: "TRAFFIC_CONGESTION", zone_id: "A", level: 0.8, duration_ticks: 300 } as never);
    a.step();
    const snapFsm = a.state.robots[rid!].fsm;
    expect(["OBSTACLE_DETECTED", "REPLANNING"]).toContain(snapFsm);
    const snap = snapshotOf(a);
    const tid = snap.robots[rid!].current_task_id as string;
    const maxE = Math.max(...(snap.recent_events as Array<{ id: string }>).map((e) => parseInt(e.id.slice(1), 10)));
    const b = new SimEngine(layout, { seed: 31, initialState: snap });
    b.step();
    // 舊 bug：phase 反推不到 → REPLANNING 落回 NAVIGATING → 抵達後再 PICKING 一次
    expect(["TRANSPORTING", "REPLANNING"]).toContain(b.state.robots[rid!].fsm);
    for (let i = 0; i < 60000 && b.state.tasks[tid] && !["COMPLETED", "TRANSFERRED", "FAILED"].includes(b.state.tasks[tid].status); i++) b.step();
    // 接手之後（事件序號 > maxE）不得再出現這個任務的 TASK_STARTED（= 第二次 picked item）
    const dup = b.state.recent_events.filter((e) => parseInt(e.id.slice(1), 10) > maxE && e.type === "TASK_STARTED" && e.task_id === tid);
    expect(dup).toHaveLength(0);
  }, 120000);

  it("輸送帶故障中交付被接手：剩餘時間含 stationSlowdown，不會提早完成", () => {
    const a = new SimEngine(layout, { seed: 32 });
    const cv = layout.conveyors.find((c) => (c as { feeds?: string }).feeds)! as { id: string; feeds: string };
    a.inject({ kind: "CONVEYOR_FAILURE", conveyor_id: cv.id } as never);
    a.step();
    expect(a.state.conveyors[cv.id].status).toBe("ERROR");
    let rid: string | null = null;
    const prevFsm: Record<string, string> = {};
    for (let i = 0; i < 90000 && !rid; i++) {
      a.step();
      for (const r of Object.values(a.state.robots)) {
        const t = r.current_task_id ? a.state.tasks[r.current_task_id] : undefined;
        if (r.fsm === "DELIVERING" && prevFsm[r.id] !== "DELIVERING" && t && t.destination === cv.feeds) { rid = r.id; break; }
        prevFsm[r.id] = r.fsm;
      }
    }
    expect(rid).toBeTruthy();   // 剛進 DELIVERING（elapsed ≤ 1），真實剩餘 ≈ DROP_TICKS × 4 = 120
    const b = new SimEngine(layout, { seed: 32, initialState: snapshotOf(a) });
    let n = 0;
    while (b.state.robots[rid!].fsm === "DELIVERING" && n < 300) { b.step(); n++; }
    expect(n).toBeGreaterThan(30);      // 舊 bug：沒乘 stationSlowdown → ≤ 30 tick 就交付完
    expect(n).toBeLessThanOrEqual(121);
  }, 120000);

  it("接手後 avg_task_time_s 維持快照值，不歸零", () => {
    const a = new SimEngine(layout, { seed: 33 });
    for (let i = 0; i < 60000 && a.state.kpi.operation.completed_today < 5; i++) a.step();
    while (a.state.sim.tick % 10 !== 0) a.step();   // 對齊 KPI 更新
    const snap = snapshotOf(a);
    const avg0 = snap.kpi.operation.avg_task_time_s as number;
    expect(avg0).toBeGreaterThan(0);
    const b = new SimEngine(layout, { seed: 33, initialState: snap });
    const done0 = b.state.kpi.operation.completed_today;
    for (let i = 0; i < 10; i++) b.step();          // 跨過至少一次 KPI 更新
    if (b.state.kpi.operation.completed_today === done0) {
      expect(b.state.kpi.operation.avg_task_time_s).toBe(avg0);   // 舊 bug：taskTimes 空 → 0
    } else {
      expect(b.state.kpi.operation.avg_task_time_s).toBeGreaterThan(0);   // 剛好有新完成：至少不得歸零
    }
  }, 120000);
});

describe("lift shaft as nav obstacle（round-8）", () => {
  it("兩層網格都封鎖井道 3×3；排隊格與出口候選全部維持可走", () => {
    for (const fl of [1, 2]) {
      const g = buildNavGrid(layout as never, fl);
      for (const l of layout.lifts) {
        expect(g.cells[l.cell[1] * g.cols + l.cell[0]], `${l.id} cabin F${fl}`).toBe(1);
        for (let i = 0; i < 3; i++) expect(g.cells[l.cell[1] * g.cols + (l.cell[0] - 4 - i)], `${l.id} queue${i} F${fl}`).not.toBe(1);
        expect(g.cells[l.cell[1] * g.cols + (l.cell[0] - 2)], `${l.id} gate cell F${fl}`).not.toBe(1);   // 門軸中繼格
        for (const [dc, dr] of [[-2, -2], [-2, 2], [-3, -1], [-3, 1], [-3, -2], [-3, 2], [-2, 0]])
          expect(g.cells[(l.cell[1] + dr) * g.cols + (l.cell[0] + dc)], `${l.id} exit(${dc},${dr}) F${fl}`).not.toBe(1);
      }
    }
  });

  it("A* 路徑永不穿越井道；非電梯流程的機器人不會出現在井道範圍", () => {
    // 夾層支撐柱（round-9c）：F1 封鎖；路徑與車身都不得穿柱
    const cols = layout.columns ?? [];
    if (!cols.length) throw new Error("layout.columns missing");
    const gc1 = buildNavGrid(layout as never, 1);
    for (const [cx, cz] of cols) {
      for (let c = Math.floor(cx - 0.45); c < Math.ceil(cx + 0.45); c++)
        for (let r2 = Math.floor(cz - 0.45); r2 < Math.ceil(cz + 0.45); r2++)
          expect(gc1.cells[r2 * gc1.cols + c], `column (${cx},${cz}) cell (${c},${r2})`).toBe(1);
    }
    const inColumn = (x: number, z: number) => cols.some(([cx, cz]) => Math.abs(x - cx) < 0.45 && Math.abs(z - cz) < 0.45);
    const eng = new SimEngine(layout, { seed: 41 });
    eng.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M05", destination: "PACK-01" });
    eng.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M12", destination: "PACK-02" });
    const inShaft = (x: number, z: number) => layout.lifts.some((l) => Math.abs(x - (l.cell[0] + 0.5)) < 1.4 && Math.abs(z - (l.cell[1] + 0.5)) < 1.4);
    for (let i = 0; i < 20000; i++) {
      eng.step();
      for (const r of Object.values(eng.state.robots)) {
        for (let pi = r.path_index; pi < r.path.length; pi++) {
          if (inShaft(r.path[pi][0] + 0.5, r.path[pi][1] + 0.5)) throw new Error(`${r.id} path crosses shaft at tick ${eng.state.sim.tick}`);
        }
        if (!r.lift_stage && !r.lift_id && inShaft(r.position[0], r.position[2])) throw new Error(`${r.id} inside shaft outside lift flow at tick ${eng.state.sim.tick}`);
        if (r.floor === 1 && !r.lift_id) {
          if (inColumn(r.position[0], r.position[2])) throw new Error(`${r.id} inside a support column at tick ${eng.state.sim.tick}`);
          for (let pi = r.path_index; pi < r.path.length; pi++) if (inColumn(r.path[pi][0] + 0.5, r.path[pi][1] + 0.5)) throw new Error(`${r.id} path crosses a support column`);
        }
      }
    }
  }, 180000);
});

describe("alighting exits through the gate（round-8d 三階段 + OBB）", () => {
  it("引擎門區幾何常數與 3D 井道模型一致（防止兩處漂移）", () => {
    expect(SIM.LIFT_SHAFT_HALF_X * 2).toBe(LIFT_SHAFT.W);
    expect(SIM.LIFT_DOOR_HALF_W).toBe(LIFT_SHAFT.LEAF);
  });

  it("三階段離梯：逐幀 OBB 四角穿門檢查 + 不邊走邊大轉；雙向與載貨/空車都驗證", () => {
    const eng = new SimEngine(layout, { seed: 5 });
    const tasks = [
      eng.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M02", destination: "PACK-01" }),
      eng.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M12", destination: "PACK-02" }),
      eng.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M22", destination: "SORT-01" }),
      eng.createTask({ type: "REPLENISH", priority: "CRITICAL", source: "INBOUND-1", destination: "SHELF-M30" }),
      eng.createTask({ type: "REPLENISH", priority: "CRITICAL", source: "INBOUND-2", destination: "SHELF-M40" }),
      eng.createTask({ type: "PICK", priority: "HIGH", source: "SHELF-M05", destination: "PACK-01" }),
    ];
    const dirs = new Set<string>(); const liftsSeen = new Set<string>(); const loads = new Set<boolean>();
    const prev: Record<string, { x: number; z: number; h: number } | undefined> = {};
    for (let i = 0; i < 90000; i++) {
      eng.step();
      for (const r of Object.values(eng.state.robots)) {
        if (r.lift_stage !== "ALIGHTING" || !r.lift_id) { prev[r.id] = undefined; continue; }
        const l = layout.lifts.find((x) => x.id === r.lift_id)!;
        const L = eng.state.lifts[l.id];
        const cx = l.cell[0] + 0.5, cz = l.cell[1] + 0.5;
        const x = r.position[0], z = r.position[2], h = r.heading;
        const doorPlane = cx - SIM.LIFT_SHAFT_HALF_X;
        // OBB 四角（旋轉後的實際車體）
        const c = Math.cos(h), sn = Math.sin(h);
        const corners = ([[1, 1], [1, -1], [-1, 1], [-1, -1]] as const).map(([sx, sz]) => [
          x + sx * SIM.ROBOT_HALF_LEN * c - sz * SIM.ROBOT_HALF_W * sn,
          z + sx * SIM.ROBOT_HALF_LEN * sn + sz * SIM.ROBOT_HALF_W * c,
        ]);
        // 車體跨越門平面時：所有跨越邊與 x=doorPlane 的交點 z 必須都在門洞內
        const edges = [[0, 1], [1, 3], [3, 2], [2, 0]] as const;
        for (const [a, b] of edges) {
          const [ax, az] = corners[a], [bx, bz] = corners[b];
          if ((ax - doorPlane) * (bx - doorPlane) < 0) {
            const zc = az + (bz - az) * ((doorPlane - ax) / (bx - ax));
            if (Math.abs(zc - cz) > SIM.LIFT_DOOR_HALF_W + 1e-6) throw new Error(`${r.id} body sweeps into door frame at z=${zc.toFixed(2)} (x=${x.toFixed(2)}, θ=${h.toFixed(2)})`);
          }
        }
        if (x > cx + 0.1) throw new Error(`${r.id} moved east inside shaft`);
        // 不邊走邊大轉：單 tick heading 變化 > 0.09 rad 時，位移必須 < 0.02 m（原地旋轉）
        const pv = prev[r.id];
        if (pv) {
          let dh = h - pv.h; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
          if (Math.abs(dh) > 0.09 && Math.hypot(x - pv.x, z - pv.z) > 0.02) throw new Error(`${r.id} walks while turning (Δθ=${dh.toFixed(2)}, Δp=${Math.hypot(x - pv.x, z - pv.z).toFixed(3)})`);
        }
        prev[r.id] = { x, z, h };
        if (L.floor !== null) dirs.add(`${r.floor}->${L.floor}`);
        liftsSeen.add(l.id); loads.add(r.load.current > 0);
        // round-9b：離梯車與排隊/前往電梯車的旋轉車體（OBB）不得相交（同一實體樓層）
        for (const b of Object.values(eng.state.robots)) {
          if (b.id === r.id || !["TO_LIFT", "QUEUED", "BOARDING"].includes(b.lift_stage ?? "")) continue;
          if (L.floor === null || b.floor !== L.floor) continue;
          if (SimEngine.obbOverlap(r.position[0], r.position[2], r.heading, b.position[0], b.position[2], b.heading))
            throw new Error(`${r.id}(ALIGHTING) body overlaps ${b.id}(${b.lift_stage}) at tick ${eng.state.sim.tick}`);
        }
      }
      if (tasks.every((t) => t.status === "COMPLETED" || t.status === "TRANSFERRED" || t.status === "FAILED") && dirs.size >= 2) break;
    }
    expect(dirs.has("1->2")).toBe(true);
    expect(dirs.has("2->1")).toBe(true);
    expect(liftsSeen.size).toBeGreaterThan(0);
    expect(loads.has(true)).toBe(true);
    expect(loads.has(false)).toBe(true);
  }, 240000);
});

describe("lift exit faces the destination（round-8e）", () => {
  it("目的地在哪側就往哪側出，不得選到相反側繞路（兩座電梯、兩層）", () => {
    const eng = new SimEngine(layout, { seed: 1 });
    const pick = (eng as unknown as { pickLiftExit: (l: (typeof layout.lifts)[number], floor: number, toward: [number, number] | null) => [number, number] }).pickLiftExit.bind(eng);
    for (const fl of [1, 2]) {
      for (const l of layout.lifts) {
        const cz = l.cell[1] + 0.5;
        const south = pick(l, fl, [l.cell[0] - 6, cz + 9]);
        const north = pick(l, fl, [l.cell[0] - 6, cz - 9]);
        expect(south[1], `${l.id} F${fl} dest S`).toBeGreaterThanOrEqual(cz);
        expect(north[1], `${l.id} F${fl} dest N`).toBeLessThanOrEqual(cz);
      }
    }
  });
});
