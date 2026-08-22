"""
What-if Simulation（規格 1️⃣7️⃣ / Demo 08）

  Baseline ──clone──▶ 跑 N tick ──▶ KPI_b
  LIVE state ─┤
  Scenario ──clone──▶ 注入 ──▶ 跑 N tick ──▶ KPI_s      →  delta / key events / AI recommendation

兩個 clone 都從同一個 tick、同一個亂數狀態出發，所以差異只來自注入本身（確定性引擎的價值就在這裡）。
LIVE 引擎完全不受影響。
"""
from __future__ import annotations

import os
import time
from typing import Any

from .engine import SimEngine

METRICS = [
    # key, label, higher_is_better
    ("completed", "Tasks completed", True),
    ("throughput_per_min", "Throughput (tasks/min)", True),
    ("avg_task_time_s", "Avg task time (s)", False),
    ("on_time_rate", "On-time rate", True),
    ("avg_wait_s", "Avg wait per robot (s)", False),
    ("utilization", "Utilization", True),
    ("congestion_index", "Congestion index", False),
    ("replans", "Route replans", False),
    ("transfers", "Task transfers", False),
    ("energy_kwh", "Energy (kWh)", False),
    ("robots_offline", "Robots offline/error", False),
    ("pending_end", "Pending tasks at end", False),
]


def _window_kpi(eng: SimEngine, start_tick: int, start_completed: int, start_wait: float, start_energy: float, duration: int) -> dict[str, Any]:
    S = eng.state; K = S["kpi"]; robots = list(S["robots"].values())
    completed = eng.completed_count - start_completed
    minutes = max(1e-9, duration / 600)
    done = [t for t in S["tasks"].values() if t["status"] == "COMPLETED" and t["completed_tick"] is not None and t["completed_tick"] > start_tick]
    avg_task = (sum(t["completed_tick"] - t["created_tick"] for t in done) / len(done) / 10) if done else 0
    on_time = (sum(1 for t in done if t["deadline_tick"] is None or t["completed_tick"] <= t["deadline_tick"]) / len(done)) if done else 1.0
    wait_total = sum(r["stats"]["wait_ticks"] for r in robots)
    energy = sum(r["stats"]["energy_wh"] for r in robots)
    ev = S["recent_events"]
    return {
        "completed": completed,
        "throughput_per_min": round(completed / minutes, 2),
        "avg_task_time_s": round(avg_task, 1),
        "on_time_rate": round(on_time, 3),
        "avg_wait_s": round((wait_total - start_wait) / len(robots) / 10, 1),
        "utilization": round(K["operation"]["avg_utilization"], 3),
        "congestion_index": K["efficiency"]["congestion_index"],
        "replans": sum(1 for e in ev if e["type"] == "ROUTE_REPLANNED" and e["tick"] > start_tick),
        "transfers": sum(1 for e in ev if e["type"] == "TASK_TRANSFERRED" and e["tick"] > start_tick),
        "energy_kwh": round((energy - start_energy) / 1000, 3),
        "robots_offline": sum(1 for r in robots if r["status"] in ("OFFLINE", "ERROR")),
        "pending_end": K["operation"]["pending"],
    }


def _run(eng: SimEngine, injections: list[dict[str, Any]], duration: int) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    start_tick = eng.state["sim"]["tick"]
    start_completed = eng.completed_count
    start_wait = sum(r["stats"]["wait_ticks"] for r in eng.state["robots"].values())
    start_energy = sum(r["stats"]["energy_wh"] for r in eng.state["robots"].values())
    eng.state["sim"]["mode"] = "WHATIF"
    for inj in injections:
        eng.inject(inj)
    events: list[dict[str, Any]] = []
    for _ in range(duration):
        eng.step()
        if eng.new_events:
            events.extend(e for e in eng.new_events if e["severity"] in ("MEDIUM", "HIGH", "CRITICAL"))
            eng.new_events = []
    eng._update_kpi()
    return _window_kpi(eng, start_tick, start_completed, start_wait, start_energy, duration), events, eng.state["kpi"]


def run_whatif(live: SimEngine, request: dict[str, Any]) -> dict[str, Any]:
    duration = int(request.get("duration_ticks", 600))
    duration = max(50, min(duration, 6000))
    injections = [dict(i) for i in request.get("injections", [])]
    for i in injections:
        i.pop("at_tick", None)
    t0 = time.perf_counter()
    base_eng = live.clone()
    scen_eng = live.clone()
    base_win, _, base_kpi = _run(base_eng, [], duration) if request.get("run_baseline", True) else (None, [], None)
    scen_win, scen_events, scen_kpi = _run(scen_eng, injections, duration)
    elapsed = time.perf_counter() - t0

    delta: dict[str, float] = {}
    if base_win:
        for k, _, _ in METRICS:
            delta[k] = round(scen_win[k] - base_win[k], 3)
    rec = recommendation(request, base_win, scen_win, delta)
    return {
        "request": {"scenario_name": request.get("scenario_name", "scenario"), "injections": injections, "duration_ticks": duration, "run_baseline": bool(base_win)},
        "baseline_kpi": base_kpi or scen_kpi,
        "scenario_kpi": scen_kpi,
        "delta": delta,
        "key_events": scen_events[:40],
        "ai_recommendation": rec,
        # 補充（schema 之外，前端對照表用）
        "window": {"baseline": base_win, "scenario": scen_win, "metrics": [{"key": k, "label": l, "higher_is_better": h} for k, l, h in METRICS]},
        "start_tick": live.state["sim"]["tick"],
        "compute_ms": round(elapsed * 1000),
    }


def recommendation(request: dict[str, Any], base: dict[str, Any] | None, scen: dict[str, Any], delta: dict[str, float]) -> str:
    kinds = [i["kind"] for i in request.get("injections", [])]
    if not base:
        return f"Scenario ran {scen['completed']} tasks at {scen['throughput_per_min']} tasks/min (no baseline requested)."
    pct = lambda k: (delta[k] / base[k] * 100) if base.get(k) else 0.0
    parts = []
    tp = pct("throughput_per_min")
    parts.append(f"Throughput {tp:+.0f}% ({base['throughput_per_min']} → {scen['throughput_per_min']} tasks/min), avg task time {delta['avg_task_time_s']:+.0f} s, waiting {delta['avg_wait_s']:+.0f} s/robot, replans {delta['replans']:+.0f}.")
    if "ROBOT_FAILURE" in kinds:
        parts.append("Losing one robot is absorbed by the fleet if throughput drops < 10%; otherwise schedule maintenance when the pending queue is short.")
    if "CONVEYOR_FAILURE" in kinds:
        parts.append("Conveyor failure is the dominant cost: unloading ×4 at the fed station creates a queue. Pre-position a manual unloading crew or re-route PICK tasks to the other packing station.")
    if "HUMAN_INTRUSION" in kinds:
        parts.append("Zone blocking mostly adds travel distance; keep walkways outside robot aisles and shorten the blocked window with faster VLM clearance.")
    if "TRAFFIC_CONGESTION" in kinds:
        parts.append("Speed limits hurt less than blocking; the traffic-weighted A* spreads load, so congestion stays local.")
    if "TASK_BURST" in kinds:
        parts.append("A burst raises pending depth but completes within the window if utilization was < 80% before.")
    text = " ".join(parts)
    # LLM 版（可選）：兩句話的建議
    if os.environ.get("OPENAI_API_KEY"):
        try:
            from ..ai.copilot import _client
            client = _client()
            if client:
                resp = client.chat.completions.create(
                    model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"), temperature=0.2, max_tokens=160,
                    messages=[{"role": "system", "content": "You are a warehouse operations analyst. Given a what-if simulation comparison, write 2 concise sentences: the impact, then the single most useful mitigation. Plain text."},
                              {"role": "user", "content": f"Scenario: {kinds}. Baseline: {base}. Scenario result: {scen}. Delta: {delta}."}],
                )
                llm = (resp.choices[0].message.content or "").strip()
                if llm:
                    return llm
        except Exception:
            pass
    return text
