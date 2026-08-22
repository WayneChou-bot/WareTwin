"""
AI Autonomous Warehouse Digital Twin — 後端（Phase 3）

  Simulation (asyncio task) → Twin State → WebSocket (FULL / PATCH) → Browser

啟動：uvicorn app.main:app --reload --port 8000
WebSocket：ws://localhost:8000/ws
REST：/api/health /api/state /api/events /api/kpi /api/layout /api/inject /api/tasks
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import TypeAdapter, ValidationError

try:
    from dotenv import load_dotenv
    load_dotenv()  # backend/.env：OPENAI_API_KEY 等
except Exception:
    pass
from .ai import copilot as copilot_ai
from .ai import vlm as vlm_ai
from .db import TwinDB
from .guard import MAX_BODY_BYTES, MAX_WS_MESSAGE_BYTES, client_key, limiter, origin_allowed
from .schema import (ClearInjectionBody, ClientMessage, CopilotBody, NewTask, ScenarioInjection, SimControlBody, TwinState,
                     VlmObserveBody, WhatIfRequest)
from .sim.engine import SimEngine, SIM
from .sim.whatif import run_whatif
from .sim.navgrid import load_layout

log = logging.getLogger("twin")
TICK_S = SIM["TICK_S"]
HEATMAP_EVERY = 30
KPI_DB_EVERY = 600

client_adapter: TypeAdapter[Any] = TypeAdapter(ClientMessage)
inject_adapter: TypeAdapter[Any] = TypeAdapter(ScenarioInjection)


class TwinServer:
    """持有引擎、模擬迴圈、連線與 diff 狀態。"""

    def __init__(self, seed: int = 42, db_path: str = "twin.db") -> None:
        self.layout = load_layout()
        self.seed = seed
        self.engine = SimEngine(self.layout, seed=seed)
        self.run_id = uuid.uuid4().hex[:8]
        self.db = TwinDB(db_path)
        self.clients: set[WebSocket] = set()
        self.speed = 1
        self.paused = False
        self._prev: dict[str, dict[str, str]] = {}   # section → id → json
        self._prev_subsys = ""
        self._prev_decision = ""
        self._task: asyncio.Task[None] | None = None
        self.tick_rate_actual = 0.0
        self.last_sent_tick = 0          # 上一次 broadcast 的 tick（PATCH 的 base_tick 用；一輪可能推進多個 tick）
        self.last_progress = time.monotonic()   # 模擬迴圈最後一次成功推進的時間（health 用）
        self.loop_errors = 0
        self.last_error: str | None = None
        self._whatif_lock = asyncio.Lock()

    # ── 模擬迴圈 ────────────────────────────────────────────
    async def run(self) -> None:
        acc = 0.0
        last = time.perf_counter()
        rate_n, rate_t = 0, last
        while True:
            await asyncio.sleep(0.01)
            now = time.perf_counter()
            dt = min(0.25, now - last); last = now
            if self.paused or self.speed == 0:
                continue
            acc += dt * self.speed
            n = 0
            try:
                while acc >= TICK_S and n < 40:
                    self.engine.step(); acc -= TICK_S; n += 1
                if n:
                    rate_n += n
                    if now - rate_t >= 1:
                        self.tick_rate_actual = rate_n / (now - rate_t); rate_n, rate_t = 0, now
                    await self.after_ticks()
                    self.last_progress = time.monotonic()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # 單一輪失敗（例如 SQLite 暫時寫不進去）不能讓整個模擬死掉
                self.loop_errors += 1; self.last_error = f"{type(e).__name__}: {e}"[:300]
                log.exception("simulation loop error (%d): %s", self.loop_errors, self.last_error)
                acc = 0.0
                await asyncio.sleep(0.5)

    async def after_ticks(self) -> None:
        eng = self.engine
        S = eng.state
        S["sim"]["speed"] = self.speed
        S["sim"]["mode"] = "PAUSED" if self.paused else "LIVE"
        events = eng.new_events; eng.new_events = []
        tick = S["sim"]["tick"]
        try:
            if events:
                self.db.insert_events(self.run_id, events)
            if S["recent_decisions"] and S["recent_decisions"][0]["id"] != self._prev_decision:
                self._prev_decision = S["recent_decisions"][0]["id"]
                self.db.insert_decisions(self.run_id, S["recent_decisions"][:5])
            if tick % KPI_DB_EVERY == 0:
                self.db.insert_kpi(self.run_id, tick, S["kpi"])
        except Exception as e:  # DB 只是審計用途，失敗不應該影響即時串流
            self.loop_errors += 1; self.last_error = f"db: {type(e).__name__}: {e}"[:300]
            log.warning("db write failed: %s", self.last_error)
        if not self.clients:
            self._snapshot_prev(); self.last_sent_tick = tick; return
        patch = self.make_patch()
        # base_tick = 上一次真正送出的 tick；一輪推進多個 tick（10× 或主機卡頓）時前端才不會誤判漏包而 RESYNC
        msg = {"type": "PATCH", "base_tick": self.last_sent_tick, "tick": tick, "patch": patch, "events": events}
        self.last_sent_tick = tick
        await self.broadcast(msg)
        if tick % HEATMAP_EVERY == 0:
            await self.broadcast({"type": "HEATMAP", "layer": self.heatmap_layer("CONGESTION", eng.traffic)})
            await self.broadcast({"type": "HEATMAP", "layer": self.heatmap_layer("TRAFFIC", eng.traffic_short)})

    # ── diff ────────────────────────────────────────────────
    SECTIONS = ("tasks", "zones", "conveyors", "cameras", "sensors", "people", "alerts")

    def _snapshot_prev(self) -> None:
        S = self.engine.state
        for sec in self.SECTIONS:
            self._prev[sec] = {k: json.dumps(v, separators=(",", ":"), sort_keys=True) for k, v in S[sec].items()}
        self._prev_subsys = json.dumps(S["subsystems"], sort_keys=True)

    def _robot_patch(self) -> dict[str, Any]:
        """機器人只送有變動的欄位（與上次送出比較）；path 只在變更時送；浮點數四捨五入。前端以 {...prev, ...patch} 合併。"""
        out: dict[str, Any] = {}
        prev_sent: dict[str, dict[str, Any]] = self._prev.setdefault("_robots", {})  # type: ignore[assignment]
        tick = self.engine.state["sim"]["tick"]
        for rid, r in self.engine.state["robots"].items():
            cur: dict[str, Any] = {k: v for k, v in r.items() if k not in ("path", "position", "heading", "velocity", "battery", "stats")}
            cur["position"] = [round(r["position"][0], 3), 0, round(r["position"][2], 3)]
            cur["heading"] = round(r["heading"], 3); cur["velocity"] = round(r["velocity"], 2); cur["battery"] = round(r["battery"], 2)
            if tick % 10 == 0:
                cur["stats"] = {k: round(v, 1) if isinstance(v, float) else v for k, v in r["stats"].items()}
            cur["path"] = r["path"]
            prev = prev_sent.get(rid, {})
            d = {k: v for k, v in cur.items() if prev.get(k) != v}
            if d:
                out[rid] = d
            prev_sent[rid] = cur
        return out

    def make_patch(self) -> dict[str, Any]:
        S = self.engine.state
        patch: dict[str, Any] = {"sim": S["sim"], "robots": self._robot_patch()}
        for sec in self.SECTIONS:
            prev = self._prev.get(sec, {})
            cur = {k: json.dumps(v, separators=(",", ":"), sort_keys=True) for k, v in S[sec].items()}
            diff: dict[str, Any] = {k: S[sec][k] for k, j in cur.items() if prev.get(k) != j}
            for k in prev:
                if k not in cur:
                    diff[k] = None  # 刪除
            if diff:
                patch[sec] = diff
            self._prev[sec] = cur
        sub = json.dumps(S["subsystems"], sort_keys=True)
        if sub != self._prev_subsys:
            patch["subsystems"] = S["subsystems"]; self._prev_subsys = sub
        if S["sim"]["tick"] % SIM["KPI_EVERY"] == 0:
            patch["kpi"] = S["kpi"]
        if S["recent_decisions"] and S["recent_decisions"][0]["id"] != getattr(self, "_sent_decision", ""):
            self._sent_decision = S["recent_decisions"][0]["id"]
            patch["recent_decisions"] = S["recent_decisions"][:20]
        return patch

    def heatmap_layer(self, kind: str, src: list[float]) -> dict[str, Any]:
        g = self.engine.grid; cs = 2
        cols = (g.cols + cs - 1) // cs; rows = (g.rows + cs - 1) // cs
        v = [0.0] * (cols * rows)
        for r in range(g.rows):
            base = r * g.cols; rr = (r // cs) * cols
            for c in range(g.cols):
                t = src[base + c]
                if t > 0:
                    v[rr + c // cs] += t
        mx = max(v) or 1.0
        return {"kind": kind, "cols": cols, "rows": rows, "values": [round(x / mx, 2) for x in v], "window_ticks": 200 if kind == "TRAFFIC" else 6000}

    # ── 連線 ────────────────────────────────────────────────
    async def broadcast(self, msg: dict[str, Any]) -> None:
        data = json.dumps(msg, separators=(",", ":"))
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def full_message(self) -> dict[str, Any]:
        S = self.engine.state
        S["sim"]["speed"] = self.speed; S["sim"]["mode"] = "PAUSED" if self.paused else "LIVE"
        return {"type": "FULL", "state": S}

    WS_BUCKET = {"SIM_CONTROL": "mutate", "INJECT": "mutate", "CLEAR_INJECTION": "mutate", "CREATE_TASK": "mutate",
                 "COPILOT_ASK": "ai", "WHATIF_RUN": "whatif"}

    async def handle(self, ws: WebSocket, raw: str) -> None:
        key = client_key(dict(ws.headers), ws.client.host if ws.client else None)
        if len(raw.encode("utf-8")) > MAX_WS_MESSAGE_BYTES:
            await ws.send_text(json.dumps({"type": "ERROR", "code": "TOO_LARGE", "message": f"message exceeds {MAX_WS_MESSAGE_BYTES // 1024} KB"})); return
        ok, wait = limiter.check("ws", key)
        if not ok:
            await ws.send_text(json.dumps({"type": "ERROR", "code": "RATE_LIMITED", "message": f"too many messages — retry in {wait:.0f} s"})); return
        try:
            msg = client_adapter.validate_json(raw)
        except ValidationError as e:
            await ws.send_text(json.dumps({"type": "ERROR", "code": "BAD_MESSAGE", "message": str(e)[:300]})); return
        t = msg.type
        bucket = self.WS_BUCKET.get(t)
        if bucket:
            ok, wait = limiter.check(bucket, key)
            if not ok:
                await ws.send_text(json.dumps({"type": "ERROR", "code": "RATE_LIMITED", "message": f"{t} limit reached — retry in {wait:.0f} s", "request_id": getattr(msg, "request_id", None)})); return
        eng = self.engine
        if t == "RESYNC":
            self._snapshot_prev(); self._prev["_robots"] = {}
            await ws.send_text(json.dumps(self.full_message(), separators=(",", ":")))
        elif t == "SIM_CONTROL":
            if msg.action == "PLAY":
                self.paused = False
                if msg.speed: self.speed = msg.speed
                if self.speed == 0: self.speed = 1
            elif msg.action == "PAUSE":
                self.paused = True
            elif msg.action == "RESET":
                self.reset()
                await self.broadcast(self.full_message())
                return
            if msg.speed is not None and msg.action != "RESET":
                self.speed = msg.speed; self.paused = self.speed == 0
            eng.state["sim"]["speed"] = self.speed; eng.state["sim"]["mode"] = "PAUSED" if self.paused else "LIVE"
            await self.broadcast({"type": "PATCH", "base_tick": eng.state["sim"]["tick"], "tick": eng.state["sim"]["tick"], "patch": {"sim": eng.state["sim"]}, "events": []})
        elif t == "INJECT":
            eng.inject(msg.injection.model_dump(exclude_none=True))
        elif t == "CLEAR_INJECTION":
            eng.clear_injection(msg.kind, msg.target_id)
        elif t == "CREATE_TASK":
            nt: NewTask = msg.task
            try:
                task = eng.create_task(nt.type, nt.priority, nt.source, nt.destination, nt.load_units)
            except ValueError as e:
                await ws.send_text(json.dumps({"type": "ERROR", "code": "BAD_TASK", "message": str(e)})); return
            if nt.deadline_s is not None:
                task["deadline_tick"] = eng.state["sim"]["tick"] + int(nt.deadline_s * 10)
        elif t == "ACK_ALERT":
            eng.ack_alert(msg.alert_id)
        elif t == "SELECT_ROBOT":
            pass
        elif t == "COPILOT_ASK":
            # LLM 呼叫放到執行緒，不卡模擬迴圈
            snapshot = json.loads(json.dumps(eng.state))
            reply = await asyncio.to_thread(copilot_ai.answer, msg.question, snapshot, self.layout)
            cites = []
            for c in reply.get("citations", []):
                if c.startswith("E"): cites.append({"event_id": c})
                elif c.startswith("R") and len(c) == 3: cites.append({"robot_id": c})
                elif c.startswith("A") and len(c) == 5: cites.append({"task_id": c})
            eng.emit("AI_DECISION", "AI_AGENT", "INFO", f"Copilot answered: {msg.question[:60]}", payload={"model": reply.get("model"), "confidence": reply.get("confidence")})
            await ws.send_text(json.dumps({"type": "COPILOT_REPLY", "request_id": msg.request_id, "text": reply["text"], "citations": cites, "model": reply.get("model")}, ensure_ascii=False))
        elif t == "WHATIF_RUN":
            req = msg.request.model_dump(exclude_none=True)
            result = await self.run_whatif_safe(req)
            eng.emit("AI_DECISION", "AI_AGENT", "INFO", f"What-if '{req.get('scenario_name', 'scenario')}' simulated {req.get('duration_ticks', 600) // 10}s: throughput {result['delta'].get('throughput_per_min', 0):+} tasks/min", payload={"compute_ms": result["compute_ms"]})
            await ws.send_text(json.dumps({"type": "WHATIF_RESULT", "result": result}, ensure_ascii=False))

    async def run_whatif_safe(self, req: dict[str, Any]) -> dict[str, Any]:
        """在主 event loop 上先 clone（此時沒有 tick 在進行），再把獨立的 clone 交給 worker thread 跑；同時只允許一個 What-if。"""
        async with self._whatif_lock:
            start_tick = self.engine.state["sim"]["tick"]
            base, scen = self.engine.clone(), self.engine.clone()
            return await asyncio.to_thread(run_whatif, base, scen, req, start_tick)

    def reset(self, seed: int | None = None) -> None:
        if seed is not None:
            self.seed = seed
        self.engine = SimEngine(self.layout, seed=self.seed)
        self.run_id = uuid.uuid4().hex[:8]
        self._prev = {}; self._prev_subsys = ""; self._prev_decision = ""; self._sent_decision = ""
        self.last_sent_tick = 0
        self._snapshot_prev()


server = TwinServer(seed=int(os.environ.get("TWIN_SEED", "42")), db_path=os.environ.get("TWIN_DB", "twin.db"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    server._snapshot_prev()
    if server._task and not server._task.done():
        server._task.cancel()
    server.last_progress = time.monotonic()   # 剛啟動不算停擺
    server._task = asyncio.create_task(server.run())
    try:
        yield
    finally:
        server._task.cancel()
        try:
            await server._task
        except (asyncio.CancelledError, Exception):
            pass
        server.clients.clear()


app = FastAPI(title="AI Autonomous Warehouse Digital Twin", version="0.3.0", lifespan=lifespan)
# CORS：本機開發預設全開；部署時用 TWIN_CORS_ORIGINS 設定前端網域（逗號分隔），例如 https://your-app.vercel.app
_origins = [o.strip() for o in os.environ.get("TWIN_CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_origin_regex=os.environ.get("TWIN_CORS_REGEX") or None, allow_methods=["*"], allow_headers=["*"])


class GuardMiddleware:
    """純 ASGI middleware（不是 BaseHTTPMiddleware，這樣才能在 receive 層攔截並直接回 413）：
    會改狀態的請求檢查 Origin + 以實際收到的 bytes 計算 body 大小；GET 不受影響。"""

    def __init__(self, app_: Any) -> None:
        self.app = app_

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http" or scope.get("method") not in ("POST", "PUT", "DELETE", "PATCH"):
            await self.app(scope, receive, send); return
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        if not origin_allowed(headers.get("origin")):
            await _json_response(send, 403, {"detail": "origin not allowed"}); return
        cl = headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > MAX_BODY_BYTES:
            await _json_response(send, 413, {"detail": f"body exceeds {MAX_BODY_BYTES // 1024} KB"}); return
        total = 0; tripped = False; responded = False

        async def capped_receive() -> dict[str, Any]:
            nonlocal total, tripped
            msg = await receive()
            if msg["type"] == "http.request":
                total += len(msg.get("body", b""))
                if total > MAX_BODY_BYTES:
                    tripped = True
                    # 停止讀取：回傳「body 結束」讓下游的 JSON 解析失敗，再由 guarded_send 把回應改成 413
                    return {"type": "http.request", "body": b"", "more_body": False}
            return msg

        async def guarded_send(msg: dict[str, Any]) -> None:
            nonlocal responded
            if tripped:
                if msg["type"] == "http.response.start" and not responded:
                    responded = True
                    await _json_response(send, 413, {"detail": f"body exceeds {MAX_BODY_BYTES // 1024} KB"})
                return   # 丟掉下游原本的回應
            await send(msg)

        await self.app(scope, capped_receive, guarded_send)


async def _json_response(send: Any, status: int, body: dict[str, Any]) -> None:
    raw = json.dumps(body).encode()
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode())]})
    await send({"type": "http.response.body", "body": raw})


app.add_middleware(GuardMiddleware)


def throttle(request: Request, bucket: str) -> None:
    ok, wait = limiter.check(bucket, client_key(dict(request.headers), request.client.host if request.client else None))
    if not ok:
        raise HTTPException(429, f"rate limit ({bucket}) — retry in {wait:.0f} s", headers={"Retry-After": str(int(wait) + 1)})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    if not origin_allowed(ws.headers.get("origin")):
        await ws.close(code=1008, reason="origin not allowed"); return
    await ws.accept()
    server.clients.add(ws)
    try:
        await ws.send_text(json.dumps(server.full_message(), separators=(",", ":")))
        await ws.send_text(json.dumps({"type": "HEATMAP", "layer": server.heatmap_layer("CONGESTION", server.engine.traffic)}))
        while True:
            raw = await ws.receive_text()
            await server.handle(ws, raw)
    except WebSocketDisconnect:
        pass
    finally:
        server.clients.discard(ws)


@app.get("/")
def root() -> dict[str, Any]:
    return {"service": "warehouse-digital-twin-backend", "ws": "/ws", "health": "/api/health", "docs": "/docs"}


STALL_S = float(os.environ.get("TWIN_HEALTH_STALL_S", "10"))


def health_payload() -> dict[str, Any]:
    S = server.engine.state
    task_alive = server._task is not None and not server._task.done()
    stalled = (not server.paused and server.speed > 0) and (time.monotonic() - server.last_progress > STALL_S)
    db_ok = True
    try:
        server.db.ping()
    except Exception:
        db_ok = False
    ok = task_alive and not stalled
    return {"ok": ok, "run_id": server.run_id, "tick": S["sim"]["tick"], "speed": server.speed, "paused": server.paused,
            "clients": len(server.clients), "tick_rate": round(server.tick_rate_actual, 1), "robots": len(S["robots"]),
            "sim_task_alive": task_alive, "stalled": stalled, "db_ok": db_ok, "loop_errors": server.loop_errors, "last_error": server.last_error}


@app.get("/api/health")
async def health() -> Any:
    """模擬迴圈死掉或超過 STALL_S 沒推進 → 503，讓 Render 重啟；DB 掛掉只回報不判定失敗（審計用途）。"""
    h = health_payload()
    if not h["ok"]:
        return JSONResponse(h, status_code=503)
    return h


@app.get("/api/state")
async def get_state() -> dict[str, Any]:
    return server.full_message()["state"]


@app.get("/api/state/validate")
async def validate_state() -> dict[str, Any]:
    """用 Pydantic 驗證目前 state 是否符合契約（除錯用）。"""
    TwinState.model_validate(server.engine.state)
    return {"valid": True}


@app.get("/api/layout")
def get_layout() -> dict[str, Any]:
    return server.layout


@app.get("/api/kpi")
async def get_kpi() -> dict[str, Any]:
    return server.engine.state["kpi"]


@app.get("/api/events")
def get_events(limit: int = Query(200, le=2000), type: list[str] | None = Query(None), severity: list[str] | None = Query(None),
               robot_id: str | None = None, zone_id: str | None = None, since_tick: int | None = None) -> list[dict[str, Any]]:
    return server.db.query_events(server.run_id, limit, type, severity, robot_id, zone_id, since_tick)


@app.get("/api/decisions")
def get_decisions(limit: int = 20) -> list[dict[str, Any]]:
    return server.engine.state["recent_decisions"][:limit]


@app.post("/api/inject")
async def post_inject(body: dict[str, Any], request: Request) -> dict[str, Any]:
    throttle(request, "mutate")
    try:
        inj = inject_adapter.validate_python(body)
    except ValidationError as e:
        raise HTTPException(400, str(e)[:300])
    server.engine.inject(inj.model_dump(exclude_none=True))
    return {"ok": True}


@app.post("/api/inject/clear")
async def post_clear(body: ClearInjectionBody, request: Request) -> dict[str, Any]:
    throttle(request, "mutate")
    server.engine.clear_injection(body.kind, body.target_id)
    return {"ok": True}


@app.post("/api/tasks")
async def post_task(body: NewTask, request: Request) -> dict[str, Any]:
    throttle(request, "mutate")
    try:
        return server.engine.create_task(body.type, body.priority, body.source, body.destination, body.load_units)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/copilot")
async def post_copilot(body: CopilotBody, request: Request) -> dict[str, Any]:
    throttle(request, "ai")
    q = body.question.strip()
    if not q:
        raise HTTPException(400, "question required")
    snapshot = json.loads(json.dumps(server.engine.state))
    return await asyncio.to_thread(copilot_ai.answer, q, snapshot, server.layout)


@app.post("/api/vlm/observe")
async def post_vlm(body: VlmObserveBody, request: Request) -> dict[str, Any]:
    """前端把 Live Camera 畫面（JPEG data URL）送來；回傳 VlmObservation 並寫入 cameras[id].last_observation。"""
    throttle(request, "ai")
    cam_id = body.camera_id
    eng = server.engine
    if cam_id not in eng.state["cameras"]:
        raise HTTPException(404, "unknown camera")
    if eng.state["cameras"][cam_id]["status"] == "OFFLINE":
        raise HTTPException(409, "camera offline")
    snapshot = json.loads(json.dumps(eng.state))
    obs = await asyncio.to_thread(vlm_ai.observe, cam_id, body.image_b64, snapshot, server.layout)
    eng.state["cameras"][cam_id]["last_observation"] = obs
    sev = obs["severity"] if obs["event"] != "none" else "INFO"
    eng.emit("VLM_OBSERVATION", "VLM", sev, f"{cam_id}: {obs['event'].replace('_', ' ')} ({obs['confidence']:.0%}) — {obs.get('description', '')}", camera_id=cam_id, zone_id=obs["zone"], payload={"confidence": obs["confidence"], "raw": obs.get("raw")})
    if obs["event"] == "human_detected" and obs["blocked"] and obs["confidence"] >= 0.7:
        eng.emit("HUMAN_DETECTED", "VLM", "HIGH", f"Human detected — Zone {obs['zone']} (via {cam_id})", zone_id=obs["zone"], camera_id=cam_id)
        if os.environ.get("TWIN_VLM_ACTS", "0") == "1" and eng.state["zones"][obs["zone"]]["status"] != "BLOCKED":
            eng.block_zone(obs["zone"], "VLM: human detected", 300)
    return obs


@app.post("/api/whatif")
async def post_whatif(body: dict[str, Any], request: Request) -> dict[str, Any]:
    """複製 LIVE 引擎、注入情境、跑 duration_ticks、回傳 Baseline vs Scenario 對照。LIVE 不受影響。"""
    throttle(request, "whatif")
    try:
        req = WhatIfRequest.model_validate(body).model_dump(exclude_none=True)
    except ValidationError as e:
        raise HTTPException(400, str(e)[:300])
    return await server.run_whatif_safe(req)


@app.get("/api/ai/status")
def ai_status() -> dict[str, Any]:
    return {"llm": bool(os.environ.get("OPENAI_API_KEY")), "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            "vision_model": os.environ.get("OPENAI_VISION_MODEL", os.environ.get("OPENAI_MODEL", "gpt-4o-mini")), "vlm_acts": os.environ.get("TWIN_VLM_ACTS", "0") == "1"}


@app.post("/api/sim")
async def post_sim(body: SimControlBody, request: Request) -> dict[str, Any]:
    throttle(request, "mutate")
    if body.action == "PAUSE": server.paused = True
    elif body.action == "PLAY": server.paused = False
    elif body.action == "RESET": server.reset(body.seed)
    if body.speed is not None: server.speed = body.speed
    return health_payload()
