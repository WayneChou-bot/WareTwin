import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { API_URL } from "../../services/ws";
import { Canvas } from "@react-three/fiber";
import { STATUS_COLOR, SEVERITY_COLOR, layout, tickToClock, useStore } from "../../state/store";
import { Dot, Panel } from "../ui/primitives";
import { RobotMesh } from "../scene/Robots";
import { SceneContent } from "../scene/Scene3D";
import type { RobotState } from "../../schema/twin_state";

function RobotThumb({ status }: { status: string }) {
  const r = useMemo(() => ({ id: "", model: "AMR-L", floor: 1, lift_id: null, position: [0, 0, 0] as [number, number, number], heading: 0.6, velocity: 0, max_speed: 1.5, battery: 100, status: status as never, fsm: "IDLE" as const, health: 100, current_task_id: null, destination: null, path: [], path_index: 0, load: { current: 0, capacity: 4 }, zone: null, eta_s: null, fsm_since_tick: 0, stats: { distance_m: 0, tasks_completed: 0, energy_wh: 0, busy_ticks: 0, wait_ticks: 0 }, perception: { state: "CLEAR" as const, ahead_m: 4, nearest_m: null, obstacles: [] } }), [status]);
  return (
    <Canvas resize={{ offsetSize: true }} dpr={1} camera={{ position: [2.2, 1.6, 2.2], fov: 32 }} gl={{ alpha: true, antialias: true }} style={{ background: "transparent" }}>
      <ambientLight intensity={0.8} /><directionalLight position={[3, 5, 2]} intensity={2} /><pointLight position={[-2, 1, -2]} color="#60a5fa" intensity={4} />
      <group position={[0, -0.35, 0]}><RobotMesh r={r} selected={false} onSelect={() => {}} showLabel={false} lite smooth={false} /></group>
    </Canvas>
  );
}

export function SelectedRobotPanel() {
  const id = useStore((s) => s.selectedRobot);
  const r = useStore((s) => (id ? s.twin.robots[id] : undefined));
  const task = useStore((s) => (r?.current_task_id ? s.twin.tasks[r.current_task_id] : undefined));
  const locs = useStore((s) => s.locations);
  const pretty = (loc: string | null | undefined) => {
    if (!loc) return "—";
    const l = locs[loc]; if (!l) return loc;
    if (l.kind === "SHELF") return `Shelf ${loc.replace("SHELF-", "")}`;
    if (l.kind === "PACKING") return "Packing Station";
    return loc.replace(/-/g, " ");
  };
  const setModal = useStore((s) => s.setModal);
  if (!r) return <Panel title="Selected Robot"><div style={{ color: "var(--muted)", padding: "12px 0" }}>Click a robot in the 3D view</div></Panel>;
  const col = STATUS_COLOR[r.status];
  const estH = (r.battery / 100) * 3.1;
  const batteryStr = r.battery.toFixed(r.battery < 10 ? 1 : 0);
  return (
    <Panel title="Selected Robot">
      <div className="robot-head">
        <span className="id">{r.id}</span>
        {(r.floor > 1 || r.lift_id) && <span className="floor-chip">{r.lift_id ? `🛗 ${r.lift_id}` : `F${r.floor}`}</span>}
        <span className="status-text" style={{ color: col }}><Dot color={col} />{r.status[0] + r.status.slice(1).toLowerCase()}</span>
      </div>
      <div className="robot-img"><RobotThumb status={r.status} /></div>
      <div className="battery">
        <span className="bar"><span className="fill" style={{ width: `${r.battery}%`, background: r.battery < 10 ? "#ef4444" : r.battery < 20 ? "#f97316" : "#22c55e" }} /></span>
        <span className="pct">{batteryStr}%</span>
        <span className="est">Estimated {estH.toFixed(1)} h</span>
      </div>
      <div className="kv"><span className="k">State</span><span className="v" style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{r.fsm}{r.velocity > 0.05 ? ` · ${r.velocity.toFixed(2)} m/s` : ""}{r.eta_s ? ` · ETA ${r.eta_s}s` : ""}</span></div>
      <div className="kv"><span className="k">Perception</span><span className="v" style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: PERC_COLOR[r.perception?.state ?? "OFF"] }} title="Virtual LiDAR 270° / 4 m">{percText(r)}</span></div>
      <div className="kv"><span className="k">Current Task</span><span className="v">{task ? `#${task.id}  ${task.type[0] + task.type.slice(1).toLowerCase()}` : "—"}</span></div>
      <div className="kv"><span className="k">From</span><span className="v">{pretty(task?.source)}</span></div>
      <div className="kv"><span className="k">To</span><span className="v">{pretty(task?.destination ?? r.destination)}</span></div>
      <button className="btn-outline" onClick={() => setModal("robot")}>View Details</button>
    </Panel>
  );
}

const PERC_COLOR = { CLEAR: "#22d3ee", SLOWING: "#f59e0b", STOPPED: "#ef4444", OFF: "#64748b" } as const;
export function percText(r: RobotState): string {
  const P = r.perception; if (!P || P.state === "OFF") return "OFF";
  const dyn = P.obstacles.find((o) => o.kind !== "RACK");
  const who = dyn ? ` · ${dyn.id} ${dyn.distance_m.toFixed(1)} m` : "";
  return `${P.state} · ahead ${P.ahead_m.toFixed(1)} m${who}`;
}

export function LiveCameraPanel() {
  const active = useStore((s) => s.activeCamera);
  const setActive = useStore((s) => s.setActiveCamera);
  const camStatus = useStore((s) => s.twin.cameras);
  const cam = layout.cameras.find((c) => c.id === active) ?? layout.cameras[0];
  const isDock = cam.id.startsWith("CAM-DOCK");
  const groups: Array<[string, string]> = [["A", "A"], ["B", "B"], ["C", "C"], ["D", "D"], ["M", "F2"], ["DOCK", "Dock"]];
  const camsOf = (g: string) => layout.cameras.filter((c) => (g === "DOCK" ? c.id.startsWith("CAM-DOCK") : !c.id.startsWith("CAM-DOCK") && c.zone === g));
  const curGroup = isDock ? "DOCK" : cam.zone;
  const zoneCams = camsOf(curGroup);
  const offline = camStatus[cam.id]?.status === "OFFLINE";
  const source = useStore((s) => s.source);
  const obs = camStatus[cam.id]?.last_observation ?? null;
  const glRef = useRef<THREE.WebGLRenderer | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);   // setInterval 的 closure 會抓到舊的 busy state，用 ref 才能擋住重疊請求
  const [auto, setAuto] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const analyze = async () => {
    if (busyRef.current || offline) return;
    busyRef.current = true; setBusy(true); setErr(null);
    try {
      // 擷取 Live Camera 畫布（需 preserveDrawingBuffer）縮成 512px JPEG 送 VLM
      let image_b64: string | undefined;
      const gl = glRef.current;
      if (gl) {
        const src = gl.domElement; const c = document.createElement("canvas"); c.width = 512; c.height = Math.round(512 * src.height / src.width);
        c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height); image_b64 = c.toDataURL("image/jpeg", 0.7);
      }
      if (source !== "online") throw new Error("backend offline");
      const r = await fetch(`${API_URL}/api/vlm/observe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ camera_id: cam.id, image_b64 }) });
      if (!r.ok) throw new Error(await r.text());
    } catch (e) { setErr((e as Error).message.slice(0, 80)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => { if (!auto) return; const t = setInterval(analyze, 5000); return () => clearInterval(t); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, cam.id, source]);
  return (
    <Panel title={isDock ? "Camera · Dock" : `Camera · Zone ${cam.zone}`} action={
      <span className="cam-tabs">{groups.map(([g, l]) => <button key={g} className={curGroup === g ? "on" : ""} onClick={() => setActive(camsOf(g)[0].id)}>{l}</button>)}</span>
    }>
      <div className="cam-view">
        <Canvas resize={{ offsetSize: true }} dpr={1} camera={{ position: cam.position, fov: cam.fov_deg, near: 0.3, far: 120 }} gl={{ antialias: false, powerPreference: "low-power", preserveDrawingBuffer: true }} onCreated={({ camera, gl }) => { camera.lookAt(...cam.look_at); glRef.current = gl; }} key={cam.id} frameloop="always">
          <SceneContent quality="low" lite />
        </Canvas>
        {offline ? <div className="cam-offline">NO SIGNAL<br /><small>{cam.id} offline</small></div> : <span className="live">LIVE</span>}
        <span className="tag">{cam.id}</span>
        <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(0deg, transparent 0 3px, rgba(0,0,0,.12) 3px 4px)", pointerEvents: "none" }} />
        {obs && obs.bbox && obs.event !== "none" && (
          <div className="vlm-box" style={{ left: `${obs.bbox[0] * 100}%`, top: `${obs.bbox[1] * 100}%`, width: `${obs.bbox[2] * 100}%`, height: `${obs.bbox[3] * 100}%` }}><span>{obs.event.replace("_", " ")} {Math.round(obs.confidence * 100)}%</span></div>
        )}
        {busy && <div className="vlm-scan" />}
      </div>
      <div className="vlm-bar">
        <button className={"btn" + (busy ? " busy" : "")} onClick={analyze} disabled={busy || offline} title="Send this frame to the VLM">{busy ? "Analysing…" : "Analyze"}</button>
        <label className="auto"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto 5s</label>
        <span className={"vlm-result " + (obs ? (obs.event === "none" ? "ok" : "alert") : "")}>
          {err ? <span className="err">{err}</span> : obs ? `${obs.event === "none" ? "clear" : obs.event.replace("_", " ")} · ${Math.round(obs.confidence * 100)}%${obs.raw?.startsWith("simulated") ? " · sim" : ""}` : "no observation yet"}
        </span>
      </div>
      <div className="cam-dots">
        {zoneCams.map((c) => <button key={c.id} className={c.id === cam.id ? "on" : ""} onClick={() => setActive(c.id)} title={c.id} />)}
      </div>
    </Panel>
  );
}

export function EventLogPanel() {
  const events = useStore((s) => s.twin.recent_events);
  const select = useStore((s) => s.select);
  const setModal = useStore((s) => s.setModal);
  return (
    <Panel title="Event Log" grow action={<button className="link" onClick={() => setModal("audit")}>View All</button>}>
      {events.filter((e) => e.severity !== "LOW").slice(0, 8).map((e) => {
        const col = e.severity === "INFO" || e.severity === "LOW" ? undefined : SEVERITY_COLOR[e.severity];
        return (
          <div key={e.id} className="ev-row" onClick={() => e.robot_id && select(e.robot_id)}>
            <span className="t" style={{ color: col }}>{tickToClock(e.tick, 100, true).slice(0, 8)}</span>
            <span style={{ color: col }}>{e.message}</span>
          </div>
        );
      })}
    </Panel>
  );
}
