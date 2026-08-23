import { create } from "zustand";
import layoutJson from "../layout/warehouse_layout.json";
import type { WarehouseLayout, LayoutLocation } from "../layout/types";
import type { TwinState, RobotId, HeatmapLayer } from "../schema/twin_state";

export type ViewTab = "3D" | "MAP" | "TRAFFIC" | "HEATMAP";
export type Quality = "low" | "medium" | "high";
export type SceneTool = "select" | "pan" | "paths" | "labels" | "measure";

export const layout = layoutJson as unknown as WarehouseLayout;

interface Store {
  twin: TwinState;
  /** layout.locations 以 id 索引 */
  locations: Record<string, LayoutLocation>;
  selectedRobot: RobotId | null;
  viewTab: ViewTab;
  quality: Quality;
  showPaths: boolean;
  showLabels: boolean;
  tool: SceneTool;
  focusTarget: [number, number, number] | null;
  activeCamera: string;
  select: (id: RobotId | null) => void;
  setViewTab: (t: ViewTab) => void;
  setQuality: (q: Quality) => void;
  setTool: (t: SceneTool) => void;
  togglePaths: () => void;
  toggleLabels: () => void;
  focus: (p: [number, number, number] | null) => void;
  setActiveCamera: (id: string) => void;
  /** 模擬控制（Phase 2 本地；Phase 3 改送 SIM_CONTROL） */
  speed: 0 | 1 | 2 | 5 | 10;
  paused: boolean;
  seed: number;
  setSpeed: (v: 0 | 1 | 2 | 5 | 10) => void;
  setPaused: (p: boolean) => void;
  /** 每 tick 由 runner (本地) 或 WebSocket (online) 呼叫 */
  setTwin: (t: TwinState) => void;
  /** 資料來源：online = 後端 WebSocket；local = 前端引擎 fallback */
  source: "connecting" | "online" | "local";
  setSource: (s: "connecting" | "online" | "local") => void;
  /** 後端送來的熱圖層（online 時）；local 時從本地引擎讀 */
  heat: { traffic?: HeatmapLayer; congestion?: HeatmapLayer } | null;
  setHeat: (l: HeatmapLayer | null) => void;
  /** Phase 4 UI：Modal / 抽屜 */
  modal: null | "audit" | "tasks" | "robot" | "fleet";
  setModal: (m: null | "audit" | "tasks" | "robot" | "fleet") => void;
  /** 短暫提示（例如後端回 RATE_LIMITED）；null = 不顯示 */
  notice: { text: string; kind: "warn" | "info"; until: number } | null;
  setNotice: (text: string | null, kind?: "warn" | "info") => void;
  /** 3D / Map 顯示的樓層："all" = 疊起來全顯示 */
  activeFloor: "all" | number;
  setActiveFloor: (f: "all" | number) => void;
  drawer: null | "scenarios" | "ops" | "whatif";
  setDrawer: (d: null | "scenarios" | "ops" | "whatif") => void;
  /** 最近一次 What-if 結果（後端回傳，含 schema 外的 window 對照資料） */
  whatif: unknown | null;
  setWhatIf: (r: unknown | null) => void;
}

/** 空的初始 TwinState（runner 掛載後立刻被引擎快照取代） */
const EMPTY: TwinState = {
  schema_version: "1.0", layout_id: layout.id,
  sim: { tick: 0, tick_ms: 100, speed: 1, mode: "PAUSED", seed: 42, baseline_snapshot_id: null },
  robots: {}, tasks: {}, zones: {}, conveyors: {}, cameras: {}, sensors: {}, people: {}, alerts: {}, recent_events: [], recent_decisions: [],
  kpi: { tick: 0, fleet: { total: 0, active: 0, charging: 0, idle: 0, warning: 0, error: 0, offline: 0 }, operation: { throughput_per_min: 0, completed_today: 0, completed_target: 150, pending: 0, ongoing: 0, avg_task_time_s: 0, on_time_rate: 1, avg_utilization: 0 }, efficiency: { avg_travel_distance_m: 0, avg_wait_time_s: 0, congestion_index: 0, energy_kwh: 0 }, throughput_series: [] },
  subsystems: { WAREHOUSE: "NORMAL", CONVEYORS: "NORMAL", CHARGING: "NORMAL", CCTV: "NORMAL", NETWORK: "NORMAL" },
};

export const useStore = create<Store>((set) => ({
  twin: EMPTY,
  speed: 1, paused: false, seed: 42,
  source: "connecting",
  setSource: (source) => set({ source }),
  modal: null,
  setModal: (modal) => set({ modal }),
  notice: null,
  setNotice: (text, kind = "warn") => set({ notice: text ? { text, kind, until: Date.now() + 4000 } : null }),
  activeFloor: "all",
  setActiveFloor: (activeFloor) => set({ activeFloor }),
  whatif: null,
  setWhatIf: (whatif) => set({ whatif }),
  drawer: null,
  setDrawer: (drawer) => set((st) => ({ drawer: st.drawer === drawer ? null : drawer })),
  heat: null,
  setHeat: (l) => set((st) => (l === null ? { heat: null } : { heat: { ...(st.heat ?? {}), [l.kind === "TRAFFIC" ? "traffic" : "congestion"]: l } })),
  setSpeed: (speed) => set({ speed, paused: speed === 0 }),
  setPaused: (paused) => set({ paused }),
  locations: Object.fromEntries(layout.locations.map((l) => [l.id, l])),
  selectedRobot: null,
  viewTab: "3D",
  quality: "medium",
  showPaths: true,
  showLabels: true,
  tool: "select",
  focusTarget: null,
  activeCamera: "CAM-B01",
  select: (id) => set({ selectedRobot: id }),
  setViewTab: (viewTab) => set({ viewTab }),
  setQuality: (quality) => set({ quality }),
  setTool: (tool) => set({ tool }),
  togglePaths: () => set((s) => ({ showPaths: !s.showPaths })),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  focus: (focusTarget) => set({ focusTarget }),
  setActiveCamera: (activeCamera) => set({ activeCamera }),
  setTwin: (twin) => set({ twin }),
}));

/** 狀態 → 顏色，全 App 共用 */
export const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "#22c55e", CHARGING: "#3b82f6", IDLE: "#eab308", WARNING: "#f97316", ERROR: "#ef4444", OFFLINE: "#6b7280",
};
export const SEVERITY_COLOR: Record<string, string> = {
  INFO: "#3b82f6", LOW: "#3b82f6", MEDIUM: "#3b82f6", HIGH: "#eab308", CRITICAL: "#ef4444",
};
export const ZONE_COLOR = Object.fromEntries(layout.zones.map((z) => [z.id, z.color]));

/** 模擬時鐘：tick 0 = 08:00:00 */
export const SIM_START_S = 8 * 3600;
export function tickToClock(tick: number, tickMs = 100, withSeconds = false): string {
  const s = Math.max(0, Math.floor(SIM_START_S + (tick * tickMs) / 1000));
  const hh = Math.floor(s / 3600) % 24, mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return withSeconds ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(hh)}:${p(mm)}`;
}
