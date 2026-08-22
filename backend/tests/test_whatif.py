"""Phase 6：What-if — clone 確定性、LIVE 不受影響、scenario 有差異、endpoint 契約"""
import json
from fastapi.testclient import TestClient
from app.main import app, server
from app.sim.navgrid import load_layout
from app.sim.engine import SimEngine
from app.sim.whatif import run_whatif
from app.schema import WhatIfResult

L = load_layout()


def test_clone_is_deterministic_and_independent():
    e = SimEngine(L, seed=42)
    for _ in range(2000): e.step()
    snap = json.dumps(e.state, sort_keys=True)
    a, b = e.clone(), e.clone()
    for _ in range(1000): a.step(); b.step()
    assert json.dumps(a.state, sort_keys=True) == json.dumps(b.state, sort_keys=True)
    assert json.dumps(e.state, sort_keys=True) == snap           # LIVE 沒動
    assert a.state["sim"]["tick"] == e.state["sim"]["tick"] + 1000


def test_whatif_compound_scenario_hurts_task_time():
    e = SimEngine(L, seed=42)
    for _ in range(3000): e.step()
    r = run_whatif(e, {"injections": [{"kind": "CONVEYOR_FAILURE", "conveyor_id": "CV03"}, {"kind": "HUMAN_INTRUSION", "zone_id": "B", "duration_ticks": 900}, {"kind": "TASK_BURST", "count": 20, "priority": "HIGH"}], "duration_ticks": 3000})
    b, s = r["window"]["baseline"], r["window"]["scenario"]
    assert e.state["sim"]["tick"] == 3000
    assert s["avg_task_time_s"] > b["avg_task_time_s"] * 1.15
    assert s["avg_wait_s"] >= b["avg_wait_s"] * 0.8  # 複合故障下等待不會明顯變少（重新規劃次數本身有雜訊，不當斷言）
    assert any(ev["type"] == "CONVEYOR_STATUS_CHANGED" for ev in r["key_events"])
    assert r["ai_recommendation"]
    WhatIfResult.model_validate({k: r[k] for k in ("request", "baseline_kpi", "scenario_kpi", "delta", "key_events", "ai_recommendation")})


def test_whatif_endpoints():
    with TestClient(app) as client:
        body = {"scenario_name": "t", "injections": [{"kind": "ROBOT_FAILURE", "robot_id": "R07"}], "duration_ticks": 300, "run_baseline": True}
        r = client.post("/api/whatif", json=body); assert r.status_code == 200
        d = r.json(); assert "delta" in d and d["window"]["scenario"]["robots_offline"] == 1
        assert client.post("/api/whatif", json={"injections": [{"kind": "NOPE"}]}).status_code == 400
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "WHATIF_RUN", "request": body})
            for _ in range(400):
                m = ws.receive_json()
                if m["type"] == "WHATIF_RESULT":
                    assert m["result"]["request"]["duration_ticks"] == 300; break
            else:
                raise AssertionError("no WHATIF_RESULT")
        server.paused = True
