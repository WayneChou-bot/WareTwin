import math
from app.sim.engine import SimEngine, SIM
from app.sim.navgrid import load_layout
def test_perception_keeps_distance_and_reports():
    eng = SimEngine(load_layout(), seed=42)
    min_d = 9; stops = slows = seen = 0
    for _ in range(6000):
        eng.step()
        rs = list(eng.state["robots"].values())
        for r in rs:
            p = r["perception"]
            if p["state"] == "STOPPED": stops += 1
            if p["state"] == "SLOWING": slows += 1
            if p["obstacles"]: seen += 1
        for i in range(len(rs)):
            for j in range(i + 1, len(rs)):
                a, b = rs[i], rs[j]
                if a["floor"] != b["floor"] or a["lift_id"] or b["lift_id"]:
                    continue
                d = math.hypot(a["position"][0] - b["position"][0], a["position"][2] - b["position"][2])
                min_d = min(min_d, d)
    assert seen > 0 and stops + slows > 0
    assert min_d >= 0.9  # MIN_SEP 硬下限
    assert any("LiDAR" in e["message"] for e in eng.state["recent_events"])
    assert eng.state["kpi"]["operation"]["completed_today"] > 40

def test_perception_offline_robot_is_off():
    eng = SimEngine(load_layout(), seed=42)
    eng.inject({"kind": "ROBOT_FAILURE", "robot_id": "R07"})
    for _ in range(5): eng.step()
    assert eng.state["robots"]["R07"]["perception"]["state"] == "OFF"
