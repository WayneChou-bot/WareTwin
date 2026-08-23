import { describe, it, expect } from "vitest";
import { SimEngine, SIM } from "../src/simulation/engine";
import layoutJson from "../src/layout/warehouse_layout.json";
describe("perception", () => {
  it("keeps following robots >= PERC_STOP apart and reports obstacles", () => {
    const eng = new SimEngine(layoutJson as never, { seed: 42 });
    let minD = 9, stops = 0, slows = 0, seen = 0;
    for (let t = 0; t < 6000; t++) {
      eng.step();
      const rs = Object.values(eng.state.robots);
      for (const r of rs) { if (r.perception.state === "STOPPED") stops++; if (r.perception.state === "SLOWING") slows++; if (r.perception.obstacles.length) seen++; }
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const a = rs[i], b = rs[j]; if (a.floor !== b.floor || a.lift_id || b.lift_id) continue; const d = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]); if (d < minD) minD = d; }
    }
    console.log({ minD, stops, slows, seen, completed: eng.state.kpi.operation.completed_today, events: eng.state.recent_events.filter(e => e.message.includes("LiDAR")).length });
    expect(seen).toBeGreaterThan(0); expect(stops + slows).toBeGreaterThan(0);
    expect(minD).toBeGreaterThanOrEqual(0.5);
  });
});
