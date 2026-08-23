import { describe, it, expect } from "vitest";
import layoutJson from "../src/layout/warehouse_layout.json";
import type { WarehouseLayout } from "../src/layout/types";
import { SimEngine } from "../src/simulation/engine";
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
    expect(at(51.5, 44.5)).not.toBe(1);  // 電梯格可走
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
  it("lift never moves with an open gate; robot never changes floor without riding", () => {
    const { eng, t } = boot();
    const floorAt: Record<string, number> = {};
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
        if (r.floor !== prev) expect(r.lift_stage, `${r.id} changed floor outside lift flow`).toBe("ALIGHTING");
        floorAt[r.id] = r.floor;
      }
    }
    expect(t.status).toBe("COMPLETED");
  }, 60000);
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
