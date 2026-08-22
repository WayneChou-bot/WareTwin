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
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import TypeAdapter, ValidationError

try:
    from dotenv import load_dotenv
    load_dotenv()  # backend/.env：OPENAI_API_KEY 等
except Exception:
    pass
from .ai import copilot as copilot_ai
from .ai import vlm as vlm_ai
from .db import TwinDB
from .schema import ClientMessage, ScenarioInjection, NewTask, TwinState, WhatIfRequest
from .sim.engine import SimEngine, SIM
from .sim.whatif import run_whatif
from .sim.navgrid import load_layout

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
            while acc >= TICK_S and n < 40:
                self.engine.step(); acc -= TICK_S; n += 1
            if n:
                rate_n += n
                if now - rate_t >= 1:
                    self.tick_rate_actual = rate_n / (now - rate_t); rate_n, rate_t = 0, now
                await self.after_ticks()

    async def after_ticks(self) -> None:
        eng = self.engine
        S = eng.state
        S["sim"]["speed"] = self.speed
        S["sim"]["mode"] = "PAUSED" if self.paused else "LIVE"
        events = eng.new_events; eng.new_events = []
        if events:
            self.db.insert_events(self.run_id, events)
        if S["recent_decisions"] and S["recent_decisions"][0]["id"] != self._prev_decision:
            self._prev_decision = S["recent_decisions"][0]["id"]
            self.db.insert_decisions(self.run_id, S["recent_decisions"][:5])
        tick = S["sim"]["tick"]
        if tick % KPI_DB_EVERY == 0:
            self.db.insert_kpi(self.run_id, tick, S["kpi"])
        if not self.clients:
            self._snapshot_prev(); return
        patch = self.make_patch()
        msg = {"type": "PATCH", "base_tick": tick - 1, "tick": tick, "patch": patch, "events": events}
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

    async def handle(self, ws: WebSocket, raw: str) -> None:
        try:
            msg = client_adapter.validate_json(raw)
        except ValidationError as e:
            await ws.send_text(json.dumps({"type": "ERROR", "code": "BAD_MESSAGE", "message": str(e)[:300]})); return
        t = msg.type
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
            task = eng.create_task(nt.type, nt.priority, nt.source, nt.destination, nt.load_units)
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
            result = await asyncio.to_thread(run_whatif, eng, req)
            eng.emit("AI_DECISION", "AI_AGENT", "INFO", f"What-if '{req.get('scenario_name', 'scenario')}' simulated {req.get('duration_ticks', 600) // 10}s: throughput {result['delta'].get('throughput_per_min', 0):+} tasks/min", payload={"compute_ms": result["compute_ms"]})
            await ws.send_text(json.dumps({"type": "WHATIF_RESULT", "result": result}, ensure_ascii=False))

    def reset(self, seed: int | None = None) -> None:
        if seed is not None:
            self.seed = seed
        self.engine = SimEngine(self.layout, seed=self.seed)
        self.run_id = uuid.uuid4().hex[:8]
        self._prev = {}; self._prev_subsys = ""; self._prev_decision = ""; self._sent_decision = ""
        self._snapshot_prev()


server = TwinServer(seed=int(os.environ.get("TWIN_SEED", "42")), db_path=os.environ.get("TWIN_DB", "twin.db"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    server._snapshot_prev()
    if server._task and not server._task.done():
        server._task.cancel()
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


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
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


@app.get("/api/health")
def health() -> dict[str, Any]:
    S = server.engine.state
    return {"ok": True, "run_id": server.run_id, "tick": S["sim"]["tick"], "speed": server.speed, "paused": server.paused,
            "clients": len(server.clients), "tick_rate": round(server.tick_rate_actual, 1), "robots": len(S["robots"])}


@app.get("/api/state")
def get_state() -> dict[str, Any]:
    return server.full_message()["state"]


@app.get("/api/state/validate")
def validate_state() -> dict[str, Any]:
    """用 Pydantic 驗證目前 state 是否符合契約（除錯用）。"""
    TwinState.model_validate(server.engine.state)
    return {"valid": True}


@app.get("/api/layout")
def get_layout() -> dict[str, Any]:
    return server.layout


@app.get("/api/kpi")
def get_kpi() -> dict[str, Any]:
    return server.engine.state["kpi"]


@app.get("/api/events")
def get_events(limit: int = Query(200, le=2000), type: list[str] | None = Query(None), severity: list[str] | None = Query(None),
               robot_id: str | None = None, zone_id: str | None = None, since_tick: int | None = None) -> list[dict[str, Any]]:
    return server.db.query_events(server.run_id, limit, type, severity, robot_id, zone_id, since_tick)


@app.get("/api/decisions")
def get_decisions(limit: int = 20) -> list[dict[str, Any]]:
    return server.engine.state["recent_decisions"][:limit]


@app.post("/api/inject")
def post_inject(body: dict[str, Any]) -> dict[str, Any]:
    try:
        inj = inject_adapter.validate_python(body)
    except ValidationError as e:
        raise HTTPException(400, str(e)[:300])
    server.engine.inject(inj.model_dump(exclude_none=True))
    return {"ok": True}


@app.post("/api/inject/clear")
def post_clear(body: dict[str, Any]) -> dict[str, Any]:
    server.engine.clear_injection(str(body.get("kind")), str(body.get("target_id")))
    return {"ok": True}


@app.post("/api/tasks")
def post_task(body: NewTask) -> dict[str, Any]:
    return server.engine.create_task(body.type, body.priority, body.source, body.destination, body.load_units)


@app.post("/api/copilot")
async def post_copilot(body: dict[str, Any]) -> dict[str, Any]:
    q = str(body.get("question", "")).strip()
    if not q:
        raise HTTPException(400, "question required")
    snapshot = json.loads(json.dumps(server.engine.state))
    return await asyncio.to_thread(copilot_ai.answer, q, snapshot, server.layout)


@app.post("/api/vlm/observe")
async def post_vlm(body: dict[str, Any]) -> dict[str, Any]:
    """前端把 Live Camera 畫面（JPEG data URL）送來；回傳 VlmObservation 並寫入 cameras[id].last_observation。"""
    cam_id = str(body.get("camera_id", ""))
    eng = server.engine
    if cam_id not in eng.state["cameras"]:
        raise HTTPException(404, "unknown camera")
    if eng.state["cameras"][cam_id]["status"] == "OFFLINE":
        raise HTTPException(409, "camera offline")
    snapshot = json.loads(json.dumps(eng.state))
    obs = await asyncio.to_thread(vlm_ai.observe, cam_id, body.get("image_b64"), snapshot, server.layout)
    eng.state["cameras"][cam_id]["last_observation"] = obs
    sev = obs["severity"] if obs["event"] != "none" else "INFO"
    eng.emit("VLM_OBSERVATION", "VLM", sev, f"{cam_id}: {obs['event'].replace('_', ' ')} ({obs['confidence']:.0%}) — {obs.get('description', '')}", camera_id=cam_id, zone_id=obs["zone"], payload={"confidence": obs["confidence"], "raw": obs.get("raw")})
    if obs["event"] == "human_detected" and obs["blocked"] and obs["confidence"] >= 0.7:
        eng.emit("HUMAN_DETECTED", "VLM", "HIGH", f"Human detected — Zone {obs['zone']} (via {cam_id})", zone_id=obs["zone"], camera_id=cam_id)
        if os.environ.get("TWIN_VLM_ACTS", "0") == "1" and eng.state["zones"][obs["zone"]]["status"] != "BLOCKED":
            eng.block_zone(obs["zone"], "VLM: human detected", 300)
    return obs


@app.post("/api/whatif")
async def post_whatif(body: dict[str, Any]) -> dict[str, Any]:
    """複製 LIVE 引擎、注入情境、跑 duration_ticks、回傳 Baseline vs Scenario 對照。LIVE 不受影響。"""
    try:
        req = WhatIfRequest.model_validate(body).model_dump(exclude_none=True)
    except ValidationError as e:
        raise HTTPException(400, str(e)[:300])
    return await asyncio.to_thread(run_whatif, server.engine, req)


@app.get("/api/ai/status")
def ai_status() -> dict[str, Any]:
    return {"llm": bool(os.environ.get("OPENAI_API_KEY")), "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            "vision_model": os.environ.get("OPENAI_VISION_MODEL", os.environ.get("OPENAI_MODEL", "gpt-4o-mini")), "vlm_acts": os.environ.get("TWIN_VLM_ACTS", "0") == "1"}


@app.post("/api/sim")
def post_sim(body: dict[str, Any]) -> dict[str, Any]:
    action = body.get("action"); speed = body.get("speed")
    if action == "PAUSE": server.paused = True
    elif action == "PLAY": server.paused = False
    elif action == "RESET": server.reset(body.get("seed"))
    if speed in (0, 1, 2, 5, 10): server.speed = speed
    return health()
