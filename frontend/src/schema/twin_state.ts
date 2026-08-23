/**
 * AI Autonomous Warehouse Digital Twin — Twin State 資料契約 (TypeScript)
 *
 * 規則：
 *  1. 這個檔案是前後端唯一的真相來源 (single source of truth)，與 twin_state.py 逐欄對應。
 *  2. 所有型別都是「純資料」：不得含 Three.js 物件、函式、class 實例。
 *     這是 What-if Simulation 能直接 JSON.parse(JSON.stringify(state)) 複製的前提。
 *  3. 座標系：右手座標，單位公尺。x = 倉庫長邊 (0..100)、z = 倉庫短邊 (0..70)、y = 高度。
 *     與 warehouse_layout.json 一致。
 *  4. 時間：tick 為模擬時間單位 (固定 100 ms 模擬時間)，sim_time_ms = tick * 100。
 *     wall_time 只用於 UI 顯示，不參與任何邏輯。
 *  5. 所有 enum 值使用大寫字串，方便日誌閱讀與 Pydantic 對應。
 */

// ─────────────────────────────────────────────────────────────
// 基礎型別
// ─────────────────────────────────────────────────────────────

/** [x, y, z]，公尺 */
export type Vec3 = [number, number, number];
/** [x, z]，公尺，用於 2D 導航 / 路徑 */
export type Vec2 = [number, number];
/** 導航格點座標 [col, row]，整數 */
export type GridCell = [number, number];

export type RobotId = string;      // "R01" .. "R20"
export type TaskId = string;       // "A3812"
export type ZoneId = string;       // "A" | "B" | "C" | "D"
export type ConveyorId = string;   // "CV01"
export type CameraId = string;     // "CAM-B03"
export type SensorId = string;     // "S-A01"
export type EventId = string;      // ULID / uuid
export type AlertId = string;
export type LocationId = string;   // "SHELF-A12" | "PACK-01" | "CHG-03" | "INBOUND-1"

// ─────────────────────────────────────────────────────────────
// Enum
// ─────────────────────────────────────────────────────────────

/** 規格 3️⃣ Robot Status — 給 UI 用的「彙總狀態」 */
export type RobotStatus =
  | "ACTIVE"
  | "CHARGING"
  | "IDLE"
  | "WARNING"
  | "ERROR"
  | "OFFLINE";

/** 規格 4️⃣ State Machine — 給模擬引擎用的「細部狀態」，UI 以 RobotStatus 為主 */
export type RobotFsmState =
  | "IDLE"
  | "TASK_ASSIGNED"
  | "NAVIGATING"
  | "PICKING"
  | "TRANSPORTING"
  | "DELIVERING"
  | "COMPLETED"
  | "OBSTACLE_DETECTED"
  | "REPLANNING"
  | "LOW_BATTERY"
  | "TASK_TRANSFER"
  | "GOING_TO_CHARGE"
  | "CHARGING"
  | "OFFLINE"
  | "ERROR";

export type TaskType = "PICK" | "TRANSPORT" | "REPLENISH" | "RETURN";
export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
export type TaskStatus =
  | "WAITING"        // 尚未指派
  | "ASSIGNED"       // 已指派，機器人尚未出發
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TRANSFERRED";   // 因低電量等原因轉給其他機器人 (原任務封存，新任務繼承 parent_task_id)

export type ConveyorStatus = "RUNNING" | "WARNING" | "STOPPED" | "MAINTENANCE" | "ERROR";
export type DeviceStatus = "ONLINE" | "DEGRADED" | "OFFLINE";
export type ZoneStatus = "NORMAL" | "CONGESTED" | "BLOCKED" | "RESTRICTED";
export type SubsystemStatus = "NORMAL" | "WARNING" | "ERROR";
export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type EventSource =
  | "ROBOT" | "SENSOR" | "CAMERA" | "VLM" | "CONVEYOR"
  | "SIMULATION" | "FLEET_MANAGER" | "PLANNER" | "USER" | "AI_AGENT" | "LIFT";

export type EventType =
  // Robot
  | "ROBOT_STATE_CHANGED"
  | "ROBOT_BATTERY_LOW"
  | "ROBOT_BATTERY_CRITICAL"
  | "ROBOT_OFFLINE"
  | "ROBOT_ONLINE"
  | "ROBOT_COLLISION_AVOIDED"
  // Task
  | "TASK_CREATED"
  | "TASK_ASSIGNED"
  | "TASK_STARTED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_TRANSFERRED"
  // Planning
  | "ROUTE_PLANNED"
  | "ROUTE_REPLANNED"
  | "OBSTACLE_DETECTED"
  // Zone / environment
  | "ZONE_BLOCKED"
  | "ZONE_UNBLOCKED"
  | "ZONE_CONGESTION_HIGH"
  | "HUMAN_DETECTED"
  | "HUMAN_CLEARED"
  // Lift（規格書 §19）
  | "LIFT_RESERVED"
  | "LIFT_QUEUE_ENTERED"
  | "LIFT_ARRIVED"
  | "LIFT_GATE_OPENED"
  | "ROBOT_BOARDED"
  | "LIFT_DEPARTED"
  | "ROBOT_EXITED"
  | "LIFT_FAULT"
  | "LIFT_RESERVATION_RELEASED"
  // Devices
  | "CONVEYOR_STATUS_CHANGED"
  | "CAMERA_STATUS_CHANGED"
  | "SENSOR_STATUS_CHANGED"
  // AI
  | "AI_DECISION"
  | "VLM_OBSERVATION"
  // Simulation control
  | "SIM_STARTED" | "SIM_PAUSED" | "SIM_RESUMED" | "SIM_RESET"
  | "SCENARIO_INJECTED";

// ─────────────────────────────────────────────────────────────
// Robot
// ─────────────────────────────────────────────────────────────

export interface PerceivedObstacle {
  kind: "ROBOT" | "HUMAN" | "RACK";
  id: string | null;
  distance_m: number;
  /** 相對航向角 (度)，左正右負 */
  bearing_deg: number;
}
export interface Perception {
  state: "CLEAR" | "SLOWING" | "STOPPED" | "OFF";
  /** 正前方淨空距離 (m)，含貨架 */
  ahead_m: number;
  nearest_m: number | null;
  obstacles: PerceivedObstacle[];
}

export interface RobotState {
  id: RobotId;
  model: string;                 // "AMR-L" 等，對應 GLB 模型名
  /** 所在樓層（1 = 地面）；position 的 y 恆為 0，渲染時加上樓層高度 */
  floor: number;
  /** 搭乘中的電梯 id；null = 不在電梯上 */
  lift_id: string | null;
  /** 電梯子狀態（規格書 §10）；null = 不在電梯流程中 */
  lift_stage: "TO_LIFT" | "QUEUED" | "BOARDING" | "RIDING" | "ALIGHTING" | null;
  position: Vec3;
  /** 航向角 (弧度)，繞 y 軸，0 = +x 方向 */
  heading: number;
  velocity: number;              // m/s，純量；方向由 heading 決定
  max_speed: number;             // m/s
  battery: number;               // 0..100
  status: RobotStatus;
  fsm: RobotFsmState;
  health: number;                // 0..100
  current_task_id: TaskId | null;
  destination: LocationId | null;
  /** 目前路徑 (格點)，index 0 = 下一個格點 */
  path: GridCell[];
  /** 路徑上已走到第幾個 index，前端插值用 */
  path_index: number;
  load: { current: number; capacity: number };
  zone: ZoneId | null;
  eta_s: number | null;          // 到達目的地估計秒數 (模擬時間)
  /** 機器人進入目前 fsm 狀態時的 tick，用於 dwell time 計算與 UI */
  fsm_since_tick: number;
  /** 累計統計 (KPI 用) */
  stats: {
    distance_m: number;
    tasks_completed: number;
    energy_wh: number;
    busy_ticks: number;
    wait_ticks: number;
  };
  /** Phase 7：虛擬 LiDAR（270° / 4 m）感知與局部避障狀態 */
  perception: Perception;
}

// ─────────────────────────────────────────────────────────────
// Task
// ─────────────────────────────────────────────────────────────

export interface TaskState {
  id: TaskId;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  source: LocationId;
  destination: LocationId;
  assigned_robot: RobotId | null;
  /** 若由其他任務轉移而來 */
  parent_task_id: TaskId | null;
  created_tick: number;
  assigned_tick: number | null;
  started_tick: number | null;
  completed_tick: number | null;
  /** 需求截止 tick，可為 null；On-time Rate 以此計算 */
  deadline_tick: number | null;
  eta_s: number | null;
  /** 任務本身需要的「貨量」，對應 RobotState.load */
  load_units: number;
}

// ─────────────────────────────────────────────────────────────
// 環境：Zone / Conveyor / Camera / Sensor / People
// ─────────────────────────────────────────────────────────────

export interface ZoneState {
  id: ZoneId;
  status: ZoneStatus;
  robot_count: number;
  /** 0..1，Fleet Manager 與 Heatmap 使用 */
  congestion: number;
  blocked_reason: string | null;
  blocked_since_tick: number | null;
}

export interface ConveyorState {
  id: ConveyorId;
  status: ConveyorStatus;
  speed_mps: number;
  /** 目前在輸送帶上的包裹數 (視覺用) */
  items_on_belt: number;
  throughput_per_min: number;
}

export interface CameraState {
  id: CameraId;
  zone: ZoneId;
  status: DeviceStatus;
  /** 最近一次 VLM 觀察結果，Phase 5 才會有值 */
  last_observation: VlmObservation | null;
}

export interface SensorState {
  id: SensorId;
  kind: "LIDAR" | "IR" | "WEIGHT" | "TEMP" | "PRESENCE";
  zone: ZoneId;
  status: DeviceStatus;
  value: number | null;
  unit: string | null;
}

/** 人員 / 堆高機等 NPC。第一版只在故障注入時出現。 */
export type LiftFsmState =
  | "IDLE" | "MOVING_UP" | "MOVING_DOWN" | "LEVELING"
  | "DOOR_OPENING" | "BOARDING" | "DOOR_CLOSING"
  | "DOOR_OPENING_AT_DESTINATION" | "ALIGHTING" | "DOOR_CLOSING_AFTER_EXIT"
  | "COOLDOWN";

/** 電梯（貨梯）狀態 — 後端為唯一權威；前端只做門/平台動畫插值（規格書 §2.1/§9.2） */
export interface LiftState {
  id: string;
  state: LiftFsmState;
  /** 目前樓層；移動中為 null（規格書：移動途中不得屬於任一樓層） */
  floor: number | null;
  target_floor: number | null;
  /** 平台高度 (m)，MOVING 期間由引擎以 smoothstep 插值 */
  y: number;
  door_f1: "OPEN" | "CLOSED";
  door_f2: "OPEN" | "CLOSED";
  occupant: RobotId | null;
  reserved_by: RobotId | null;
  /** 各樓層排隊（FIFO），key = "1" | "2" */
  queue: Record<string, RobotId[]>;
  until_tick: number;
  fault: boolean;
  trips: number;
  busy_ticks: number;
  wait_total_ticks: number;
  wait_n: number;
}

export interface PersonState {
  id: string;
  kind: "WORKER" | "FORKLIFT";
  position: Vec3;
  heading: number;
  zone: ZoneId | null;
  floor?: number;
  /** 到此 tick 自動消失；null = 永久 (需手動清除) */
  expires_tick: number | null;
}

// ─────────────────────────────────────────────────────────────
// Event / Alert / AI Decision
// ─────────────────────────────────────────────────────────────

export interface TwinEvent {
  id: EventId;
  tick: number;
  type: EventType;
  source: EventSource;
  severity: Severity;
  /** 人類可讀的一行訊息，直接顯示在 Event Log */
  message: string;
  /** 關聯實體，UI 用來做點擊跳轉 */
  robot_id?: RobotId;
  task_id?: TaskId;
  zone_id?: ZoneId;
  conveyor_id?: ConveyorId;
  camera_id?: CameraId;
  /** 事件專屬的附加資料，不做強型別 (但必須可 JSON 序列化) */
  payload?: Record<string, unknown>;
  /** 此事件是由哪個事件引發 (追溯鏈，例如 HUMAN_DETECTED → ZONE_BLOCKED → ROUTE_REPLANNED) */
  caused_by?: EventId;
}

export interface AlertState {
  id: AlertId;
  created_tick: number;
  severity: Severity;
  title: string;               // "R07 Battery Low"
  detail: string;              // "8% remaining"
  zone_id?: ZoneId;
  robot_id?: RobotId;
  conveyor_id?: ConveyorId;
  source_event_id: EventId;
  acknowledged: boolean;
  resolved_tick: number | null;
}

/** 規格 2️⃣5️⃣ AI Decision Explainability；Phase 4 由規則引擎產生，Phase 5 可由 LLM 補充 narrative */
export interface DecisionCandidate {
  robot_id: RobotId;
  score: number;
  distance_m: number;
  battery: number;
  workload: "LOW" | "MEDIUM" | "HIGH";
  congestion: number;
  health: number;
  reasons: string[];           // "✓ 34m from task"
  rejected_reason: string | null;
}

export interface AiDecision {
  id: string;
  tick: number;
  kind: "TASK_ASSIGNMENT" | "TASK_TRANSFER" | "REROUTE" | "CHARGE_SCHEDULING";
  task_id: TaskId | null;
  selected_robot: RobotId | null;
  candidates: DecisionCandidate[];
  /** 規則引擎的權重快照，確保決策可重現 */
  weights: Record<string, number>;
  /** 可選：LLM 產生的自然語言解釋 */
  narrative: string | null;
}

export interface VlmObservation {
  tick: number;
  camera_id: CameraId;
  event: "human_detected" | "obstacle" | "spill" | "none";
  zone: ZoneId;
  severity: Severity;
  blocked: boolean;
  confidence: number;          // 0..1
  raw: string | null;          // 模型原始回覆，除錯用
  bbox?: number[] | null;      // normalized [x, y, w, h]
  description?: string | null;
}

// ─────────────────────────────────────────────────────────────
// KPI
// ─────────────────────────────────────────────────────────────

export interface KpiSnapshot {
  tick: number;
  fleet: {
    total: number;
    active: number;
    charging: number;
    idle: number;
    warning: number;
    error: number;
    offline: number;
  };
  operation: {
    throughput_per_min: number;       // 最近 N 分鐘完成任務數 / N
    completed_today: number;
    completed_target: number;
    pending: number;
    ongoing: number;
    avg_task_time_s: number;
    on_time_rate: number;             // 0..1
    avg_utilization: number;          // 0..1
  };
  efficiency: {
    avg_travel_distance_m: number;
    avg_wait_time_s: number;
    congestion_index: number;         // 0..1，各 zone 加權
    energy_kwh: number;
  };
  /** 前端 Throughput 折線圖用；長度固定 (例如 120 點)，後端 ring buffer */
  throughput_series: Array<{ tick: number; completed: number; target: number }>;
  /** 電梯 KPI（規格書 §21） */
  lifts: { trips: number; utilization: number; avg_wait_s: number; faults: number };
}

// ─────────────────────────────────────────────────────────────
// Heatmap
// ─────────────────────────────────────────────────────────────

export interface HeatmapLayer {
  kind: "TRAFFIC" | "WAIT" | "CONGESTION";
  cols: number;
  rows: number;
  /** row-major，長度 = cols*rows，0..1 已正規化 */
  values: number[];
  window_ticks: number;               // 統計視窗
}

// ─────────────────────────────────────────────────────────────
// Simulation 控制與 Scenario
// ─────────────────────────────────────────────────────────────

export type SimMode = "LIVE" | "PAUSED" | "WHATIF";

export interface SimulationState {
  tick: number;
  tick_ms: number;                    // 固定 100
  speed: 0 | 1 | 2 | 5 | 10;          // 倍速；0 = 暫停
  mode: SimMode;
  seed: number;                       // 確定性模擬的隨機種子
  /** What-if 時對應的 baseline snapshot id */
  baseline_snapshot_id: string | null;
}

export type ScenarioInjection =
  | { kind: "ROBOT_FAILURE"; robot_id: RobotId; at_tick?: number }
  | { kind: "ROBOT_BATTERY_SET"; robot_id: RobotId; battery: number; at_tick?: number }
  | { kind: "CONVEYOR_FAILURE"; conveyor_id: ConveyorId; at_tick?: number }
  | { kind: "CAMERA_OFFLINE"; camera_id: CameraId; at_tick?: number }
  | { kind: "HUMAN_INTRUSION"; zone_id: ZoneId; duration_ticks: number; at_tick?: number }
  | { kind: "TRAFFIC_CONGESTION"; zone_id: ZoneId; level: number; duration_ticks: number; at_tick?: number }
  | { kind: "TASK_BURST"; count: number; priority: TaskPriority; at_tick?: number }
  | { kind: "LIFT_FAULT"; lift_id: string; at_tick?: number };

export interface WhatIfRequest {
  scenario_name: string;
  injections: ScenarioInjection[];
  duration_ticks: number;             // 規格: 60 秒 = 600 ticks
  /** 是否同時跑一份無注入的 baseline 做對照 (建議 true) */
  run_baseline: boolean;
}

export interface WhatIfResult {
  request: WhatIfRequest;
  baseline_kpi: KpiSnapshot;
  scenario_kpi: KpiSnapshot;
  /** 差異 (scenario - baseline)，前端直接顯示 ±% */
  delta: Record<string, number>;
  key_events: TwinEvent[];
  ai_recommendation: string | null;   // Phase 6
}

// ─────────────────────────────────────────────────────────────
// Twin State (根)
// ─────────────────────────────────────────────────────────────

export interface TwinState {
  schema_version: "1.0";
  layout_id: string;                  // 對應 warehouse_layout.json 的 id
  sim: SimulationState;
  /** 以 id 為 key 的字典：diff / patch 友善，查找 O(1) */
  robots: Record<RobotId, RobotState>;
  tasks: Record<TaskId, TaskState>;
  lifts: Record<string, LiftState>;
  zones: Record<ZoneId, ZoneState>;
  conveyors: Record<ConveyorId, ConveyorState>;
  cameras: Record<CameraId, CameraState>;
  sensors: Record<SensorId, SensorState>;
  people: Record<string, PersonState>;
  /** 只保留未解決的 alerts；歷史在 events 中 */
  alerts: Record<AlertId, AlertState>;
  /** 最近 N 筆事件 (ring buffer，例如 500)，完整歷史在後端 DB */
  recent_events: TwinEvent[];
  recent_decisions: AiDecision[];
  kpi: KpiSnapshot;
  subsystems: Record<"WAREHOUSE" | "CONVEYORS" | "CHARGING" | "CCTV" | "NETWORK", SubsystemStatus>;
}

// ─────────────────────────────────────────────────────────────
// WebSocket 訊息協定
// ─────────────────────────────────────────────────────────────

/**
 * 策略：連線時送一次 FULL，之後每 tick 送 PATCH (只含變動欄位)。
 * 前端若發現 patch.base_tick !== 本地 tick，送 RESYNC 請求 FULL。
 * 高頻欄位 (robots.*.position / heading / velocity / battery) 每 tick 更新；
 * 其餘欄位有變才進 patch。
 */
export type ServerMessage =
  | { type: "FULL"; state: TwinState }
  | { type: "PATCH"; base_tick: number; tick: number; patch: DeepPartial<TwinState>; events: TwinEvent[] }
  | { type: "HEATMAP"; layer: HeatmapLayer }
  | { type: "WHATIF_RESULT"; request_id?: string | null; result: WhatIfResult }
  | { type: "COPILOT_REPLY"; request_id: string; text: string; citations: Array<{ event_id?: EventId; robot_id?: RobotId; task_id?: TaskId }>; model?: string }
  | { type: "ERROR"; code: string; message: string; request_id?: string | null };

export type ClientMessage =
  | { type: "RESYNC" }
  | { type: "SIM_CONTROL"; action: "PLAY" | "PAUSE" | "RESET"; speed?: SimulationState["speed"] }
  | { type: "INJECT"; injection: ScenarioInjection }
  | { type: "CLEAR_INJECTION"; kind: ScenarioInjection["kind"]; target_id: string }
  | { type: "CREATE_TASK"; task: Pick<TaskState, "type" | "priority" | "source" | "destination" | "load_units"> & { deadline_s?: number } }
  | { type: "ACK_ALERT"; alert_id: AlertId }
  | { type: "SELECT_ROBOT"; robot_id: RobotId | null }           // 讓後端提高該機器人更新頻率 (可選)
  | { type: "WHATIF_RUN"; request: WhatIfRequest; request_id?: string }
  | { type: "COPILOT_ASK"; request_id: string; question: string };

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ─────────────────────────────────────────────────────────────
// 門檻常數 (前後端共用，改這裡不改邏輯)
// ─────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  BATTERY_WARNING: 20,
  BATTERY_CRITICAL: 10,
  BATTERY_CHARGE_TO: 95,
  CONGESTION_WARNING: 0.6,
  CONGESTION_BLOCK: 0.85,
  TICK_MS: 100,
  EVENT_RING_SIZE: 500,
  THROUGHPUT_SERIES_SIZE: 120,
} as const;
