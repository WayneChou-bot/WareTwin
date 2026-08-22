"""
AI Autonomous Warehouse Digital Twin — Twin State 資料契約 (Pydantic v2)

與 twin_state.ts 逐欄對應。規則同 TS 檔：純資料、可序列化、座標單位公尺、tick 為模擬時間。
後端所有 API / WebSocket 輸出都必須經過這裡的 model 驗證後才送出。

用法：
    state = TwinState.model_validate(json_dict)
    state.model_dump_json()            # 送 WebSocket
    copy = state.model_copy(deep=True) # What-if 複製
"""
from __future__ import annotations

from enum import Enum
from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

# ─────────────────────────────────────────────────────────────
# 基礎型別
# ─────────────────────────────────────────────────────────────

Vec3 = tuple[float, float, float]
Vec2 = tuple[float, float]
GridCell = tuple[int, int]

RobotId = str
TaskId = str
ZoneId = str
ConveyorId = str
CameraId = str
SensorId = str
EventId = str
AlertId = str
LocationId = str

Pct = Annotated[float, Field(ge=0, le=100)]
Unit = Annotated[float, Field(ge=0, le=1)]


class _Base(BaseModel):
    """所有 model 的共同設定：禁止未知欄位，enum 以字串輸出。"""
    model_config = ConfigDict(extra="forbid", use_enum_values=True)


# ─────────────────────────────────────────────────────────────
# Enum
# ─────────────────────────────────────────────────────────────

class RobotStatus(str, Enum):
    ACTIVE = "ACTIVE"
    CHARGING = "CHARGING"
    IDLE = "IDLE"
    WARNING = "WARNING"
    ERROR = "ERROR"
    OFFLINE = "OFFLINE"


class RobotFsmState(str, Enum):
    IDLE = "IDLE"
    TASK_ASSIGNED = "TASK_ASSIGNED"
    NAVIGATING = "NAVIGATING"
    PICKING = "PICKING"
    TRANSPORTING = "TRANSPORTING"
    DELIVERING = "DELIVERING"
    COMPLETED = "COMPLETED"
    OBSTACLE_DETECTED = "OBSTACLE_DETECTED"
    REPLANNING = "REPLANNING"
    LOW_BATTERY = "LOW_BATTERY"
    TASK_TRANSFER = "TASK_TRANSFER"
    GOING_TO_CHARGE = "GOING_TO_CHARGE"
    CHARGING = "CHARGING"
    OFFLINE = "OFFLINE"
    ERROR = "ERROR"


class TaskType(str, Enum):
    PICK = "PICK"
    TRANSPORT = "TRANSPORT"
    REPLENISH = "REPLENISH"
    RETURN = "RETURN"


class TaskPriority(str, Enum):
    LOW = "LOW"
    NORMAL = "NORMAL"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class TaskStatus(str, Enum):
    WAITING = "WAITING"
    ASSIGNED = "ASSIGNED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    TRANSFERRED = "TRANSFERRED"


class ConveyorStatus(str, Enum):
    RUNNING = "RUNNING"
    WARNING = "WARNING"
    STOPPED = "STOPPED"
    MAINTENANCE = "MAINTENANCE"
    ERROR = "ERROR"


class DeviceStatus(str, Enum):
    ONLINE = "ONLINE"
    DEGRADED = "DEGRADED"
    OFFLINE = "OFFLINE"


class ZoneStatus(str, Enum):
    NORMAL = "NORMAL"
    CONGESTED = "CONGESTED"
    BLOCKED = "BLOCKED"
    RESTRICTED = "RESTRICTED"


class SubsystemStatus(str, Enum):
    NORMAL = "NORMAL"
    WARNING = "WARNING"
    ERROR = "ERROR"


class Severity(str, Enum):
    INFO = "INFO"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class EventSource(str, Enum):
    ROBOT = "ROBOT"
    SENSOR = "SENSOR"
    CAMERA = "CAMERA"
    VLM = "VLM"
    CONVEYOR = "CONVEYOR"
    SIMULATION = "SIMULATION"
    FLEET_MANAGER = "FLEET_MANAGER"
    PLANNER = "PLANNER"
    USER = "USER"
    AI_AGENT = "AI_AGENT"


class EventType(str, Enum):
    ROBOT_STATE_CHANGED = "ROBOT_STATE_CHANGED"
    ROBOT_BATTERY_LOW = "ROBOT_BATTERY_LOW"
    ROBOT_BATTERY_CRITICAL = "ROBOT_BATTERY_CRITICAL"
    ROBOT_OFFLINE = "ROBOT_OFFLINE"
    ROBOT_ONLINE = "ROBOT_ONLINE"
    ROBOT_COLLISION_AVOIDED = "ROBOT_COLLISION_AVOIDED"
    TASK_CREATED = "TASK_CREATED"
    TASK_ASSIGNED = "TASK_ASSIGNED"
    TASK_STARTED = "TASK_STARTED"
    TASK_COMPLETED = "TASK_COMPLETED"
    TASK_FAILED = "TASK_FAILED"
    TASK_TRANSFERRED = "TASK_TRANSFERRED"
    ROUTE_PLANNED = "ROUTE_PLANNED"
    ROUTE_REPLANNED = "ROUTE_REPLANNED"
    OBSTACLE_DETECTED = "OBSTACLE_DETECTED"
    ZONE_BLOCKED = "ZONE_BLOCKED"
    ZONE_UNBLOCKED = "ZONE_UNBLOCKED"
    ZONE_CONGESTION_HIGH = "ZONE_CONGESTION_HIGH"
    HUMAN_DETECTED = "HUMAN_DETECTED"
    HUMAN_CLEARED = "HUMAN_CLEARED"
    CONVEYOR_STATUS_CHANGED = "CONVEYOR_STATUS_CHANGED"
    CAMERA_STATUS_CHANGED = "CAMERA_STATUS_CHANGED"
    SENSOR_STATUS_CHANGED = "SENSOR_STATUS_CHANGED"
    AI_DECISION = "AI_DECISION"
    VLM_OBSERVATION = "VLM_OBSERVATION"
    SIM_STARTED = "SIM_STARTED"
    SIM_PAUSED = "SIM_PAUSED"
    SIM_RESUMED = "SIM_RESUMED"
    SIM_RESET = "SIM_RESET"
    SCENARIO_INJECTED = "SCENARIO_INJECTED"


# ─────────────────────────────────────────────────────────────
# Robot
# ─────────────────────────────────────────────────────────────

class Load(_Base):
    current: int = Field(ge=0)
    capacity: int = Field(ge=1)


class RobotStats(_Base):
    distance_m: float = 0
    tasks_completed: int = 0
    energy_wh: float = 0
    busy_ticks: int = 0
    wait_ticks: int = 0


class PerceivedObstacle(_Base):
    """虛擬 LiDAR 偵測到的障礙（相對機器人）"""
    kind: Literal["ROBOT", "HUMAN", "RACK"]
    id: Optional[str] = None
    distance_m: float = Field(ge=0)
    bearing_deg: float          # 相對航向，左正右負


class Perception(_Base):
    """Phase 7：機器人感知（270° / 4 m 虛擬 LiDAR）與局部避障狀態"""
    state: Literal["CLEAR", "SLOWING", "STOPPED", "OFF"] = "OFF"
    ahead_m: float = 4.0        # 正前方淨空距離（含貨架）
    nearest_m: Optional[float] = None
    obstacles: list[PerceivedObstacle] = Field(default_factory=list)


class RobotState(_Base):
    id: RobotId
    model: str = "AMR-L"
    position: Vec3
    heading: float
    velocity: float = Field(ge=0)
    max_speed: float = Field(gt=0)
    battery: Pct
    status: RobotStatus
    fsm: RobotFsmState
    health: Pct = 100
    current_task_id: Optional[TaskId] = None
    destination: Optional[LocationId] = None
    path: list[GridCell] = Field(default_factory=list)
    path_index: int = 0
    load: Load
    zone: Optional[ZoneId] = None
    eta_s: Optional[float] = None
    fsm_since_tick: int = 0
    stats: RobotStats = Field(default_factory=RobotStats)
    perception: Perception = Field(default_factory=Perception)


# ─────────────────────────────────────────────────────────────
# Task
# ─────────────────────────────────────────────────────────────

class TaskState(_Base):
    id: TaskId
    type: TaskType
    priority: TaskPriority = TaskPriority.NORMAL
    status: TaskStatus = TaskStatus.WAITING
    source: LocationId
    destination: LocationId
    assigned_robot: Optional[RobotId] = None
    parent_task_id: Optional[TaskId] = None
    created_tick: int
    assigned_tick: Optional[int] = None
    started_tick: Optional[int] = None
    completed_tick: Optional[int] = None
    deadline_tick: Optional[int] = None
    eta_s: Optional[float] = None
    load_units: int = Field(default=1, ge=1)


# ─────────────────────────────────────────────────────────────
# 環境
# ─────────────────────────────────────────────────────────────

class ZoneState(_Base):
    id: ZoneId
    status: ZoneStatus = ZoneStatus.NORMAL
    robot_count: int = 0
    congestion: Unit = 0
    blocked_reason: Optional[str] = None
    blocked_since_tick: Optional[int] = None


class ConveyorState(_Base):
    id: ConveyorId
    status: ConveyorStatus = ConveyorStatus.RUNNING
    speed_mps: float = Field(default=0.5, ge=0)
    items_on_belt: int = 0
    throughput_per_min: float = 0


class VlmObservation(_Base):
    tick: int
    camera_id: CameraId
    event: Literal["human_detected", "obstacle", "spill", "none"]
    zone: ZoneId
    severity: Severity
    blocked: bool
    confidence: Unit
    raw: Optional[str] = None
    bbox: Optional[list[float]] = None        # normalized [x, y, w, h]
    description: Optional[str] = None


class CameraState(_Base):
    id: CameraId
    zone: ZoneId
    status: DeviceStatus = DeviceStatus.ONLINE
    last_observation: Optional[VlmObservation] = None


class SensorState(_Base):
    id: SensorId
    kind: Literal["LIDAR", "IR", "WEIGHT", "TEMP", "PRESENCE"]
    zone: ZoneId
    status: DeviceStatus = DeviceStatus.ONLINE
    value: Optional[float] = None
    unit: Optional[str] = None


class PersonState(_Base):
    id: str
    kind: Literal["WORKER", "FORKLIFT"]
    position: Vec3
    heading: float = 0
    zone: Optional[ZoneId] = None
    expires_tick: Optional[int] = None


# ─────────────────────────────────────────────────────────────
# Event / Alert / AI Decision
# ─────────────────────────────────────────────────────────────

class TwinEvent(_Base):
    id: EventId
    tick: int
    type: EventType
    source: EventSource
    severity: Severity = Severity.INFO
    message: str
    robot_id: Optional[RobotId] = None
    task_id: Optional[TaskId] = None
    zone_id: Optional[ZoneId] = None
    conveyor_id: Optional[ConveyorId] = None
    camera_id: Optional[CameraId] = None
    payload: Optional[dict[str, Any]] = None
    caused_by: Optional[EventId] = None


class AlertState(_Base):
    id: AlertId
    created_tick: int
    severity: Severity
    title: str
    detail: str
    zone_id: Optional[ZoneId] = None
    robot_id: Optional[RobotId] = None
    conveyor_id: Optional[ConveyorId] = None
    source_event_id: EventId
    acknowledged: bool = False
    resolved_tick: Optional[int] = None


class DecisionCandidate(_Base):
    robot_id: RobotId
    score: float
    distance_m: float
    battery: Pct
    workload: Literal["LOW", "MEDIUM", "HIGH"]
    congestion: Unit
    health: Pct
    reasons: list[str] = Field(default_factory=list)
    rejected_reason: Optional[str] = None


class AiDecision(_Base):
    id: str
    tick: int
    kind: Literal["TASK_ASSIGNMENT", "TASK_TRANSFER", "REROUTE", "CHARGE_SCHEDULING"]
    task_id: Optional[TaskId] = None
    selected_robot: Optional[RobotId] = None
    candidates: list[DecisionCandidate]
    weights: dict[str, float]
    narrative: Optional[str] = None


# ─────────────────────────────────────────────────────────────
# KPI / Heatmap
# ─────────────────────────────────────────────────────────────

class KpiFleet(_Base):
    total: int = 0
    active: int = 0
    charging: int = 0
    idle: int = 0
    warning: int = 0
    error: int = 0
    offline: int = 0


class KpiOperation(_Base):
    throughput_per_min: float = 0
    completed_today: int = 0
    completed_target: int = 0
    pending: int = 0
    ongoing: int = 0
    avg_task_time_s: float = 0
    on_time_rate: Unit = 0
    avg_utilization: Unit = 0


class KpiEfficiency(_Base):
    avg_travel_distance_m: float = 0
    avg_wait_time_s: float = 0
    congestion_index: Unit = 0
    energy_kwh: float = 0


class ThroughputPoint(_Base):
    tick: int
    completed: int
    target: int


class KpiSnapshot(_Base):
    tick: int
    fleet: KpiFleet = Field(default_factory=KpiFleet)
    operation: KpiOperation = Field(default_factory=KpiOperation)
    efficiency: KpiEfficiency = Field(default_factory=KpiEfficiency)
    throughput_series: list[ThroughputPoint] = Field(default_factory=list)


class HeatmapLayer(_Base):
    kind: Literal["TRAFFIC", "WAIT", "CONGESTION"]
    cols: int
    rows: int
    values: list[float]
    window_ticks: int


# ─────────────────────────────────────────────────────────────
# Simulation / Scenario
# ─────────────────────────────────────────────────────────────

class SimulationState(_Base):
    tick: int = 0
    tick_ms: int = 100
    speed: Literal[0, 1, 2, 5, 10] = 1
    mode: Literal["LIVE", "PAUSED", "WHATIF"] = "LIVE"
    seed: int = 42
    baseline_snapshot_id: Optional[str] = None


class _Inj(_Base):
    at_tick: Optional[int] = None


class RobotFailure(_Inj):
    kind: Literal["ROBOT_FAILURE"] = "ROBOT_FAILURE"
    robot_id: RobotId


class RobotBatterySet(_Inj):
    kind: Literal["ROBOT_BATTERY_SET"] = "ROBOT_BATTERY_SET"
    robot_id: RobotId
    battery: Pct


class ConveyorFailure(_Inj):
    kind: Literal["CONVEYOR_FAILURE"] = "CONVEYOR_FAILURE"
    conveyor_id: ConveyorId


class CameraOffline(_Inj):
    kind: Literal["CAMERA_OFFLINE"] = "CAMERA_OFFLINE"
    camera_id: CameraId


class HumanIntrusion(_Inj):
    kind: Literal["HUMAN_INTRUSION"] = "HUMAN_INTRUSION"
    zone_id: ZoneId
    duration_ticks: int = Field(gt=0)


class TrafficCongestion(_Inj):
    kind: Literal["TRAFFIC_CONGESTION"] = "TRAFFIC_CONGESTION"
    zone_id: ZoneId
    level: Unit
    duration_ticks: int = Field(gt=0)


class TaskBurst(_Inj):
    kind: Literal["TASK_BURST"] = "TASK_BURST"
    count: int = Field(gt=0)
    priority: TaskPriority = TaskPriority.NORMAL


ScenarioInjection = Annotated[
    Union[RobotFailure, RobotBatterySet, ConveyorFailure, CameraOffline,
          HumanIntrusion, TrafficCongestion, TaskBurst],
    Field(discriminator="kind"),
]


class WhatIfRequest(_Base):
    scenario_name: str
    injections: list[ScenarioInjection]
    duration_ticks: int = Field(default=600, gt=0)
    run_baseline: bool = True


class WhatIfResult(_Base):
    request: WhatIfRequest
    baseline_kpi: KpiSnapshot
    scenario_kpi: KpiSnapshot
    delta: dict[str, float]
    key_events: list[TwinEvent]
    ai_recommendation: Optional[str] = None


# ─────────────────────────────────────────────────────────────
# Twin State (根)
# ─────────────────────────────────────────────────────────────

class TwinState(_Base):
    schema_version: Literal["1.0"] = "1.0"
    layout_id: str
    sim: SimulationState = Field(default_factory=SimulationState)
    robots: dict[RobotId, RobotState] = Field(default_factory=dict)
    tasks: dict[TaskId, TaskState] = Field(default_factory=dict)
    zones: dict[ZoneId, ZoneState] = Field(default_factory=dict)
    conveyors: dict[ConveyorId, ConveyorState] = Field(default_factory=dict)
    cameras: dict[CameraId, CameraState] = Field(default_factory=dict)
    sensors: dict[SensorId, SensorState] = Field(default_factory=dict)
    people: dict[str, PersonState] = Field(default_factory=dict)
    alerts: dict[AlertId, AlertState] = Field(default_factory=dict)
    recent_events: list[TwinEvent] = Field(default_factory=list)
    recent_decisions: list[AiDecision] = Field(default_factory=list)
    kpi: KpiSnapshot = Field(default_factory=lambda: KpiSnapshot(tick=0))
    subsystems: dict[
        Literal["WAREHOUSE", "CONVEYORS", "CHARGING", "CCTV", "NETWORK"], SubsystemStatus
    ] = Field(default_factory=dict)


# ─────────────────────────────────────────────────────────────
# WebSocket 訊息
# ─────────────────────────────────────────────────────────────

class MsgFull(_Base):
    type: Literal["FULL"] = "FULL"
    state: TwinState


class MsgPatch(_Base):
    type: Literal["PATCH"] = "PATCH"
    base_tick: int
    tick: int
    patch: dict[str, Any]          # DeepPartial<TwinState>，由 diff 產生
    events: list[TwinEvent] = Field(default_factory=list)


class MsgHeatmap(_Base):
    type: Literal["HEATMAP"] = "HEATMAP"
    layer: HeatmapLayer


class MsgWhatIfResult(_Base):
    type: Literal["WHATIF_RESULT"] = "WHATIF_RESULT"
    result: WhatIfResult


class Citation(_Base):
    event_id: Optional[EventId] = None
    robot_id: Optional[RobotId] = None
    task_id: Optional[TaskId] = None


class MsgCopilotReply(_Base):
    type: Literal["COPILOT_REPLY"] = "COPILOT_REPLY"
    request_id: str
    text: str
    citations: list[Citation] = Field(default_factory=list)
    model: Optional[str] = None


class MsgError(_Base):
    type: Literal["ERROR"] = "ERROR"
    code: str
    message: str


ServerMessage = Annotated[
    Union[MsgFull, MsgPatch, MsgHeatmap, MsgWhatIfResult, MsgCopilotReply, MsgError],
    Field(discriminator="type"),
]


class CmdResync(_Base):
    type: Literal["RESYNC"] = "RESYNC"


class CmdSimControl(_Base):
    type: Literal["SIM_CONTROL"] = "SIM_CONTROL"
    action: Literal["PLAY", "PAUSE", "RESET"]
    speed: Optional[Literal[0, 1, 2, 5, 10]] = None


class CmdInject(_Base):
    type: Literal["INJECT"] = "INJECT"
    injection: ScenarioInjection


class CmdClearInjection(_Base):
    type: Literal["CLEAR_INJECTION"] = "CLEAR_INJECTION"
    kind: str
    target_id: str


class NewTask(_Base):
    type: TaskType
    priority: TaskPriority = TaskPriority.NORMAL
    source: LocationId
    destination: LocationId
    load_units: int = Field(default=1, ge=1)
    deadline_s: Optional[float] = None


class CmdCreateTask(_Base):
    type: Literal["CREATE_TASK"] = "CREATE_TASK"
    task: NewTask


class CmdAckAlert(_Base):
    type: Literal["ACK_ALERT"] = "ACK_ALERT"
    alert_id: AlertId


class CmdSelectRobot(_Base):
    type: Literal["SELECT_ROBOT"] = "SELECT_ROBOT"
    robot_id: Optional[RobotId] = None


class CmdWhatIfRun(_Base):
    type: Literal["WHATIF_RUN"] = "WHATIF_RUN"
    request: WhatIfRequest


class CmdCopilotAsk(_Base):
    type: Literal["COPILOT_ASK"] = "COPILOT_ASK"
    request_id: str
    question: str


ClientMessage = Annotated[
    Union[CmdResync, CmdSimControl, CmdInject, CmdClearInjection, CmdCreateTask,
          CmdAckAlert, CmdSelectRobot, CmdWhatIfRun, CmdCopilotAsk],
    Field(discriminator="type"),
]


# ─────────────────────────────────────────────────────────────
# 門檻常數
# ─────────────────────────────────────────────────────────────

class THRESHOLDS:
    BATTERY_WARNING = 20
    BATTERY_CRITICAL = 10
    BATTERY_CHARGE_TO = 95
    CONGESTION_WARNING = 0.6
    CONGESTION_BLOCK = 0.85
    TICK_MS = 100
    EVENT_RING_SIZE = 500
    THROUGHPUT_SERIES_SIZE = 120
