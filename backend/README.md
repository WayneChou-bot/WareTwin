# AI Autonomous Warehouse Digital Twin — Backend (Phase 3–5)

```
Simulation (asyncio) → Twin State → WebSocket FULL / PATCH → Browser → 3D Scene
```

FastAPI + Pydantic v2 + WebSocket + SQLite。模擬引擎是 `frontend/src/simulation/engine.ts` 的 Python 移植版（方法名、tick 順序、FSM、權重、參數逐一對應）。

## 啟動

```bash
cd backend
python -m venv .venv && .venv\Scripts\activate     # Windows；macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

然後另一個終端跑前端 `npm run dev`。前端啟動時會連 `ws://localhost:8000/ws`，TopBar 出現藍色 **BACKEND** 代表走後端；連不上會自動退回前端本地引擎並顯示橘色 **LOCAL**，後端起來後 3 秒內自動接回。

環境變數：`TWIN_SEED`（預設 42）、`TWIN_DB`（預設 `twin.db`）；公開部署的防護（`TWIN_CORS_ORIGINS`、`TWIN_CORS_REGEX`、`TWIN_TRUSTED_PROXIES`、`TWIN_RATE_LIMIT`、`TWIN_HEALTH_STALL_S`）見 `.env.example` 與根目錄 README「Running it in public」。前端可用 `VITE_WS_URL` 覆寫後端位址。

## 測試

```bash
pip install -r requirements-dev.txt
python -m pytest -q          # 32 tests：PRNG 與 JS 逐 bit 一致、A*、20 分鐘壓力、確定性、低電量、人員入侵、感知、REST + WebSocket 協定、AI、What-if、防護層（rate limit / Origin / body 上限 / 任務地點）
```

## AI（Phase 5）

`cp .env.example .env` 填入 `OPENAI_API_KEY`（後端自動讀 .env；前端永遠碰不到 key）。`GET /api/ai/status` 看目前是 LLM 還是 fallback。

- **Copilot** `app/ai/copilot.py`：`summarize_state()` 把 TwinState 濃縮成 ~3k token 的營運摘要（KPI、fleet、zones、conveyors、alerts、最近 5 個決策、最近 30 個非 LOW 事件）→ Chat Completions 強制 JSON schema `{text, citations, confidence}` → 引用過濾（只留快照裡存在的 id）。呼叫失敗或無 key → `rule_based_answer()`：針對 throughput / 指派 / 故障預測 / 擁塞 / 改善建議六類問題做規則式分析，回答同樣附引用。
- **VLM** `app/ai/vlm.py`：前端送 Live Camera 的 JPEG → vision model 強制 JSON `{event, severity, blocked, confidence, bbox, description}`；telemetry hint 只給機器人數量不給人員位置（不洩漏答案）。無 key → `simulated_observation()` 用 ground truth。結果寫入 `cameras[id].last_observation` 並發 `VLM_OBSERVATION` 事件；`TWIN_VLM_ACTS=1` 時 human_detected ≥ 0.7 會真的封鎖 Zone（`engine.block_zone`），預設關閉。
- LLM 呼叫都在 `asyncio.to_thread`，不會卡模擬迴圈。

## API

| 路徑 | 說明 |
|---|---|
| `WS /ws` | 連線後先收 `FULL`，之後每 tick `PATCH`，每 30 tick 兩層 `HEATMAP`（TRAFFIC 短期 / CONGESTION 長期）。接受 `SIM_CONTROL` `INJECT` `CLEAR_INJECTION` `CREATE_TASK` `ACK_ALERT` `RESYNC` `COPILOT_ASK`（回 `COPILOT_REPLY`）；`WHATIF_RUN`（回 `WHATIF_RESULT`；同時只跑一個，每 IP 4 次/分） |
| `GET /api/health` | tick、倍速、連線數、實際 tick rate；模擬 task 死掉或 10 秒沒推進回 `503`（Render 據此重啟） |
| `GET /api/state` | 完整 TwinState |
| `GET /api/state/validate` | 用 Pydantic 驗證目前 state 符合契約 |
| `GET /api/events?limit&type&severity&robot_id&zone_id&since_tick` | 從 SQLite 查事件（Audit Log 用） |
| `GET /api/decisions` | 最近的 Fleet Manager 決策（含候選評分與拒絕原因） |
| `GET /api/kpi` `GET /api/layout` | |
| `POST /api/inject` | body = ScenarioInjection，例如 `{"kind":"HUMAN_INTRUSION","zone_id":"B","duration_ticks":600}` |
| `POST /api/inject/clear` | `{"kind":"CONVEYOR_FAILURE","target_id":"CV03"}` 解除注入 |
| `POST /api/tasks` | body = NewTask |
| `POST /api/copilot` | `{"question": "..."}` → `{text, citations, confidence, model}` |
| `POST /api/vlm/observe` | `{"camera_id": "CAM-B01", "image_b64": "data:image/jpeg;base64,..."}` → VlmObservation（image_b64 省略 = 模擬） |
| `GET /api/ai/status` | llm 是否啟用、模型名、vlm_acts |
| `POST /api/sim` | `{"action":"PLAY"|"PAUSE"|"RESET","speed":1|2|5|10}` |

## PATCH 協定

每 tick 一則 `{"type":"PATCH","base_tick","tick","patch","events"}`：

- `patch.sim` 每次都有；`patch.robots[id]` 只含有變動的欄位（`path` 只在路徑改變時出現），前端用 `{...prev, ...patch}` 合併；
- `tasks / zones / conveyors / cameras / sensors / people / alerts` 以 id 為 key 只送變動項目，值為 `null` 表示刪除；
- `kpi` 每 10 tick、`subsystems` 變動時、`recent_decisions` 有新決策時；
- `events` 是這個 tick 新產生的事件陣列，前端 prepend 到 ring（500）。
- 前端若發現 `base_tick ≠ 本地 tick`（分頁休眠等）送 `RESYNC` 要 `FULL`。

頻寬實測：1× 約 12 KB/s，10× 約 120 KB/s（單一連線）。

## 效能

Python 引擎 0.3 ms/tick（20 台機器人、7,000 格 A*）。10× 倍速需要每秒 100 tick ≈ 30 ms CPU，很寬裕。模擬迴圈每幀最多 40 tick，分頁／機器卡住時不會爆衝。

## 與 TypeScript 引擎的一致性

`tests/test_engine.py::test_prng_matches_js` 確保亂數流 bit-level 相同，所以任務產生序列、指派結果、FSM 轉換在前 1,500 tick 完全一致。之後位置會逐漸分歧（最終 KPI 差距 < 5%）——原因是 A* 在**等成本路徑**上的 tie-break 順序不同（heap 實作差異），兩邊都是合法最短路徑。What-if 因此完全在後端跑（clone 同一個引擎），不依賴前後端 bit-level 一致；統一 heap tie-break 規則列在 Roadmap。

## 目錄

```
app/main.py          FastAPI、WebSocket、模擬迴圈、diff
app/db.py            SQLite（events / kpi_snapshots / decisions）
app/schema.py        Pydantic 契約（= docs/schema/twin_state.py）
app/sim/astar.py     A*
app/sim/navgrid.py   layout → 導航網格
app/sim/engine.py    模擬引擎
app/warehouse_layout.json   與前端同一份
tests/
```
