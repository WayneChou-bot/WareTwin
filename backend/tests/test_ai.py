"""Phase 5：Copilot 與 VLM（不需要 API key：測 fallback 與 endpoint 契約；有 key 時 ask_llm 會被實際呼叫）"""
import os
from fastapi.testclient import TestClient
from app.main import app, server
from app.ai.copilot import answer, rule_based_answer
from app.ai.vlm import observe
from app.ai.context import summarize_state
from app.sim.navgrid import load_layout
from app.sim.engine import SimEngine
from app.schema import TwinState, VlmObservation

L = load_layout()


def _engine_with_faults():
    e = SimEngine(L, seed=7)
    for _ in range(3000): e.step()
    e.inject({"kind": "CONVEYOR_FAILURE", "conveyor_id": "CV03"}); e.inject({"kind": "HUMAN_INTRUSION", "zone_id": "B", "duration_ticks": 900})
    for _ in range(300): e.step()
    return e


def test_summary_is_compact():
    e = _engine_with_faults()
    snap = summarize_state(e.state)
    import json
    assert len(json.dumps(snap)) < 20000
    assert snap["conveyors"]["CV03"]["status"] == "ERROR" and snap["zones"]["B"]["status"] == "BLOCKED"


def test_rule_based_answers_are_grounded():
    e = _engine_with_faults()
    r = rule_based_answer("Why is throughput dropping?", {**e.state, "_layout_conveyors": L["conveyors"], "_layout_locations": L["locations"]})
    assert "CV03" in r["text"] and "Zone B" in r["text"]
    assert "CV03" in r["citations"]
    r2 = answer("Which robot is likely to fail?", e.state, L)
    assert r2["text"].startswith("Highest failure risk") and any(c.startswith("R") for c in r2["citations"])
    waiting = next((t for t in e.state["tasks"].values() if t["status"] == "WAITING"), None)
    if waiting:
        r3 = answer(f"Which robot should handle {waiting['id']}?", e.state, L)
        assert "Recommend R" in r3["text"] and waiting["id"] in r3["citations"]


def test_vlm_simulated_observation_matches_ground_truth():
    e = _engine_with_faults()
    o = observe("CAM-B02", None, e.state, L)       # Zone B 有人
    assert o["event"] == "human_detected" and o["blocked"] and o["bbox"]
    o2 = observe("CAM-C01", None, e.state, L)      # Zone C 沒人
    assert o2["event"] == "none"
    e.state["cameras"]["CAM-B02"]["last_observation"] = o
    TwinState.model_validate(e.state); VlmObservation.model_validate(o)


def test_copilot_and_vlm_endpoints():
    with TestClient(app) as client:
        st = client.get("/api/ai/status").json(); assert "llm" in st
        r = client.post("/api/copilot", json={"question": "How can we improve throughput?"}); assert r.status_code == 200 and r.json()["text"]
        assert client.post("/api/copilot", json={}).status_code == 400
        r = client.post("/api/vlm/observe", json={"camera_id": "CAM-A01"}); assert r.status_code == 200 and r.json()["event"] in ("none", "human_detected")
        assert client.post("/api/vlm/observe", json={"camera_id": "NOPE"}).status_code == 404
        assert server.engine.state["cameras"]["CAM-A01"]["last_observation"] is not None
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "COPILOT_ASK", "request_id": "t1", "question": "Why is Zone B congested?"})
            for _ in range(200):
                m = ws.receive_json()
                if m["type"] == "COPILOT_REPLY":
                    assert m["request_id"] == "t1" and m["text"]; break
            else:
                raise AssertionError("no COPILOT_REPLY")
        server.paused = True
