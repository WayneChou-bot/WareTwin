"""
AI Operations Copilot（規格 1️⃣6️⃣）

  question + summarize_state(TwinState) → LLM (OpenAI, structured output) → {text, citations[]}

- 有 OPENAI_API_KEY：用 OpenAI Chat Completions，回覆強制 JSON schema，引用只能是摘要裡出現過的 id（事件 E…、機器人 R…、任務 A…、決策 D…）。
- 沒有 key（或呼叫失敗）：退回規則式分析 rule_based_answer()，讓 Demo 09 在離線時也有合理回答。
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from .context import summarize_state

SYSTEM_PROMPT = """You are the AI Operations Copilot of an autonomous warehouse digital twin (20 AMRs, 4 zones A-D, 3 conveyors, packing/sorting stations, 6 chargers).
You receive a JSON snapshot of the live twin state and a question from the operations manager.
Rules:
- Answer from the snapshot only. Never invent robots, tasks, zones or numbers that are not in it.
- Be concrete and quantitative: name robots (R03), tasks (A3812), zones, conveyors, and cite KPI values.
- Explain causality (e.g. "Conveyor CV03 ERROR → Packing 01 unload ×4 → 5 robots queueing in Zone D → throughput -38%").
- Recommend at most 3 actions, each one line, most impactful first.
- If asked which robot should take a task, score candidates by distance, battery, workload, congestion (same weights as the Fleet Manager: 0.35/0.25/0.15/0.15/0.10 health) and say why the others lose.
- Keep it under 180 words. Plain text with short paragraphs; no markdown headers.
- citations: list every id you relied on (event ids like E123, robot ids, task ids, decision ids, alert ids). Only ids present in the snapshot."""

REPLY_SCHEMA = {
    "name": "copilot_reply",
    "schema": {
        "type": "object",
        "properties": {
            "text": {"type": "string"},
            "citations": {"type": "array", "items": {"type": "string"}},
            "confidence": {"type": "number"},
        },
        "required": ["text", "citations", "confidence"],
        "additionalProperties": False,
    },
    "strict": True,
}


def _client():
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return None
    try:
        from openai import OpenAI
        return OpenAI(api_key=key, base_url=os.environ.get("OPENAI_BASE_URL") or None, timeout=30)
    except Exception:
        return None


def ask_llm(question: str, S: dict[str, Any]) -> dict[str, Any] | None:
    client = _client()
    if client is None:
        return None
    snapshot = summarize_state(S)
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    resp = client.chat.completions.create(
        model=model,
        temperature=0.2,
        response_format={"type": "json_schema", "json_schema": REPLY_SCHEMA},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"TWIN SNAPSHOT (JSON):\n{json.dumps(snapshot, ensure_ascii=False)}\n\nQUESTION: {question}"},
        ],
    )
    data = json.loads(resp.choices[0].message.content or "{}")
    ids = set(_all_ids(snapshot))
    data["citations"] = [c for c in data.get("citations", []) if c in ids]
    data["model"] = model
    return data


def _all_ids(snap: dict[str, Any]) -> list[str]:
    text = json.dumps(snap)
    return re.findall(r"\b(?:E\d+|R\d{2}|A\d{4}|D\d+|CV\d{2}|CAM-[A-Z0-9-]+|bat-R\d{2}|cv-CV\d{2}|off-R\d{2}|zone-[A-D]|traffic-[A-D])\b", text)


# ─────────────────────────────────────────────────────────────
# 規則式 fallback
# ─────────────────────────────────────────────────────────────
def rule_based_answer(question: str, S: dict[str, Any]) -> dict[str, Any]:
    snap = summarize_state(S)
    q = question.lower()
    k = snap["kpi"]; cites: list[str] = []
    lines: list[str] = []
    bad_cv = [c for c, v in snap["conveyors"].items() if v["status"] != "RUNNING"]
    blocked = [z for z, v in snap["zones"].items() if v["status"] == "BLOCKED"]
    congested = [z for z, v in snap["zones"].items() if v["status"] == "CONGESTED"]
    offline = snap["fleet"]["by_status"].get("OFFLINE", []) + snap["fleet"]["by_status"].get("ERROR", [])

    def causes() -> list[str]:
        out = []
        for c in bad_cv:
            fed = next((x.get("feeds") for x in S.get("_layout_conveyors", []) if x["id"] == c), None)
            out.append(f"{c} is {snap['conveyors'][c]['status']} — unloading at the station it feeds takes 4× longer, so robots queue there"); cites.append(c)
        for z in blocked:
            out.append(f"Zone {z} is BLOCKED ({snap['zones'][z]['blocked_reason']}) — robots reroute around it, adding travel distance")
        for z in congested:
            out.append(f"Zone {z} is congested ({snap['zones'][z]['robots']} robots) — waiting and replanning")
        if offline:
            out.append(f"{', '.join(offline)} out of service — their tasks were re-queued"); cites.extend(offline)
        if snap["fleet"]["low_battery"]:
            out.append(f"Low battery: {', '.join(snap['fleet']['low_battery'])} — tasks will be transferred to charge")
        return out

    if "fail" in q and ("likely" in q or "predict" in q or "next" in q):
        risky = sorted(S["robots"].values(), key=lambda r: (r["battery"], r["health"]))[:3]
        lines.append("Highest failure risk: " + "; ".join(f"{r['id']} (battery {r['battery']:.0f}%, health {r['health']}%, waited {r['stats']['wait_ticks']/10:.0f} s)" for r in risky) + ".")
        lines.append("Battery below 20% triggers task transfer; below 10% the robot stops. Pre-emptively send the first one to charge when idle.")
        cites += [r["id"] for r in risky]
    elif "which robot" in q or "should handle" in q or "assign" in q:
        m = re.search(r"A\d{4}", question)
        tid = m.group(0) if m else None
        task = S["tasks"].get(tid) if tid else None
        loc = {l["id"]: l for l in S.get("_layout_locations", [])}
        src = loc.get(task["source"]) if task else None
        cands = []
        for r in S["robots"].values():
            if r["status"] in ("OFFLINE", "ERROR") or r["battery"] < 20: continue
            d = ((r["position"][0] - src["access_point"][0]) ** 2 + (r["position"][2] - src["access_point"][1]) ** 2) ** 0.5 if src else 50
            idle = r["fsm"] == "IDLE"
            score = 0.35 * (1 - min(1, d / 120)) + 0.25 * r["battery"] / 100 + 0.15 * (1 if r["stats"]["tasks_completed"] < 5 else 0.6) + 0.15 * (1 - S["zones"].get(r["zone"], {}).get("congestion", 0) if r["zone"] else 1) + 0.10 * r["health"] / 100 + (0.2 if idle else 0)
            cands.append((score, r["id"], d, r["battery"], idle))
        cands.sort(reverse=True)
        if cands:
            best = cands[0]
            lines.append(f"Recommend {best[1]} for {tid or 'the task'}: {best[2]:.0f} m away, {best[3]:.0f}% battery, {'idle now' if best[4] else 'will be free soon'} (score {best[0]:.2f}).")
            lines.append("Runners-up: " + "; ".join(f"{c[1]} ({c[2]:.0f} m, {c[3]:.0f}%, {c[0]:.2f})" for c in cands[1:4]) + ".")
            cites += [c[1] for c in cands[:4]] + ([tid] if tid else [])
    elif "improve" in q or "optimi" in q or "how can" in q:
        lines.append(f"Current: {k['throughput_per_min']} tasks/min, utilization {k['utilization']*100:.0f}%, on-time {k['on_time_rate']*100:.0f}%, congestion {k['congestion_index']*100:.0f}%.")
        cs = causes()
        tips = [f"Fix active faults first: {'; '.join(cs)}." if cs else "No active faults."]
        if k["avg_wait_s_per_robot"] > 30: tips.append("Waiting time is high — spread routes across more aisles (traffic-weighted A* is on) or stagger task release by zone.")
        if k["utilization"] < 0.6: tips.append("Utilization is low — increase task release rate or reduce idle-to-park delay.")
        tips.append("Keep chargers free: send robots to charge at 35% when idle so transfers (which re-queue tasks) don't happen mid-delivery.")
        lines += [f"Action {i+1}: {t}" for i, t in enumerate(tips[:3])]
    elif "throughput" in q or "slow" in q or "drop" in q or "bottleneck" in q or "why" in q:
        series = snap["throughput_series_last_10"]
        rate = (series[-1] - series[-6]) if len(series) >= 6 else None
        lines.append(f"Throughput is {k['throughput_per_min']} tasks/min ({k['completed_today']} completed, {k['pending']} pending, utilization {k['utilization']*100:.0f}%, avg wait {k['avg_wait_s_per_robot']} s/robot)." + (f" Last 5 min: {rate} tasks." if rate is not None else ""))
        cs = causes()
        lines.append("Main causes: " + ("; ".join(cs) + "." if cs else "no active faults — throughput is limited by fleet size and task mix."))
        if bad_cv: lines.append(f"Action 1: restore {bad_cv[0]} (Scenarios → Active → Clear); it is the single largest bottleneck.")
        if blocked: lines.append(f"Action 2: clear Zone {blocked[0]} once the person has left; reroutes add ~{k['avg_wait_s_per_robot']} s per affected task.")
        if not bad_cv and not blocked and k["pending"] > 6: lines.append("Action: pending queue is growing — consider prioritising PICK tasks to Packing or adding robots.")
    elif "congest" in q or "zone" in q:
        zs = sorted(snap["zones"].items(), key=lambda kv: -kv[1]["congestion"])
        lines.append("Zone load: " + "; ".join(f"{z} {v['status'].lower()} ({v['robots']} robots, {v['congestion']*100:.0f}%)" for z, v in zs) + ".")
        cs = causes()
        if cs: lines.append("Contributing: " + "; ".join(cs) + ".")
    elif "what happens if" in q or "what if" in q:
        lines.append("What-if simulation (clone twin → inject → run 60 s → compare KPI) arrives in Phase 6. For now: " + ("; ".join(causes()) or "no active faults to extrapolate from."))
    else:
        lines.append(f"Status at {snap['sim_time']}: {snap['fleet']['counts']['active']} active, {snap['fleet']['counts']['charging']} charging, {snap['fleet']['counts']['idle']} idle; {k['completed_today']} tasks done, {k['pending']} pending; throughput {k['throughput_per_min']}/min.")
        cs = causes()
        lines.append("Active issues: " + ("; ".join(cs) + "." if cs else "none."))
        lines.append("Try: 'Why is throughput dropping?', 'Which robot should handle A3815?', 'Which robot is likely to fail?', 'How can we improve throughput?'")
    for a in snap["alerts"][:4]: cites.append(a["id"])
    for e in snap["recent_events"][:5]: cites.append(e["id"])
    return {"text": "\n".join(lines), "citations": list(dict.fromkeys(cites)), "confidence": 0.6, "model": "rule-based"}


def answer(question: str, S: dict[str, Any], layout: dict[str, Any]) -> dict[str, Any]:
    S = dict(S); S["_layout_conveyors"] = layout["conveyors"]; S["_layout_locations"] = layout["locations"]
    try:
        r = ask_llm(question, S)
        if r:
            return r
    except Exception as e:  # 金鑰錯誤、網路、限流 → 退回規則式，不讓 UI 掛掉
        fb = rule_based_answer(question, S)
        fb["text"] = f"[LLM unavailable: {type(e).__name__}] " + fb["text"]
        return fb
    return rule_based_answer(question, S)
