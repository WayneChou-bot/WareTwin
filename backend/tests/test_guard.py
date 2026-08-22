"""第 2 批：公開 Demo 防護 — 輸入上限、rate limit、Origin 檢查、body 大小。"""
from fastapi.testclient import TestClient
from app.main import app
from app.guard import limiter


def test_input_limits_rejected():
    with TestClient(app) as c:
        assert c.post("/api/inject", json={"kind": "TASK_BURST", "count": 500}).status_code == 400
        assert c.post("/api/inject", json={"kind": "HUMAN_INTRUSION", "zone_id": "B", "duration_ticks": 999999}).status_code == 400
        assert c.post("/api/copilot", json={"question": "x" * 5000}).status_code == 422
        assert c.post("/api/vlm/observe", json={"camera_id": "CAM-B01", "image_b64": "a" * 500_000}).status_code == 422
        r = c.post("/api/whatif", json={"injections": [{"kind": "ROBOT_FAILURE", "robot_id": "R01"}] * 20, "duration_ticks": 600})
        assert r.status_code == 400
        assert c.post("/api/sim", json={"action": "PLAY", "speed": 99}).status_code == 422
        # 合法值仍可用
        assert c.post("/api/inject", json={"kind": "TASK_BURST", "count": 5}).status_code == 200


def test_rate_limit_rest_and_ws(monkeypatch):
    monkeypatch.setenv("TWIN_RATE_LIMIT", "1"); limiter.reset()
    with TestClient(app) as c:
        codes = [c.post("/api/inject", json={"kind": "CAMERA_OFFLINE", "camera_id": "CAM-B01"}).status_code for _ in range(25)]
        assert codes[:20] == [200] * 20 and codes[20] == 429
        assert "Retry-After" in c.post("/api/inject", json={"kind": "CAMERA_OFFLINE", "camera_id": "CAM-B01"}).headers
        # 讀取不受限
        assert all(c.get("/api/health").status_code == 200 for _ in range(30))
        with c.websocket_connect("/ws") as ws:
            ws.receive_json()
            got = None
            for _ in range(30):
                ws.send_json({"type": "INJECT", "injection": {"kind": "CAMERA_OFFLINE", "camera_id": "CAM-B02"}})
            for _ in range(400):
                m = ws.receive_json()
                if m["type"] == "ERROR" and m["code"] == "RATE_LIMITED":
                    got = m; break
            assert got is not None


def test_origin_check(monkeypatch):
    monkeypatch.setenv("TWIN_CORS_ORIGINS", "https://ware-twin.vercel.app")
    monkeypatch.setenv("TWIN_CORS_REGEX", r"https://.*\.vercel\.app")
    with TestClient(app) as c:
        body = {"kind": "CAMERA_OFFLINE", "camera_id": "CAM-B01"}
        assert c.post("/api/inject", json=body).status_code == 403                                   # 無 Origin（curl）
        assert c.post("/api/inject", json=body, headers={"origin": "https://evil.example"}).status_code == 403
        assert c.post("/api/inject", json=body, headers={"origin": "https://ware-twin.vercel.app"}).status_code == 200
        assert c.post("/api/inject", json=body, headers={"origin": "https://ware-twin-git-x.vercel.app"}).status_code == 200
        assert c.get("/api/health").status_code == 200                                               # GET 不檢查
        import pytest
        from starlette.websockets import WebSocketDisconnect
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_json()
        with c.websocket_connect("/ws", headers={"origin": "https://ware-twin.vercel.app"}) as ws:
            assert ws.receive_json()["type"] == "FULL"
    monkeypatch.setenv("TWIN_ALLOW_NO_ORIGIN", "1")
    with TestClient(app) as c:
        assert c.post("/api/inject", json=body).status_code == 200


def test_body_size_limit():
    with TestClient(app) as c:
        r = c.post("/api/copilot", content=b"{}", headers={"content-type": "application/json", "content-length": str(2_000_000)})
        assert r.status_code == 413
