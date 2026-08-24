<div align="center">

<img src="docs/logo.svg" width="96" alt="WareTwin logo" />

# WareTwin

**AI 自動化倉儲數位分身**

*在真實部署之前，於瀏覽器中模擬自主機器人車隊、營運事件、AI 決策與 What-if 情境。*

[![CI](https://img.shields.io/github/actions/workflow/status/WayneChou-bot/WareTwin/ci.yml?branch=main&label=CI&logo=github)](../../actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)](https://react.dev)
[![Three.js](https://img.shields.io/badge/Three.js-R3F-000?logo=three.js&logoColor=white)](https://docs.pmnd.rs/react-three-fiber)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Python](https://img.shields.io/badge/Python-3.11-3776ab?logo=python&logoColor=white)](https://python.org)

[**線上 Demo**](https://ware-twin.vercel.app) · [Demo 腳本](docs/DEMO.md) · [架構](#-架構) · [English](README.md)

<img src="docs/demo.gif" width="880" alt="WareTwin demo" />

</div>

---

## ✨ 這是什麼

WareTwin 是一個 100 × 70 m 倉庫的即時 **3D 數位分身**：20 台自主移動機器人（AMR）、四個 Zone、輸送帶、包裝站、充電樁與虛擬 CCTV。確定性的模擬引擎驅動每台機器人走完整的狀態機（取貨 → 運送 → 卸貨、低電量交接、遇障重新規劃）；Fleet Manager 以**可解釋的評分**指派任務；AI 層讀同一份狀態來**解釋、感知與預測**。

在內顯筆電上就能跑——不需要 RTX、ROS 或雲端。

| | |
|---|---|
| 🏭 **3D 數位分身** | 由單一 `warehouse_layout.json` 產生的 React Three Fiber 場景：instanced 貨架、帶即時 A* 路徑的 AMR、Zone 覆蓋層、虛擬 CCTV、地圖／交通／熱圖視角。內顯用的品質分級。 |
| 🤖 **機器人車隊模擬** | 100 ms tick 的確定性引擎：FSM、交通加權格點上的 8 方向 A*、格點預約與死鎖解除、電池模型與充電排程、會真的造成瓶頸的輸送帶。 |
| 🧠 **可解釋的 Fleet Manager** | 每次指派都列出選中機器人的理由（距離、電量、負載、擁塞、健康）以及每個落選者為什麼輸。 |
| ⚡ **情境注入** | 機器人故障、低電量、輸送帶停機、人員闖入（封鎖 Zone + 改道）、交通擁塞、攝影機離線、需求爆量——一鍵注入、皆可解除。 |
| 🔮 **What-if 模擬** | 複製當下的 Twin、注入、跑 1–10 分鐘，以同一個亂數種子的 Baseline 比較 12 項指標。LIVE 完全不受影響。 |
| 💬 **AI 營運 Copilot** | 問「Why is throughput dropping?」——答案來自即時狀態並引用可點擊的機器人／任務／事件。LLM 可選（見 [AI 模式](#-ai-模式)）。 |
| 🏢 **多樓層與貨梯** | 鋼構夾層（厚樓板、主次梁、立柱、護欄）有自己的貨架、Zone、攝影機與導航網格。兩座貨梯是後端權威的完整狀態機——預約、FIFO 排隊、滑動門與安全連鎖（門開著不會動）、smoothstep 平台載著機器人升降、冷卻、故障自動改走另一座。機器人依 排隊 → 上車 → 搭乘 → 下車 → 重新規劃 流程，樓層只能在這個流程內改變。 |
| 📡 **機上感知** | 每台 AMR 配備虛擬 270°／4 m LiDAR：看得到其他機器人與人員（貨架會遮擋視線），主動減速與保持車距，不再只靠格子預約；回報 `CLEAR / SLOWING / STOPPED` 與所見障礙，3D 畫面以感測扇形呈現。 |
| 👁️ **VLM 感知** | 把虛擬 CCTV 畫面送給視覺模型 → `{event, severity, bbox, confidence}` 疊在畫面上。 |
| 🔌 **即時同步** | FastAPI + WebSocket：一次 `FULL`，之後每 tick `PATCH` 差異（約 12 KB/s）。後端連不上時瀏覽器自動切換到內建的 TypeScript 引擎繼續運作。 |
| 📜 **稽核紀錄與 KPI** | 每個事件寫入 SQLite，可篩選並匯出 CSV／JSON；吞吐、利用率、準時率、等待時間、擁塞、能耗。 |

## 🚀 快速開始

**需求：** Node 18+、Python 3.11（conda 或 venv）。

```bash
git clone https://github.com/WayneChou-bot/WareTwin.git && cd WareTwin

# 後端
cd backend
conda create -n waretwin python=3.11 -y && conda activate waretwin
pip install -r requirements-dev.txt   # runtime + pytest/httpx (requirements.lock = fully pinned, used by Render/Docker)
uvicorn app.main:app --reload --port 8000

# 前端（另一個終端）
cd frontend
npm install
npm run dev          # → http://localhost:5173
```

TopBar 顯示藍色 **BACKEND** 代表瀏覽器已連上 Python 引擎；橘色 **LOCAL** 代表正在跑內建的備援引擎。Windows 可直接執行 `dev.ps1` 同時啟動兩者。

接著照 [Demo 腳本](docs/DEMO.md) 走十個情境，從正常運作到端到端處理複合故障。

## 🧩 AI 模式

AI 層不需要金鑰也能運作。在 `backend/.env` 設定 `OPENAI_API_KEY`（參考 `.env.example`）即可從 demo 模式切到真實模型：

| | Demo 模式（預設，無金鑰） | LLM 模式 |
|---|---|---|
| Copilot | 對即時狀態做規則式分析（吞吐、擁塞、指派、故障風險、改善建議），附引用 | `gpt-4o-mini`，JSON schema 輸出，引用限定快照中存在的 id |
| VLM | 以 ground truth 模擬感知（標示 `sim`） | 視覺模型分析實際 CCTV 畫面 |
| What-if 建議 | 由差異值套版產生的兩句話 | LLM 寫的兩句話 |

公開 Demo 刻意跑在 demo 模式：功能完整，且不會產生 API 費用。

## 🏗 架構

<img src="docs/architecture.svg" width="100%" alt="架構圖" />

**Twin State** 是唯一的契約——`frontend/src/schema/twin_state.ts` ≡ `backend/app/schema.py`（Pydantic）。兩個引擎共用 bit-level 一致的 PRNG，任務序列與指派結果相同；What-if 在後端以深拷貝引擎（狀態 + FSM 執行期 + 亂數）執行。

```
WareTwin/
├── frontend/        React 18 · TypeScript · Vite · React Three Fiber · zustand
│   └── src/simulation/   TypeScript 引擎（本地備援）
├── backend/         FastAPI · Pydantic v2 · asyncio · SQLite
│   └── app/sim/          Python 引擎 · A* · What-if
│   └── app/ai/           Copilot · VLM
├── docs/            schema · layout 產生器 · demo 腳本 · 截圖
└── dev.ps1
```

## 🧪 測試

```bash
cd backend && python -m pytest -q      # 50 個：PRNG 對照、A*、20 分鐘壓力（無 < 0.5 m 碰撞）、感知、確定性、低電量、闖入、電梯、複合故障不死鎖、WS/REST、AI、What-if
cd frontend && npm test                 # 32 個：TypeScript 引擎的相同契約
```

## ☁️ 部署

前端是靜態檔（Vercel／GitHub Pages）；後端是長駐的 WebSocket 服務（Render／Fly.io／任何 container，不能用 serverless）。已附 `backend/render.yaml`、`Dockerfile`、`fly.toml` 與 `frontend/vercel.json`；前端設 `VITE_WS_URL=wss://…/ws`、後端設 `TWIN_CORS_ORIGINS`。細節見 [`frontend/README.md`](frontend/README.md#部署)。

## 🔒 公開部署的防護

線上 Demo 刻意是**一份共享的模擬**——所有訪客看同一座倉庫、可以注入同樣的故障，這正是 Demo 的意義。為了讓它可以安全公開，後端帶了一層防護（`backend/app/guard.py`）：

| 防護 | 預設 |
|---|---|
| 輸入上限 | `TASK_BURST.count ≤ 30`、注入時長 ≤ 10 分鐘、What-if ≤ 8 個注入／10 分鐘、Copilot 問題 ≤ 500 字、VLM 影像 ≤ 400 KB；任務地點必須存在、符合任務類型、不可是充電樁（`sim/rules.py`，TS 同步） |
| Rate limit（每個 client IP，記憶體內、會回收） | 改變狀態 20 次/分 · Copilot 與 VLM 10 次/分 · What-if 4 次/分 · WebSocket 訊息 120 次/分 → `429` / `RATE_LIMITED`。client IP 取 `X-Forwarded-For` 最後一段（`TWIN_TRUSTED_PROXIES`），無法偽造 |
| Origin 檢查 | 設了 `TWIN_CORS_ORIGINS` 後，WebSocket 與 POST 必須帶允許的 `Origin`。正式環境只允許 `https://ware-twin.vercel.app`；Vercel preview 預設不開，需要時再加鎖定自己 scope slug 的 `TWIN_CORS_REGEX`（`TWIN_ALLOW_NO_ORIGIN=1` 可放行 curl） |
| Body 大小 | REST 512 KB 在 ASGI stream 層以實際 bytes 計算（chunked／造假 `Content-Length` 都擋）、WebSocket 單則 64 KB（UTF-8 bytes） |
| Health | 模擬 task 死掉或超過 `TWIN_HEALTH_STALL_S` 秒沒推進，`/api/health` 回 `503`，Render 會自動重啟 |

讀取（`/api/state`、`/api/health`…）不受限；本機開發可設 `TWIN_RATE_LIMIT=0` 關掉。介面為桌面設計（≥ 1280 px 最佳，1024 px 起可用），更窄的螢幕會看到提示頁而不是縮到 0.25 倍的畫面，且提示頁背後不會啟動模擬。審計紀錄存在 instance 上的 SQLite，free tier 更換 instance 時會重置。

## 🗺 Roadmap

- [x] Phase 1 3D 基礎 · [x] Phase 2 機器人模擬 · [x] Phase 3 後端 + WebSocket · [x] Phase 4 營運 · [x] Phase 5 AI · [x] Phase 6 What-if · [x] Phase 7 機上感知 · [x] Phase 8 多樓層 + 貨梯、輸送帶動畫
- [ ] Phase 9 機器人擴充：把 ROS 2／Webots 的機器人位姿餵進 `SimEngine.step()`，Twin State 契約與 UI 不變
- [ ] 多機協同規劃（CBS／時間窗預約）取代目前的讓路／退避死鎖解除
- [ ] PostgreSQL + Redis 支援多實例部署

## 📚 資料與致謝

- 倉庫佈局為**合成資料**，由 `docs/layout/gen_layout.py` 產生；未使用任何第三方圖資或開放資料集。
- 字型：[Inter](https://rsms.me/inter/)、[JetBrains Mono](https://www.jetbrains.com/lp/mono/)，經 Google Fonts（SIL OFL 1.1）。
- 使用 [Three.js](https://threejs.org)、[React Three Fiber](https://docs.pmnd.rs/react-three-fiber)、[drei](https://github.com/pmndrs/drei)、[zustand](https://github.com/pmndrs/zustand)、[FastAPI](https://fastapi.tiangolo.com)、[Pydantic](https://docs.pydantic.dev)、[OpenAI Python SDK](https://github.com/openai/openai-python)——皆為 MIT／BSD／Apache 授權。
- 設計期間參考的圖片（NVIDIA Isaac Sim 截圖、AMR 產品照）不包含在本 repo 中。

## 📄 授權

[MIT](LICENSE) © 2026 Wayne Chou
