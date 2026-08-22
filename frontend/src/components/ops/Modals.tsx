/**
 * Phase 4 Modals：
 *  - AuditLog：完整事件紀錄。online 從後端 SQLite (/api/events) 抓 500 筆並可篩選；local 用本地 ring。可匯出 CSV / JSON。
 *  - TaskTable：全部任務 + 建立任務表單（source/destination 選項來自 layout.locations）。
 *  - RobotDetail：規格 3️⃣ 的完整欄位 + 累計統計 + 該機器人最近事件 + 故障/復原按鈕。
 */
import { useEffect, useMemo, useState } from "react";
import { STATUS_COLOR, layout, tickToClock, useStore } from "../../state/store";
import { simControl } from "../../simulation/runner";
import { API_URL } from "../../services/ws";
import type { TwinEvent, TaskPriority, TaskType } from "../../schema/twin_state";
import { Dot } from "../ui/primitives";

export function Modals() {
  const modal = useStore((s) => s.modal);
  const setModal = useStore((s) => s.setModal);
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === "Escape" && setModal(null); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [setModal]);
  if (!modal) return null;
  return (
    <div className="modal-bg" onClick={() => setModal(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {modal === "audit" && <AuditLog />}
        {modal === "tasks" && <TaskTable />}
        {modal === "robot" && <RobotDetail />}
      </div>
    </div>
  );
}

function Head({ title, children }: { title: string; children?: React.ReactNode }) {
  const setModal = useStore((s) => s.setModal);
  return <header className="modal-h"><span>{title}</span><span className="spacer" />{children}<button className="icon-btn" onClick={() => setModal(null)}>✕</button></header>;
}

// ─────────────────────────────────────────────────────────────
function AuditLog() {
  const source = useStore((s) => s.source);
  const local = useStore((s) => s.twin.recent_events);
  const select = useStore((s) => s.select);
  const setModal = useStore((s) => s.setModal);
  const [remote, setRemote] = useState<TwinEvent[] | null>(null);
  const [sev, setSev] = useState(""); const [src, setSrc] = useState(""); const [q, setQ] = useState("");
  useEffect(() => {
    if (source !== "online") { setRemote(null); return; }
    let alive = true;
    fetch(`${API_URL}/api/events?limit=500`).then((r) => r.json()).then((d: TwinEvent[]) => alive && setRemote(d)).catch(() => alive && setRemote(null));
    return () => { alive = false; };
  }, [source]);
  const events = remote ?? local;
  const rows = useMemo(() => events.filter((e) => (!sev || e.severity === sev) && (!src || e.source === src) && (!q || `${e.message} ${e.robot_id ?? ""} ${e.zone_id ?? ""} ${e.type}`.toLowerCase().includes(q.toLowerCase()))), [events, sev, src, q]);
  const exportFile = (kind: "json" | "csv") => {
    const body = kind === "json" ? JSON.stringify(rows, null, 2) : ["id,tick,time,type,source,severity,robot,task,zone,message", ...rows.map((e) => [e.id, e.tick, tickToClock(e.tick, 100, true), e.type, e.source, e.severity, e.robot_id ?? "", e.task_id ?? "", e.zone_id ?? "", `"${e.message.replace(/"/g, '""')}"`].join(","))].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/csv" })); a.download = `audit_log.${kind}`; a.click();
  };
  return (
    <>
      <Head title="Audit / Event Log"><span className="hint" style={{ margin: 0 }}>{remote ? "backend SQLite" : "local ring buffer"}</span><button className="btn" onClick={() => exportFile("csv")}>Export CSV</button><button className="btn" onClick={() => exportFile("json")}>Export JSON</button></Head>
      <div className="modal-b">
        <div className="filters">
          <select value={sev} onChange={(e) => setSev(e.target.value)}><option value="">All severities</option>{["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((s) => <option key={s}>{s}</option>)}</select>
          <select value={src} onChange={(e) => setSrc(e.target.value)}><option value="">All sources</option>{["ROBOT", "FLEET_MANAGER", "PLANNER", "SIMULATION", "CONVEYOR", "CAMERA", "VLM", "USER", "AI_AGENT"].map((s) => <option key={s}>{s}</option>)}</select>
          <input placeholder="search message / robot / zone…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
          <span className="count">{rows.length} / {events.length}</span>
        </div>
        <table className="dt full">
          <thead><tr><th>Time</th><th>Tick</th><th>Severity</th><th>Source</th><th>Type</th><th>Message</th><th>Robot</th><th>Zone</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} onClick={() => { if (e.robot_id) { select(e.robot_id); setModal(null); } }}>
                <td>{tickToClock(e.tick, 100, true)}</td><td>{e.tick}</td><td className={"sev-" + e.severity}>{e.severity}</td><td>{e.source}</td><td>{e.type}</td><td style={{ fontFamily: "var(--font)" }}>{e.message}</td><td>{e.robot_id ?? ""}</td><td>{e.zone_id ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
function TaskTable() {
  const tasks = useStore((s) => s.twin.tasks);
  const locs = useStore((s) => s.locations);
  const select = useStore((s) => s.select);
  const setModal = useStore((s) => s.setModal);
  const [type, setType] = useState<TaskType>("PICK");
  const [priority, setPriority] = useState<TaskPriority>("HIGH");
  const [source, setSource] = useState("SHELF-A12");
  const [dest, setDest] = useState("PACK-01");
  const [status, setStatus] = useState("");
  const order: Record<string, number> = { IN_PROGRESS: 0, ASSIGNED: 1, WAITING: 2, TRANSFERRED: 3, COMPLETED: 4, FAILED: 5, CANCELLED: 6 };
  const rows = Object.values(tasks).filter((t) => !status || t.status === status).sort((a, b) => order[a.status] - order[b.status] || b.created_tick - a.created_tick);
  const pretty = (id: string) => { const l = locs[id]; if (!l) return id; return l.kind === "SHELF" ? `Shelf ${id.replace("SHELF-", "")}` : id.replace("-", " "); };
  const opts = layout.locations.filter((l) => l.kind !== "CHARGING");
  return (
    <>
      <Head title="Tasks" />
      <div className="modal-b">
        <form className="form" onSubmit={(e) => { e.preventDefault(); simControl.createTask({ type, priority, source, destination: dest }); }}>
          <label>Type<select value={type} onChange={(e) => setType(e.target.value as TaskType)}>{["PICK", "TRANSPORT", "REPLENISH", "RETURN"].map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>Priority<select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>{["LOW", "NORMAL", "HIGH", "CRITICAL"].map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>Source<select value={source} onChange={(e) => setSource(e.target.value)}>{opts.map((l) => <option key={l.id} value={l.id}>{pretty(l.id)}</option>)}</select></label>
          <label>Destination<select value={dest} onChange={(e) => setDest(e.target.value)}>{opts.map((l) => <option key={l.id} value={l.id}>{pretty(l.id)}</option>)}</select></label>
          <label>Filter<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{Object.keys(order).map((s) => <option key={s}>{s}</option>)}</select></label>
          <button className="btn primary" type="submit">+ Create task</button>
        </form>
        <table className="dt full">
          <thead><tr><th>Task</th><th>Type</th><th>Priority</th><th>Status</th><th>From</th><th>To</th><th>Robot</th><th>Created</th><th>Assigned</th><th>Completed</th><th>Duration</th><th>Parent</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} onClick={() => { if (t.assigned_robot) { select(t.assigned_robot); setModal(null); } }}>
                <td>#{t.id}</td><td>{t.type}</td><td>{t.priority}</td>
                <td className={t.status === "IN_PROGRESS" || t.status === "ASSIGNED" ? "st-inprog" : t.status === "WAITING" ? "st-wait" : t.status === "COMPLETED" ? "" : "st-fail"}>{t.status}</td>
                <td>{pretty(t.source)}</td><td>{pretty(t.destination)}</td><td>{t.assigned_robot ?? "—"}</td>
                <td>{tickToClock(t.created_tick, 100, true)}</td><td>{t.assigned_tick !== null ? tickToClock(t.assigned_tick, 100, true) : "—"}</td><td>{t.completed_tick !== null ? tickToClock(t.completed_tick, 100, true) : "—"}</td>
                <td>{t.completed_tick !== null ? `${((t.completed_tick - t.created_tick) / 10).toFixed(0)}s` : "—"}</td><td>{t.parent_task_id ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
function RobotDetail() {
  const id = useStore((s) => s.selectedRobot);
  const r = useStore((s) => (id ? s.twin.robots[id] : undefined));
  const task = useStore((s) => (r?.current_task_id ? s.twin.tasks[r.current_task_id] : undefined));
  const events = useStore((s) => s.twin.recent_events);
  const locs = useStore((s) => s.locations);
  if (!r) return <><Head title="Robot" /><div className="modal-b hint">No robot selected.</div></>;
  const col = STATUS_COLOR[r.status];
  const pretty = (x: string | null) => { if (!x) return "—"; const l = locs[x]; return l ? (l.kind === "SHELF" ? `Shelf ${x.replace("SHELF-", "")}` : x.replace("-", " ")) : x; };
  const mine = events.filter((e) => e.robot_id === r.id).slice(0, 40);
  const KV = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="kv"><span className="k">{k}</span><span className="v">{v}</span></div>;
  return (
    <>
      <Head title={`Robot ${r.id}`}>
        <span className="status-text" style={{ color: col }}><Dot color={col} />{r.status}</span>
        {r.status === "OFFLINE" ? <button className="btn" onClick={() => simControl.clearInjection("ROBOT_FAILURE", r.id)}>Restore</button> : <button className="btn danger" onClick={() => simControl.inject({ kind: "ROBOT_FAILURE", robot_id: r.id })}>Fail robot</button>}
        <button className="btn warn" onClick={() => simControl.inject({ kind: "ROBOT_BATTERY_SET", robot_id: r.id, battery: 8 })}>Battery → 8%</button>
      </Head>
      <div className="modal-b">
        <div className="kv-grid">
          <div><KV k="Status" v={r.status} /><KV k="FSM" v={r.fsm} /><KV k="Battery" v={`${r.battery.toFixed(1)}%`} /><KV k="Speed" v={`${r.velocity.toFixed(2)} m/s (max ${r.max_speed})`} /><KV k="Health" v={`${r.health}%`} /><KV k="Zone" v={r.zone ?? "—"} /></div>
          <div><KV k="Current Task" v={task ? `#${task.id} ${task.type} (${task.priority})` : "—"} /><KV k="From" v={pretty(task?.source ?? null)} /><KV k="Destination" v={pretty(task?.destination ?? r.destination)} /><KV k="Load" v={`${r.load.current} / ${r.load.capacity}`} /><KV k="ETA" v={r.eta_s !== null ? `${r.eta_s} s` : "—"} /><KV k="Path" v={`${r.path.length - r.path_index} cells left`} /></div>
          <div><KV k="Tasks completed" v={r.stats.tasks_completed} /><KV k="Distance" v={`${r.stats.distance_m.toFixed(0)} m`} /><KV k="Energy" v={`${r.stats.energy_wh.toFixed(0)} Wh`} /><KV k="Busy" v={`${(r.stats.busy_ticks / 10).toFixed(0)} s`} /><KV k="Waiting" v={`${(r.stats.wait_ticks / 10).toFixed(0)} s`} /><KV k="Position" v={`${r.position[0].toFixed(1)}, ${r.position[2].toFixed(1)}`} /></div>
        </div>
        <h4 className="drawer-sub">Recent events</h4>
        <table className="dt full"><tbody>{mine.map((e) => <tr key={e.id}><td>{tickToClock(e.tick, 100, true)}</td><td className={"sev-" + e.severity}>{e.severity}</td><td style={{ fontFamily: "var(--font)" }}>{e.message}</td></tr>)}</tbody></table>
      </div>
    </>
  );
}
