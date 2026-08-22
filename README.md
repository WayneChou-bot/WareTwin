<div align="center">

<img src="docs/logo.svg" width="96" alt="WareTwin logo" />

# WareTwin

**AI Autonomous Warehouse Digital Twin**

*A browser-native digital twin for simulating autonomous robot fleets, operational events, AI-driven decisions and what-if scenarios — before real-world deployment.*

[![CI](https://img.shields.io/github/actions/workflow/status/WayneChou-bot/WareTwin/ci.yml?branch=main&label=CI&logo=github)](../../actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)](https://react.dev)
[![Three.js](https://img.shields.io/badge/Three.js-R3F-000?logo=three.js&logoColor=white)](https://docs.pmnd.rs/react-three-fiber)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Python](https://img.shields.io/badge/Python-3.11-3776ab?logo=python&logoColor=white)](https://python.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://typescriptlang.org)

[**Live demo**](https://ware-twin.vercel.app) · [Demo script](docs/DEMO.md) · [Architecture](#-architecture) · [繁體中文](README.zh-TW.md)

<img src="docs/demo.gif" width="880" alt="WareTwin demo: 20 AMRs running, compound failure injected, VLM detects a human, Copilot explains the throughput drop" />

</div>

---

## ✨ What it does

WareTwin is a real-time **3D digital twin** of a 100 × 70 m warehouse with **20 autonomous mobile robots**, four zones, conveyors, packing stations, chargers and virtual CCTV. A deterministic simulation engine drives every robot through a full state machine (pick → transport → deliver, low-battery hand-off, obstacle re-planning); a Fleet Manager assigns tasks with **explainable scoring**; an AI layer watches the same state to **explain**, **perceive** and **predict**.

It runs on a laptop with an integrated GPU — no RTX, no ROS, no cloud required.

| | |
|---|---|
| 🏭 **3D Digital Twin** | React Three Fiber scene from a single `warehouse_layout.json`: instanced racks, AMRs with live A* paths, zone overlays, virtual CCTV, map / traffic / heatmap views. Quality tiers for integrated GPUs. |
| 🤖 **Robot fleet simulation** | Deterministic 100 ms tick engine: FSM, 8-direction A* on a traffic-weighted grid, cell reservation with deadlock breakers, battery model with charger scheduling, conveyors that actually bottleneck stations. |
| 🧠 **Explainable Fleet Manager** | Every assignment shows the selected robot's reasons (distance, battery, workload, congestion, health) and why each rejected candidate lost. |
| ⚡ **Scenario injection** | Robot failure, low battery, conveyor stop, human intrusion (zone block + re-route), traffic congestion, camera outage, demand burst — one click each, all reversible. |
| 🔮 **What-if simulation** | Clone the live twin, inject, run 1–10 min, compare 12 metrics against a baseline with the same random seed. The live system is never touched. |
| 💬 **AI Operations Copilot** | Ask "Why is throughput dropping?" — the answer is grounded in the live state and cites robots / tasks / events you can click. LLM optional (see [AI modes](#-ai-modes)). |
| 📡 **On-robot perception** | Each AMR carries a virtual 270° / 4 m LiDAR: it sees other robots and people (with line-of-sight occlusion by racks), slows down and holds distance instead of relying on grid reservations alone, and reports `CLEAR / SLOWING / STOPPED` plus the obstacles it sees — visualised as a sensor fan in 3D. |
| 👁️ **VLM perception** | Send a virtual CCTV frame to a vision model → `{event, severity, bbox, confidence}` drawn on the feed. |
| 🔌 **Real-time sync** | FastAPI + WebSocket: one `FULL` state, then per-tick `PATCH` diffs (~12 KB/s). If the backend is unreachable the browser falls back to a built-in TypeScript engine and keeps running. |
| 📜 **Audit log & KPI** | Every event persisted to SQLite with filters and CSV/JSON export; throughput, utilization, on-time rate, wait time, congestion, energy. |

## 🚀 Quick start

**Prerequisites:** Node 18+, Python 3.11 (conda or venv).

```bash
git clone https://github.com/WayneChou-bot/WareTwin.git && cd WareTwin

# backend
cd backend
conda create -n waretwin python=3.11 -y && conda activate waretwin   # or: python -m venv .venv
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# frontend (new terminal)
cd frontend
npm install
npm run dev          # → http://localhost:5173
```

The top bar shows a blue **BACKEND** badge when the browser is connected to the Python engine, or an orange **LOCAL** badge when it is running the built-in fallback engine. On Windows, `dev.ps1` starts both.

Then follow the [demo script](docs/DEMO.md) — ten scenarios, from normal operation to a compound failure handled end-to-end.

## 🧩 AI modes

The AI layer never needs a key to run. Set `OPENAI_API_KEY` in `backend/.env` (see `.env.example`) to switch from demo mode to live models:

| | Demo mode (default, no key) | LLM mode |
|---|---|---|
| Copilot | Rule-based analysis of the live state (throughput, congestion, assignment, failure risk, improvement), with citations | `gpt-4o-mini`, JSON-schema output, citations restricted to ids present in the snapshot |
| VLM | Simulated perception from ground truth (`sim` tag) | Vision model on the actual CCTV frame |
| What-if recommendation | Templated two-liner from the deltas | LLM two-liner |

The public demo runs in demo mode on purpose: it is fully functional and cannot run up an API bill.

## 🏗 Architecture

<img src="docs/architecture.svg" width="100%" alt="Architecture: browser (R3F twin, UI, store, local fallback engine) ↔ WebSocket ↔ FastAPI (SimEngine, What-if, AI, Twin State, SQLite)" />

The **Twin State** is the single contract — `frontend/src/schema/twin_state.ts` ≡ `backend/app/schema.py` (Pydantic). Both engines share the same PRNG bit-for-bit, so the task stream and assignments are identical; What-if runs on the backend by deep-cloning the engine (state + FSM runtime + RNG).

```
WareTwin/
├── frontend/        React 18 · TypeScript · Vite · React Three Fiber · zustand
│   └── src/simulation/   TypeScript engine (local fallback)
├── backend/         FastAPI · Pydantic v2 · asyncio · SQLite
│   └── app/sim/          Python engine · A* · What-if
│   └── app/ai/           Copilot · VLM
├── docs/            schema · layout generator · demo script · screenshots
└── dev.ps1
```

## 🧪 Tests

```bash
cd backend && python -m pytest -q      # 17 tests: PRNG parity, A*, 20-min stress (no collisions < 0.5 m), determinism,
                                        #           low battery, intrusion, gridlock-free compound failure, WS/REST, AI, What-if
cd frontend && npm test                 # 8 tests: same engine contract in TypeScript
```

## ☁️ Deployment

Frontend is static (Vercel / GitHub Pages); backend is a long-running WebSocket service (Render / Fly.io / any container — not serverless). `backend/render.yaml`, `Dockerfile`, `fly.toml` and `frontend/vercel.json` are included; set `VITE_WS_URL=wss://…/ws` on the frontend and `TWIN_CORS_ORIGINS` on the backend. Details in [`frontend/README.md`](frontend/README.md#部署).

## 🗺 Roadmap

- [x] Phase 1 – 3D foundation · [x] Phase 2 – robot simulation · [x] Phase 3 – backend + WebSocket · [x] Phase 4 – operations · [x] Phase 5 – AI · [x] Phase 6 – What-if · [x] Phase 7 – on-robot perception & local avoidance
- [ ] Phase 8 – Robotics extension: feed robot poses from ROS 2 / Webots into `SimEngine.step()`; the Twin State contract and UI stay unchanged
- [ ] Multi-agent path planning (CBS / time-window reservations) to replace the yield/back-off deadlock breaker
- [ ] PostgreSQL + Redis for multi-instance deployments

## 📚 Data & acknowledgements

- The warehouse layout is **synthetic**, generated by `docs/layout/gen_layout.py`; no third-party map or open dataset is used.
- Fonts: [Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/) via Google Fonts (SIL OFL 1.1).
- Built with [Three.js](https://threejs.org) · [React Three Fiber](https://docs.pmnd.rs/react-three-fiber) · [drei](https://github.com/pmndrs/drei) · [zustand](https://github.com/pmndrs/zustand) · [FastAPI](https://fastapi.tiangolo.com) · [Pydantic](https://docs.pydantic.dev) · [OpenAI Python SDK](https://github.com/openai/openai-python) — all MIT/BSD/Apache licensed.
- The reference imagery used during design (NVIDIA Isaac Sim screenshots, AMR product photos) is not included in this repository.

## 📄 License

[MIT](LICENSE) © 2026 Wayne Chou
