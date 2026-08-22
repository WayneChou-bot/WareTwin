import { SEVERITY_COLOR, STATUS_COLOR, layout, tickToClock, useStore } from "../../state/store";
import { Dot, Icon, Panel, StatRow } from "../ui/primitives";
import { simControl } from "../../simulation/runner";

export function FleetOverviewPanel() {
  const f = useStore((s) => s.twin.kpi.fleet);
  const setModal = useStore((s) => s.setModal);
  return (
    <Panel title="Fleet Overview" action={<button className="link" onClick={() => setModal("fleet")}>Robot list →</button>}>
      <StatRow label="Total Robots" value={f.total} big />
      <StatRow label="Active" value={f.active} color={STATUS_COLOR.ACTIVE} />
      <StatRow label="Charging" value={f.charging} color={STATUS_COLOR.CHARGING} />
      <StatRow label="Idle" value={f.idle} color={STATUS_COLOR.IDLE} />
      <StatRow label="Error" value={f.error} color={STATUS_COLOR.ERROR} />
    </Panel>
  );
}

export function TaskOverviewPanel() {
  const o = useStore((s) => s.twin.kpi.operation);
  return (
    <Panel title="Task Overview">
      <StatRow label="Ongoing Tasks" value={o.ongoing} />
      <StatRow label="Completed Today" value={o.completed_today} />
      <StatRow label="Avg. Completion Time" value={`${(o.avg_task_time_s / 60).toFixed(2)} min`} />
      <StatRow label="On-time Rate" value={`${(o.on_time_rate * 100).toFixed(1)}%`} />
      <StatRow label="Utilization" value={`${Math.round(o.avg_utilization * 100)}%`} />
    </Panel>
  );
}

const SUB_COLOR = { NORMAL: "#22c55e", WARNING: "#eab308", ERROR: "#ef4444" } as const;
export function SystemStatusPanel() {
  const sub = useStore((s) => s.twin.subsystems);
  const rows: Array<[string, keyof typeof sub]> = [["Warehouse", "WAREHOUSE"], ["Conveyors", "CONVEYORS"], ["Charging", "CHARGING"], ["CCTV", "CCTV"], ["Network", "NETWORK"]];
  return (
    <Panel title="System Status">
      {rows.map(([label, key]) => {
        const st = sub[key] ?? "NORMAL";
        return (
          <div className="stat-row" key={key}>
            <span>{label}</span>
            <span className="status-text" style={{ color: SUB_COLOR[st] }}><Dot color={SUB_COLOR[st]} />{st === "NORMAL" ? "Normal" : st === "WARNING" ? "Warning" : "Error"}</span>
          </div>
        );
      })}
    </Panel>
  );
}

export function AlertsPanel() {
  const alerts = useStore((s) => s.twin.alerts);
  const select = useStore((s) => s.select);
  const focus = useStore((s) => s.focus);
  const list = Object.values(alerts).filter((a) => a.resolved_tick === null).sort((a, b) => b.created_tick - a.created_tick);
  const go = (a: (typeof list)[number]) => {
    if (a.robot_id) select(a.robot_id);
    else if (a.zone_id) {
      const z = layout.zones.find((zz) => zz.id === a.zone_id)!;
      const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
      focus([(Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2]);
    }
  };
  return (
    <Panel title="Alerts" grow>
      {list.map((a) => (
        <div key={a.id} className={"alert-card " + a.severity + (a.acknowledged ? " acked" : "")} onClick={() => go(a)}>
          <span className="ico" style={{ background: SEVERITY_COLOR[a.severity], color: "#fff" }}>{a.severity === "CRITICAL" ? "!" : a.severity === "HIGH" ? "▲" : "i"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ttl">{a.title}</div>
            <div className="meta">{tickToClock(a.created_tick)}&nbsp;&nbsp;&nbsp;{a.detail}</div>
          </div>
          {!a.acknowledged && <button className="ack" title="Acknowledge" onClick={(e) => { e.stopPropagation(); simControl.ackAlert(a.id); }}>{Icon.check}</button>}
        </div>
      ))}
      {list.length === 0 && <div style={{ color: "var(--muted)" }}>No active alerts</div>}
    </Panel>
  );
}
