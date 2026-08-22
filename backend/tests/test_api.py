"""FastAPI / WebSocket 協定測試。"""
import json
from fastapi.testclient import TestClient
from app.main import app, server


def test_rest_and_ws_roundtrip(tmp_path):
    with TestClient(app) as client:
        h = client.get("/api/health").json(); assert h["ok"] and h["robots"] == 20
        assert client.get("/api/state/validate").json()["valid"]
        with client.websocket_connect("/ws") as ws:
            full = ws.receive_json(); assert full["type"] == "FULL" and len(full["state"]["robots"]) == 20
            ws.send_json({"type": "SIM_CONTROL", "action": "PLAY", "speed": 10})
            got_patch = False
            for _ in range(40):
                m = ws.receive_json()
                if m["type"] == "PATCH" and "robots" in m["patch"]:
                    got_patch = True; assert "sim" in m["patch"]; break
            assert got_patch
            ws.send_json({"type": "INJECT", "injection": {"kind": "HUMAN_INTRUSION", "zone_id": "B", "duration_ticks": 300}})
            blocked = False
            for _ in range(300):
                m = ws.receive_json()
                if m["type"] == "PATCH" and m["patch"].get("zones", {}).get("B", {}).get("status") == "BLOCKED":
                    blocked = True; break
            assert blocked
            ws.send_json({"type": "NOPE"})
            for _ in range(50):
                m = ws.receive_json()
                if m["type"] == "ERROR": assert m["code"] == "BAD_MESSAGE"; break
            else:
                raise AssertionError("bad message not rejected")
            ws.send_json({"type": "SIM_CONTROL", "action": "PAUSE"})
        ev = client.get("/api/events", params={"severity": "HIGH", "limit": 5}).json()
        assert any("Zone B" in e["message"] for e in ev)
        r = client.post("/api/tasks", json={"type": "PICK", "priority": "HIGH", "source": "SHELF-A12", "destination": "PACK-01"})
        assert r.status_code == 200 and r.json()["status"] == "WAITING"
        assert client.post("/api/inject", json={"kind": "BOGUS"}).status_code == 400
        server.paused = True
