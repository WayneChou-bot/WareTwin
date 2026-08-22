import { useStore, tickToClock } from "../../state/store";
import { simControl } from "../../simulation/runner";
import { Icon } from "../ui/primitives";

export function TopBar() {
  const mode = useStore((s) => s.twin.sim.mode);
  const tick = useStore((s) => s.twin.sim.tick);
  const speed = useStore((s) => s.speed);
  const paused = useStore((s) => s.paused);
  const source = useStore((s) => s.source);
  const drawer = useStore((s) => s.drawer);
  const setDrawer = useStore((s) => s.setDrawer);
  const setModal = useStore((s) => s.setModal);
  const alerts = useStore((s) => s.twin.alerts);
  const quality = useStore((s) => s.quality);
  const setQuality = useStore((s) => s.setQuality);
  const unack = Object.values(alerts).filter((a) => !a.acknowledged).length;
  const simDate = "2026/05/20";
  return (
    <header className="topbar">
      <div className="brand"><span className="ai">Ware</span><span>Twin</span><span className="brand-sub">Warehouse Digital Twin</span></div>
      <span className={"badge-live " + (paused ? "paused" : mode === "WHATIF" ? "whatif" : "live")}>
        <span className="dot" style={{ background: "currentColor", width: 6, height: 6 }} />{paused ? "PAUSED" : mode === "WHATIF" ? "SIMULATION" : "LIVE"}
      </span>
      <span className={"badge-src " + source} title={source === "online" ? "Connected to backend (FastAPI WebSocket)" : source === "local" ? "Backend unreachable — running local simulation engine" : "Connecting to backend…"}>
        <span className="dot" style={{ background: "currentColor", width: 6, height: 6 }} />{source === "online" ? "BACKEND" : source === "local" ? "LOCAL" : "CONNECTING"}
      </span>
      <div className="topbar-right">
        <div className="sim-controls" title="Simulation controls">
          <button className={!paused ? "on" : ""} title="Play" onClick={() => simControl.play()}>{Icon.play}</button>
          <button className={paused ? "on" : ""} title="Pause" onClick={() => simControl.pause()}>{Icon.pause}</button>
          <button title="Reset (same seed)" onClick={() => simControl.reset()}>{Icon.reset}</button>
          {([1, 2, 5, 10] as const).map((x) => <button key={x} className={speed === x ? "on" : ""} onClick={() => simControl.play(x)}>{x}×</button>)}
        </div>
        <div className="clock" title="Simulation time">
          <div className="t">{tickToClock(tick, 100, true)}</div>
          <div className="d">{simDate} · T{tick}</div>
        </div>
        <div className="vsep" />
        <button className={"tb-btn" + (drawer === "scenarios" ? " on" : "")} onClick={() => setDrawer("scenarios")} title="Failure injection">{Icon.bolt}<span>Scenarios</span></button>
        <button className={"tb-btn" + (drawer === "ops" ? " on" : "")} onClick={() => setDrawer("ops")} title="AI Operations: KPI + explainable decisions">{Icon.brain}<span>AI Ops</span></button>
        <button className={"tb-btn" + (drawer === "whatif" ? " on" : "")} onClick={() => setDrawer("whatif")} title="What-if simulation: clone the twin, inject, compare KPI">{Icon.fork}<span>What-if</span></button>
        <div className="vsep" />
        <button className="icon-btn" title="Audit log" onClick={() => setModal("audit")}>{Icon.bell}{unack > 0 && <span className="dot">{unack}</span>}</button>
        <button className="icon-btn" title={`Render quality: ${quality} (click to cycle)`} onClick={() => setQuality(quality === "low" ? "medium" : quality === "medium" ? "high" : "low")}>{Icon.gear}</button>
        <div className="vsep" />
        <div className="user"><span className="avatar">{Icon.user}</span><span>Admin</span>{Icon.chev}</div>
      </div>
    </header>
  );
}
