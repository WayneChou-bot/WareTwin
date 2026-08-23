import { describe, it, expect } from "vitest";
import { SimEngine } from "../src/simulation/engine";
import layoutJson from "../src/layout/warehouse_layout.json";
const layout = layoutJson as never;

describe("lift lobby congestion (下電梯與排隊互卡修正)", () => {
  it("many cross-floor tasks in both directions all complete; nobody starves at the lobby", () => {
    const eng = new SimEngine(layout, { seed: 5 });
    const tasks = [
      eng.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M02", destination: "PACK-01" }),
      eng.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M12", destination: "PACK-02" }),
      eng.createTask({ type: "PICK", priority: "CRITICAL", source: "SHELF-M22", destination: "SORT-01" }),
      eng.createTask({ type: "REPLENISH", priority: "CRITICAL", source: "INBOUND-1", destination: "SHELF-M30" }),
      eng.createTask({ type: "REPLENISH", priority: "CRITICAL", source: "INBOUND-2", destination: "SHELF-M40" }),
      eng.createTask({ type: "PICK", priority: "HIGH", source: "SHELF-M05", destination: "PACK-01" }),
    ];
    // 追蹤每台機器人在電梯流程中「原地不動」的連續 tick 數
    const still: Record<string, number> = {}; const lastPos: Record<string, [number, number]> = {};
    let maxStill = 0;
    for (let i = 0; i < 90000 && !tasks.every((t) => ["COMPLETED", "TRANSFERRED", "FAILED"].includes(t.status)); i++) {
      eng.step();
      for (const r of Object.values(eng.state.robots)) {
        if (!r.lift_stage || r.lift_stage === "RIDING") { still[r.id] = 0; lastPos[r.id] = [r.position[0], r.position[2]]; continue; }
        const lp = lastPos[r.id] ?? [0, 0];
        const moved = Math.hypot(r.position[0] - lp[0], r.position[2] - lp[1]) > 0.02;
        still[r.id] = moved ? 0 : (still[r.id] ?? 0) + 1;
        lastPos[r.id] = [r.position[0], r.position[2]];
        maxStill = Math.max(maxStill, still[r.id]);
        // ALIGHTING / BOARDING 絕不允許卡超過 60 秒
        if (r.lift_stage === "ALIGHTING" || r.lift_stage === "BOARDING") expect(still[r.id], `${r.id} stuck in ${r.lift_stage}`).toBeLessThan(600);
      }
    }
    for (const t of tasks) expect(t.status).toBe("COMPLETED");
  }, 300000);
});
