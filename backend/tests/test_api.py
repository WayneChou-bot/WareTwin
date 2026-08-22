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


def test_health_reports_dead_sim_task():
    """模擬 task 死掉 → /api/health 回 503（讓 Render 重啟）。下一個 TestClient 的 lifespan 會重新啟動迴圈。"""
    import time as _t
    with TestClient(app) as client:
        h = client.get("/api/health"); assert h.status_code == 200 and h.json()["sim_task_alive"]
        server._task.get_loop().call_soon_threadsafe(server._task.cancel)
        for _ in range(50):
            _t.sleep(0.05)
            if server._task.done(): break
        h = client.get("/api/health")
        assert h.status_code == 503 and h.json()["sim_task_alive"] is False


def test_patch_base_tick_chains_across_multi_tick_rounds():
    """PATCH 的 base_tick 必須等於上一則 PATCH 的 tick（即使一輪推進多個 tick）。"""
    with TestClient(app) as client:
        client.post("/api/sim", json={"action": "PLAY", "speed": 10})
        with client.websocket_connect("/ws") as ws:
            full = ws.receive_json(); assert full["type"] == "FULL"
            last = full["state"]["sim"]["tick"]; n = 0
            while n < 8:
                msg = ws.receive_json()
                if msg["type"] != "PATCH":
                    continue
                assert msg["base_tick"] == last, (msg["base_tick"], last)
                last = msg["tick"]; n += 1
        client.post("/api/sim", json={"action": "PLAY", "speed": 1})


def test_sim_loop_survives_db_failure(monkeypatch):
    """SQLite 寫入丟例外時，模擬迴圈要繼續推進（只記 loop_errors），不能死掉。"""
    import time as _t
    def boom(*a, **k): raise RuntimeError("disk full")
    with TestClient(app) as client:
        monkeypatch.setattr(server.db, "insert_events", boom)
        client.post("/api/sim", json={"action": "PLAY", "speed": 10})
        t0 = client.get("/api/health").json()["tick"]
        _t.sleep(1.0)
        h = client.get("/api/health").json()
        assert h["tick"] > t0 and h["ok"] and h["loop_errors"] >= 1 and "disk full" in (h["last_error"] or "")
        client.post("/api/sim", json={"action": "PLAY", "speed": 1})
