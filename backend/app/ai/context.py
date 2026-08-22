"""把 TwinState 濃縮成 LLM 能讀的營運摘要（控制在 ~3k tokens）。Copilot 與 VLM 共用。"""
from __future__ import annotations

from typing import Any


def clock(tick: int) -> str:
    s = 8 * 3600 + tick // 10
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def summarize_state(S: dict[str, Any], max_events: int = 30) -> dict[str, Any]:
    k = S["kpi"]
    robots = S["robots"].values()
    by_status: dict[str, list[str]] = {}
    for r in robots:
        by_status.setdefault(r["status"], []).append(r["id"])
    low = [f"{r['id']}({r['battery']:.0f}%)" for r in robots if r["battery"] < 25]
    waiting_long = [r["id"] for r in robots if r["stats"]["wait_ticks"] > 600]
    tasks = list(S["tasks"].values())
    recent_events = [e for e in S["recent_events"] if e["severity"] != "LOW"][:max_events]
    return {
        "sim_time": clock(S["sim"]["tick"]), "tick": S["sim"]["tick"], "mode": S["sim"]["mode"],
        "kpi": {
            "throughput_per_min": k["operation"]["throughput_per_min"], "completed_today": k["operation"]["completed_today"],
            "pending": k["operation"]["pending"], "ongoing": k["operation"]["ongoing"], "avg_task_time_s": k["operation"]["avg_task_time_s"],
            "on_time_rate": round(k["operation"]["on_time_rate"], 3), "utilization": round(k["operation"]["avg_utilization"], 3),
            "avg_wait_s_per_robot": k["efficiency"]["avg_wait_time_s"], "congestion_index": k["efficiency"]["congestion_index"],
            "energy_kwh": k["efficiency"]["energy_kwh"],
        },
        "fleet": {"counts": k["fleet"], "by_status": by_status, "low_battery": low, "waiting_long": waiting_long},
        "zones": {z: {"status": v["status"], "robots": v["robot_count"], "congestion": round(v["congestion"], 2), "blocked_reason": v["blocked_reason"]} for z, v in S["zones"].items()},
        "conveyors": {c: {"status": v["status"], "throughput_per_min": v["throughput_per_min"]} for c, v in S["conveyors"].items()},
        "cameras_offline": [c for c, v in S["cameras"].items() if v["status"] != "ONLINE"],
        "people": [{"id": p["id"], "zone": p["zone"]} for p in S["people"].values()],
        "subsystems": S["subsystems"],
        "alerts": [{"id": a["id"], "severity": a["severity"], "title": a["title"], "detail": a["detail"], "time": clock(a["created_tick"]), "acknowledged": a["acknowledged"]} for a in S["alerts"].values()],
        "tasks": {"waiting": [f"{t['id']}({t['priority']},{t['source']}→{t['destination']})" for t in tasks if t["status"] == "WAITING"][:12],
                  "in_progress": [f"{t['id']}:{t['assigned_robot']}" for t in tasks if t["status"] in ("ASSIGNED", "IN_PROGRESS")][:25]},
        "recent_decisions": [{"id": d["id"], "time": clock(d["tick"]), "task": d["task_id"], "selected": d["selected_robot"],
                              "candidates": [{"robot": c["robot_id"], "score": c["score"], "distance_m": c["distance_m"], "battery": c["battery"], "workload": c["workload"], "rejected": c["rejected_reason"]} for c in d["candidates"][:4]]} for d in S["recent_decisions"][:5]],
        "recent_events": [{"id": e["id"], "time": clock(e["tick"]), "sev": e["severity"], "type": e["type"], "msg": e["message"], "robot": e.get("robot_id"), "zone": e.get("zone_id")} for e in recent_events],
        "throughput_series_last_10": [p["completed"] for p in S["kpi"]["throughput_series"][-10:]],
    }


def robots_near(S: dict[str, Any], layout: dict[str, Any], camera_id: str) -> dict[str, Any]:
    """VLM 的輔助上下文：攝影機視野內（粗略：同 zone 且距離 < range）有什麼。"""
    cam = next((c for c in layout["cameras"] if c["id"] == camera_id), None)
    if not cam:
        return {}
    cx, _, cz = cam["position"]; rng = cam["range_m"]
    near_r = [r["id"] for r in S["robots"].values() if ((r["position"][0] - cx) ** 2 + (r["position"][2] - cz) ** 2) ** 0.5 < rng]
    near_p = [p["id"] for p in S["people"].values() if ((p["position"][0] - cx) ** 2 + (p["position"][2] - cz) ** 2) ** 0.5 < rng]
    return {"camera": camera_id, "zone": cam["zone"], "robots_in_range": near_r, "people_in_range": near_p, "zone_status": S["zones"].get(cam["zone"], {}).get("status")}
