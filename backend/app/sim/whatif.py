"""
What-if Simulation（規格 1️⃣7️⃣ / Demo 08）

  Baseline ──clone──▶ 跑 N tick ──▶ KPI_b
  LIVE state ─┤
  Scenario ──clone──▶ 注入 ──▶ 跑 N tick ──▶ KPI_s      →  delta / key events / AI recommendation

兩個 clone 都從同一個 tick、同一個亂數狀態出發，所以差異只來自注入本身（確定性引擎的價值就在這裡）。
LIVE 引擎完全不受影響。

round-10（社群回饋）：
  A1 多 seed ensemble（Vijay）——ensemble_seeds > 1 時額外跑 N−1 對 clone，每對把兩台引擎
     重設成同一顆「衍生 seed」（由 start_tick 與 pair 序號決定，整個結果仍可重現），
     對每項 KPI 回報 Δ 的 min／median／max。第 0 對維持原亂數流，headline 欄位行為與舊版
     完全相同。範圍量化的是「模型內部隨機變異」，不是真實世界的不確定性。
  A3 事件流分岔（mohsen）——第 0 對是同亂數對，兩條事件流在注入前逐筆相同；
     濾掉 SCENARIO_INJECTED 標記後找第一個不一致的事件（= 第一個分岔點），
     並回報各事件型別的數量差，讓延遲/連鎖反應可以被指認而不是消失在平均值裡。
"""
from __future__ import annotations

import os
import time
from typing import Any, Callable

from .engine import SimEngine, mulberry32

MAX_SIG = 4000                      # 每條事件流簽章的上限（分岔幾乎都發生在注入當下，遠低於此）
ENSEMBLE_MAX = 5                    # ensemble 上限（免費方案算力）
ENSEMBLE_BUDGET_TICKS = 9000        # ensemble > 1 時 seeds × duration 的上限（每側）：3 seeds → 5 分鐘、5 seeds → 3 分鐘


class WhatIfBusy(Exception):
    """同時只允許一個 What-if 在跑；忙碌時呼叫端應立即回 BUSY（WS ERROR / REST 503），不排隊。"""


def ensemble_duration_cap(seeds: int) -> int:
    """ensemble 時單次時長上限（tick）。seeds=1 不設限（沿用 6000）。前端下拉選單用同一條規則。"""
    return 6000 if seeds <= 1 else max(300, ENSEMBLE_BUDGET_TICKS // seeds)

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


def _window_kpi(eng: SimEngine, start_tick: int, start_completed: int, start_wait: float, start_energy: float, duration: int, counts: dict[str, int]) -> dict[str, Any]:
    S = eng.state; K = S["kpi"]; robots = list(S["robots"].values())
    completed = eng.completed_count - start_completed
    minutes = max(1e-9, duration / 600)
    done = [t for t in S["tasks"].values() if t["status"] == "COMPLETED" and t["completed_tick"] is not None and t["completed_tick"] > start_tick]
    avg_task = (sum(t["completed_tick"] - t["created_tick"] for t in done) / len(done) / 10) if done else 0
    on_time = (sum(1 for t in done if t["deadline_tick"] is None or t["completed_tick"] <= t["deadline_tick"]) / len(done)) if done else 1.0
    wait_total = sum(r["stats"]["wait_ticks"] for r in robots)
    energy = sum(r["stats"]["energy_wh"] for r in robots)
    return {
        "completed": completed,
        "throughput_per_min": round(completed / minutes, 2),
        "avg_task_time_s": round(avg_task, 1),
        "on_time_rate": round(on_time, 3),
        "avg_wait_s": round((wait_total - start_wait) / len(robots) / 10, 1),
        "utilization": round(K["operation"]["avg_utilization"], 3),
        "congestion_index": K["efficiency"]["congestion_index"],
        "replans": counts.get("ROUTE_REPLANNED", 0),     # 從整段 run 的事件流計數，不受 500 筆 ring 限制
        "transfers": counts.get("TASK_TRANSFERRED", 0),
        "energy_kwh": round((energy - start_energy) / 1000, 3),
        "robots_offline": sum(1 for r in robots if r["status"] in ("OFFLINE", "ERROR")),
        "pending_end": K["operation"]["pending"],
    }


def _run(eng: SimEngine, injections: list[dict[str, Any]], duration: int) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any], dict[str, int], list[tuple[int, str, str]]]:
    start_tick = eng.state["sim"]["tick"]
    start_completed = eng.completed_count
    start_wait = sum(r["stats"]["wait_ticks"] for r in eng.state["robots"].values())
    start_energy = sum(r["stats"]["energy_wh"] for r in eng.state["robots"].values())
    eng.state["sim"]["mode"] = "WHATIF"
    for inj in injections:
        eng.inject(inj)
    events: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    sig: list[tuple[int, str, str]] = []   # 事件流簽章 (tick, type, message)：A3 分岔比對用
    for _ in range(duration):
        eng.step()
        if eng.new_events:
            for e in eng.new_events:
                counts[e["type"]] = counts.get(e["type"], 0) + 1
                if len(sig) < MAX_SIG:
                    sig.append((e["tick"], e["type"], e["message"]))
                if e["severity"] in ("MEDIUM", "HIGH", "CRITICAL"):
                    events.append(e)
            eng.new_events = []
    eng._update_kpi()
    return _window_kpi(eng, start_tick, start_completed, start_wait, start_energy, duration, counts), events, eng.state["kpi"], counts, sig


def _range(values: list[float]) -> dict[str, float]:
    v = sorted(values)
    n = len(v)
    med = v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2
    return {"min": round(v[0], 3), "median": round(med, 3), "max": round(v[-1], 3)}


def _fmt_ev(e: tuple[int, str, str]) -> dict[str, Any]:
    return {"tick": e[0], "type": e[1], "message": e[2]}


def _event_diff(base_sig: list[tuple[int, str, str]], scen_sig: list[tuple[int, str, str]],
                base_counts: dict[str, int], scen_counts: dict[str, int], end_tick: int) -> dict[str, Any]:
    """A3：同亂數對的兩條事件流「按 tick 分組」比對（不能按陣列索引——注入後 scenario 多一筆，
    之後所有索引都錯位，會把不相干的 baseline 事件配成對照）。注入前兩條流位元級相同（決定性），
    濾掉 SCENARIO_INJECTED 標記後，第一個兩邊事件多重集合不一致的 tick 就是分岔點；
    回報該 tick「只在 scenario 出現」與「只在 baseline 出現」的事件（可為空 = 該側無事件）。
    簽章有上限（MAX_SIG）：只在兩邊都完整記錄到的 tick 範圍內比較；若截斷前沒找到分岔，
    complete=False，不能宣稱兩條流相同。"""
    scen_f = [e for e in scen_sig if e[1] != "SCENARIO_INJECTED"]
    b_trunc = len(base_sig) >= MAX_SIG
    s_trunc = len(scen_sig) >= MAX_SIG
    # 截斷的那一側，最後一個 tick 可能只記到一半 → 只比到「最後完整 tick − 1」
    covered = end_tick
    if b_trunc: covered = min(covered, base_sig[-1][0] - 1)
    if s_trunc: covered = min(covered, scen_sig[-1][0] - 1)
    by_tick_b: dict[int, list[tuple[int, str, str]]] = {}
    by_tick_s: dict[int, list[tuple[int, str, str]]] = {}
    for e in base_sig:
        if e[0] <= covered: by_tick_b.setdefault(e[0], []).append(e)
    for e in scen_f:
        if e[0] <= covered: by_tick_s.setdefault(e[0], []).append(e)
    first = None
    for t in sorted(set(by_tick_b) | set(by_tick_s)):
        b = sorted(by_tick_b.get(t, []))
        s = sorted(by_tick_s.get(t, []))
        if b != s:
            # 多重集合差：只在一側出現的事件（同 tick 兩邊都有的相同事件不算分岔）
            b_rest, s_only = list(b), []
            for e in s:
                if e in b_rest: b_rest.remove(e)
                else: s_only.append(e)
            first = {"tick": t, "scenario": [_fmt_ev(e) for e in s_only], "baseline": [_fmt_ev(e) for e in b_rest]}
            break
    keys = (set(base_counts) | set(scen_counts)) - {"SCENARIO_INJECTED"}
    deltas = [{"type": k, "delta": scen_counts.get(k, 0) - base_counts.get(k, 0)} for k in keys]
    deltas = sorted((d for d in deltas if d["delta"] != 0), key=lambda d: (-abs(d["delta"]), d["type"]))
    return {
        "first_divergence": first,
        "event_count_delta": deltas[:12],
        "compared_until_tick": covered,
        "complete": not (b_trunc or s_trunc) or first is not None,   # 找到分岔 → 結論成立；沒找到又截斷 → 不能說相同
    }


def run_whatif(base_eng: SimEngine, scen_eng: SimEngine, request: dict[str, Any], start_tick: int,
               extra_pairs: list[tuple[SimEngine | None, SimEngine]] | None = None,
               progress: Callable[[int, int], None] | None = None) -> dict[str, Any]:
    """跑 What-if。呼叫端必須在主 event loop 上先把 live 引擎 clone 好再傳進來（避免與模擬迴圈同時讀寫）；
    本函式只碰這些獨立 clone，可安全放在 worker thread。
    extra_pairs（A1 ensemble）：seeds 1..N−1 的 (baseline, scenario) 對；每對兩台引擎會被重設成
    同一顆衍生 seed（由 start_tick 與 pair 序號決定 → 整個結果可重現），pair 內的差異仍只來自注入。
    progress(done, total)：每跑完一對呼叫一次（worker thread 上），讓伺服器推進度給前端。"""
    extra_pairs = extra_pairs or []
    total_pairs = 1 + len(extra_pairs)
    duration = int(request.get("duration_ticks", 600))
    duration = max(50, min(duration, ensemble_duration_cap(total_pairs)))
    injections = [dict(i) for i in request.get("injections", [])]
    for i in injections:
        i.pop("at_tick", None)
    run_baseline = bool(request.get("run_baseline", True))
    t0 = time.perf_counter()
    base_win, _, base_kpi, base_counts, base_sig = _run(base_eng, [], duration) if run_baseline else (None, [], None, {}, [])
    scen_win, scen_events, scen_kpi, scen_counts, scen_sig = _run(scen_eng, injections, duration)
    if progress: progress(1, total_pairs)

    # A1：其餘 seed 對（重設亂數 → 同起始狀態、不同隨機流）
    scen_wins = [scen_win]
    deltas_all: list[dict[str, float]] = []
    for idx, (b_eng, s_eng) in enumerate(extra_pairs, start=1):
        seed_i = (start_tick * 2654435761 + idx * 1013904223) & 0xFFFFFFFF
        if b_eng is not None:
            b_eng.rng = mulberry32(seed_i)
        s_eng.rng = mulberry32(seed_i)
        b_win_i = _run(b_eng, [], duration)[0] if (run_baseline and b_eng is not None) else None
        s_win_i = _run(s_eng, injections, duration)[0]
        scen_wins.append(s_win_i)
        if b_win_i:
            deltas_all.append({k: round(s_win_i[k] - b_win_i[k], 3) for k, _, _ in METRICS})
        if progress: progress(idx + 1, total_pairs)
    elapsed = time.perf_counter() - t0

    delta: dict[str, float] = {}
    if base_win:
        for k, _, _ in METRICS:
            delta[k] = round(scen_win[k] - base_win[k], 3)
        deltas_all.insert(0, delta)
    rec = recommendation(request, base_win, scen_win, delta)
    result = {
        "request": {"scenario_name": request.get("scenario_name", "scenario"), "injections": injections, "duration_ticks": duration, "run_baseline": run_baseline,
                    "ensemble_seeds": 1 + len(extra_pairs)},
        "baseline_kpi": base_kpi or scen_kpi,
        "scenario_kpi": scen_kpi,
        "delta": delta,
        "key_events": scen_events[:40],
        "ai_recommendation": rec,
        # 補充（schema 之外，前端對照表用）
        "window": {"baseline": base_win, "scenario": scen_win, "metrics": [{"key": k, "label": l, "higher_is_better": h} for k, l, h in METRICS]},
        "start_tick": start_tick,
        "compute_ms": round(elapsed * 1000),
    }
    if extra_pairs:
        result["ensemble"] = {
            "seeds_run": 1 + len(extra_pairs),
            "scenario_range": {k: _range([w[k] for w in scen_wins]) for k, _, _ in METRICS},
            **({"delta_range": {k: _range([d[k] for d in deltas_all]) for k, _, _ in METRICS}} if deltas_all else {}),
        }
    if run_baseline:
        result["event_diff"] = _event_diff(base_sig, scen_sig, base_counts, scen_counts, start_tick + duration)
    return result


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
