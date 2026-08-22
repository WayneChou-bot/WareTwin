/**
 * WebSocket client（Phase 3）
 *
 *  Backend → FULL / PATCH / HEATMAP / ERROR   →  store.twin / store.heat
 *  UI      → SIM_CONTROL / INJECT / CREATE_TASK / ACK_ALERT / RESYNC
 *
 * PATCH 合併規則（與 backend/app/main.py make_patch 對應）：
 *  - sim / kpi / subsystems / recent_decisions：整段取代
 *  - robots：每台 {...prev, ...patch}（path 只在變更時出現）
 *  - tasks / zones / conveyors / cameras / sensors / people / alerts：以 id 合併；值為 null 代表刪除
 *  - events：prepend 到 recent_events（ring 500）
 * 若 patch.base_tick 與本地 tick 不符 → 送 RESYNC 要 FULL。
 */
import type { ServerMessage, ClientMessage, TwinState, HeatmapLayer, RobotState } from "../schema/twin_state";
import { THRESHOLDS } from "../schema/twin_state";
import { useStore } from "../state/store";

export type ConnState = "connecting" | "online" | "offline";

const WS_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env?.VITE_WS_URL ?? `ws://${location.hostname}:8000/ws`;
/** REST base（由 WS_URL 推導）：ws://host:8000/ws → http://host:8000 */
export const API_URL = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");
const COLLECTIONS = ["tasks", "zones", "conveyors", "cameras", "sensors", "people", "alerts"] as const;

let socket: WebSocket | null = null;
let reconnectTimer = 0;
let stopped = false;
let localTick = -1;
let onStateChange: ((s: ConnState) => void) | null = null;
type CopilotReply = { request_id: string; text: string; citations: Array<{ robot_id?: string; task_id?: string; event_id?: string }>; model?: string };
const copilotListeners = new Set<(r: CopilotReply) => void>();
/** 訂閱 COPILOT_REPLY；回傳取消函式 */
export function onCopilotReply(fn: (r: CopilotReply) => void): () => void { copilotListeners.add(fn); return () => copilotListeners.delete(fn); }
const whatifListeners = new Set<(r: unknown) => void>();
export function onWhatIfResult(fn: (r: unknown) => void): () => void { whatifListeners.add(fn); return () => whatifListeners.delete(fn); }

export function wsSend(msg: ClientMessage): boolean {
  if (socket && socket.readyState === WebSocket.OPEN) { socket.send(JSON.stringify(msg)); return true; }
  return false;
}

export function wsConnect(onChange: (s: ConnState) => void) {
  stopped = false; onStateChange = onChange;
  open();
  // 分頁從背景回到前景：累積的 PATCH 可能被瀏覽器節流，直接要一份 FULL 最省事
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { localTick = -1; wsSend({ type: "RESYNC" }); } });
}
export function wsDisconnect() { stopped = true; clearTimeout(reconnectTimer); socket?.close(); socket = null; }

function open() {
  if (stopped) return;
  onStateChange?.("connecting");
  let ws: WebSocket;
  try {
    // https 頁面開 ws:// 會同步丟 SecurityError（沒設 VITE_WS_URL 時），要接住，否則整個 App 掛掉
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn("[ws] cannot open", WS_URL, e, "— falling back to local engine");
    onStateChange?.("offline");
    return;
  }
  socket = ws;
  const timeout = window.setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 2500);
  ws.onopen = () => { clearTimeout(timeout); onStateChange?.("online"); };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data) as ServerMessage);
  ws.onerror = () => { /* onclose 會處理 */ };
  ws.onclose = () => {
    clearTimeout(timeout);
    if (socket === ws) socket = null;
    onStateChange?.("offline");
    if (!stopped) reconnectTimer = window.setTimeout(open, 3000);
  };
}

function handle(msg: ServerMessage) {
  const st = useStore.getState();
  switch (msg.type) {
    case "FULL": {
      localTick = msg.state.sim.tick;
      st.setTwin(msg.state); syncControls(msg.state);
      break;
    }
    case "PATCH": {
      if (localTick >= 0 && msg.base_tick !== localTick && msg.base_tick !== msg.tick) {
        // 漏掉了 tick（例如分頁休眠），要求全量重送
        localTick = -1; wsSend({ type: "RESYNC" }); return;
      }
      localTick = msg.tick;
      const next = applyPatch(st.twin, msg);
      st.setTwin(next); if (msg.patch.sim) syncControls(next);
      break;
    }
    case "HEATMAP": st.setHeat(msg.layer); break;
    case "COPILOT_REPLY": copilotListeners.forEach((fn) => fn(msg as unknown as CopilotReply)); break;
    case "WHATIF_RESULT": whatifListeners.forEach((fn) => fn(msg.result)); break;
    case "ERROR": console.warn("[ws] server error", msg.code, msg.message); break;
    default: break;
  }
}

/** 後端是權威：播放/暫停/倍速以 sim 欄位為準（例如另一個分頁按了暫停） */
function syncControls(t: TwinState) {
  const st = useStore.getState();
  if (st.speed !== t.sim.speed) st.setSpeed(t.sim.speed);
  const paused = t.sim.mode === "PAUSED";
  if (st.paused !== paused) st.setPaused(paused);
}

type Patch = Extract<ServerMessage, { type: "PATCH" }>;

function applyPatch(prev: TwinState, msg: Patch): TwinState {
  const p = msg.patch as Record<string, unknown>;
  const next: TwinState = { ...prev };
  if (p.sim) next.sim = { ...prev.sim, ...(p.sim as TwinState["sim"]) };
  if (p.kpi) next.kpi = p.kpi as TwinState["kpi"];
  if (p.subsystems) next.subsystems = p.subsystems as TwinState["subsystems"];
  if (p.recent_decisions) next.recent_decisions = p.recent_decisions as TwinState["recent_decisions"];
  if (p.robots) {
    const robots = { ...prev.robots };
    for (const [id, d] of Object.entries(p.robots as Record<string, Partial<RobotState>>)) robots[id] = { ...robots[id], ...d } as RobotState;
    next.robots = robots;
  }
  for (const key of COLLECTIONS) {
    const d = p[key] as Record<string, unknown> | undefined;
    if (!d) continue;
    const col = { ...(prev[key] as Record<string, unknown>) };
    for (const [id, v] of Object.entries(d)) { if (v === null) delete col[id]; else col[id] = v; }
    (next as unknown as Record<string, unknown>)[key] = col;
  }
  if (msg.events.length) next.recent_events = [...msg.events.slice().reverse(), ...prev.recent_events].slice(0, THRESHOLDS.EVENT_RING_SIZE);
  return next;
}

export type { HeatmapLayer };
