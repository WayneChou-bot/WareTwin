import { useMemo } from "react";
import { STATUS_COLOR, tickToClock, useStore } from "../../state/store";
import { Panel } from "../ui/primitives";

export function TaskQueuePanel() {
  const tasks = useStore((s) => s.twin.tasks);
  const selected = useStore((s) => s.selectedRobot);
  const select = useStore((s) => s.select);
  const locs = useStore((s) => s.locations);
  const setModal = useStore((s) => s.setModal);
  const order = { IN_PROGRESS: 0, ASSIGNED: 1, WAITING: 2 } as Record<string, number>;
  const all = Object.values(tasks).filter((t) => t.status in order).sort((a, b) => (order[a.status] - order[b.status]) || a.id.localeCompare(b.id));
  // 與預期圖一致：3 筆進行中 + 2 筆等待中
  const rows = [...all.filter((t) => t.status === "IN_PROGRESS").slice(0, 3), ...all.filter((t) => t.status !== "IN_PROGRESS").slice(0, 2)];
  const pretty = (id: string) => {
    const l = locs[id]; if (!l) return id;
    if (l.kind === "SHELF") return `Shelf ${id.replace("SHELF-", "")}`;
    if (l.kind === "PACKING") return "Packing";
    if (l.kind === "CHARGING") return "Charger";
    if (l.kind === "SORTING") return "Sorting";
    return id.replace("-", " ").replace("INBOUND", "Inbound").replace("OUTBOUND", "Outbound");
  };
  return (
    <Panel title="Task Queue" action={<button className="link" onClick={() => setModal("tasks")}>View All Tasks →</button>}>
      <div className="table-wrap"><table className="dt">
        <thead><tr><th>Task ID</th><th>Type</th><th>From</th><th>To</th><th>Robot</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={t.assigned_robot && t.assigned_robot === selected ? "sel" : ""} onClick={() => t.assigned_robot && select(t.assigned_robot)}>
              <td>#{t.id}</td><td>{t.type[0] + t.type.slice(1).toLowerCase()}</td><td>{pretty(t.source)}</td><td>{pretty(t.destination)}</td>
              <td>{t.assigned_robot ?? "—"}</td>
              <td className={t.status === "IN_PROGRESS" ? "st-inprog" : t.status === "WAITING" ? "st-wait" : "st-fail"}>{t.status === "IN_PROGRESS" ? "In Progress" : t.status[0] + t.status.slice(1).toLowerCase()}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Panel>
  );
}

export function ThroughputPanel() {
  const op = useStore((s) => s.twin.kpi.operation);
  const series = useStore((s) => s.twin.kpi.throughput_series);
  const W = 300, H = 150, px = 34, py = 10, pb = 24;
  // x 軸：最近 120 分鐘的模擬時間 (每點 1 分鐘)；y 軸上限隨資料放大
  const n = 120;
  const lastTick = series.length ? series[series.length - 1].tick : 0;
  const firstTick = Math.max(0, lastTick - (n - 1) * 600);
  const pts = series.filter((p) => p.tick >= firstTick);
  const maxY = Math.max(20, Math.ceil(Math.max(op.completed_target, ...pts.map((p) => p.completed)) / 50) * 50);
  const sx = (tick: number) => px + ((tick - firstTick) / ((n - 1) * 600)) * (W - px - 8);
  const sy = (v: number) => py + (1 - v / maxY) * (H - py - pb);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.tick).toFixed(1)},${sy(p.completed).toFixed(1)}`).join(" ");
  const area = pts.length > 1 ? line + ` L${sx(pts[pts.length - 1].tick).toFixed(1)},${sy(0)} L${sx(pts[0].tick).toFixed(1)},${sy(0)} Z` : "";
  const target = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.tick).toFixed(1)},${sy(p.target).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const ySteps = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxY * f));
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => { const t = firstTick + f * (n - 1) * 600; return { x: sx(t), label: tickToClock(t) }; });
  return (
    <Panel title="Throughput" sub="(Today)">
      <div className="legend"><span><i style={{ background: "#22c55e" }} />Completed</span><span><i style={{ background: "#3b82f6", borderTop: "2px dashed #3b82f6", height: 0 }} />Target</span><span className="big"><b>{op.completed_today}</b> / {op.completed_target}</span></div>
      <div className="chart-wrap" style={{ marginTop: 4 }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none" style={{ display: "block" }}>
          <defs><linearGradient id="tpfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#22c55e" stopOpacity=".28" /><stop offset="1" stopColor="#22c55e" stopOpacity="0" /></linearGradient></defs>
          {ySteps.map((v) => (
            <g key={v}><line x1={px} x2={W - 8} y1={sy(v)} y2={sy(v)} stroke="#1e293b" strokeWidth="1" /><text x={px - 6} y={sy(v) + 4} fill="#8b98ad" fontSize="9" textAnchor="end" fontFamily="JetBrains Mono, monospace">{v}</text></g>
          ))}
          {xLabels.map((l, i) => <text key={i} x={l.x} y={H - 8} fill="#8b98ad" fontSize="9" textAnchor="middle" fontFamily="JetBrains Mono, monospace">{l.label}</text>)}
          {pts.length > 1 && <path d={target} stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="4 4" fill="none" />}
          {area && <path d={area} fill="url(#tpfill)" />}
          {pts.length > 1 && <path d={line} stroke="#22c55e" strokeWidth="1.6" fill="none" strokeLinejoin="round" />}
          {last && <circle cx={sx(last.tick)} cy={sy(last.completed)} r="3" fill="#22c55e" />}
        </svg>
      </div>
    </Panel>
  );
}

export function RobotStatusPanel() {
  const f = useStore((s) => s.twin.kpi.fleet);
  const parts = useMemo(() => [
    { k: "Active", v: f.active, c: STATUS_COLOR.ACTIVE }, { k: "Charging", v: f.charging, c: STATUS_COLOR.CHARGING },
    { k: "Idle", v: f.idle, c: STATUS_COLOR.IDLE }, { k: "Warning", v: f.warning, c: STATUS_COLOR.WARNING }, { k: "Error", v: f.error, c: STATUS_COLOR.ERROR },
  ].filter((p) => p.v > 0), [f]);
  const R = 52, r = 34, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <Panel title="Robot Status">
      <div className="donut-wrap">
        <svg viewBox="0 0 130 130">
          <circle cx="65" cy="65" r={R} fill="none" stroke="#1e293b" strokeWidth={R - r} />
          {parts.map((p) => {
            const len = (p.v / f.total) * C; const el = <circle key={p.k} cx="65" cy="65" r={R} fill="none" stroke={p.c} strokeWidth={R - r} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform="rotate(-90 65 65)" />; off += len; return el;
          })}
          <text x="65" y="62" textAnchor="middle" fill="#e5eaf3" fontSize="22" fontWeight="700" fontFamily="JetBrains Mono, monospace">{f.total}</text>
          <text x="65" y="78" textAnchor="middle" fill="#8b98ad" fontSize="10">Total</text>
        </svg>
        <div className="donut-legend">
          {parts.map((p) => <div className="row" key={p.k}><span className="dot" style={{ background: p.c }} /><span>{p.k}</span><span className="n">{p.v} ({((p.v / f.total) * 100).toFixed(1)}%)</span></div>)}
        </div>
      </div>
    </Panel>
  );
}
