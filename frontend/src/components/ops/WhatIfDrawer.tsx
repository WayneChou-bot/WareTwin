/**
 * What-if Simulation 抽屜（規格 1️⃣7️⃣ / Demo 08）
 *  ☑ 情境 → Duration → RUN → 後端複製 LIVE 引擎跑 Baseline 與 Scenario → 對照表 / 關鍵事件 / AI 建議
 *  「Apply to LIVE」把同一組注入打到 LIVE。
 */
import { useEffect, useState } from "react";
import { useFocusTrap } from "../ui/useFocusTrap";
import { useStore, tickToClock } from "../../state/store";
import { wsSend, onWhatIfResult, onWhatIfError, markWhatIfPending } from "../../services/ws";
import { simControl } from "../../simulation/runner";
import type { ScenarioInjection, TwinEvent } from "../../schema/twin_state";

interface Win { [k: string]: number }
export interface WhatIfResultEx {
  request: { scenario_name: string; injections: ScenarioInjection[]; duration_ticks: number; run_baseline: boolean };
  delta: Record<string, number>;
  key_events: TwinEvent[];
  ai_recommendation: string | null;
  window: { baseline: Win | null; scenario: Win; metrics: Array<{ key: string; label: string; higher_is_better: boolean }> };
  start_tick: number;
  compute_ms: number;
}

const PRESETS: Array<{ id: string; label: string; demo: string; build: () => ScenarioInjection }> = [
  { id: "r07", label: "R07 failure", demo: "08", build: () => ({ kind: "ROBOT_FAILURE", robot_id: "R07" }) },
  { id: "cv03", label: "Conveyor #03 failure", demo: "04", build: () => ({ kind: "CONVEYOR_FAILURE", conveyor_id: "CV03" }) },
  { id: "human", label: "Human intrusion · Zone B (90 s)", demo: "03", build: () => ({ kind: "HUMAN_INTRUSION", zone_id: "B", duration_ticks: 900 }) },
  { id: "traffic", label: "Traffic congestion · Zone C (80%)", demo: "06", build: () => ({ kind: "TRAFFIC_CONGESTION", zone_id: "C", level: 0.8, duration_ticks: 1800 }) },
  { id: "cam", label: "Camera B03 offline", demo: "07", build: () => ({ kind: "CAMERA_OFFLINE", camera_id: "CAM-B03" }) },
  { id: "burst", label: "Peak demand · +20 HIGH tasks", demo: "—", build: () => ({ kind: "TASK_BURST", count: 20, priority: "HIGH" }) },
  { id: "lowbat", label: "R03 battery → 8%", demo: "02", build: () => ({ kind: "ROBOT_BATTERY_SET", robot_id: "R03", battery: 8 }) },
];

export function WhatIfDrawer() {
  const open = useStore((s) => s.drawer === "whatif");
  const setDrawer = useStore((s) => s.setDrawer);
  const source = useStore((s) => s.source);
  const result = useStore((s) => s.whatif) as WhatIfResultEx | null;
  const setResult = useStore((s) => s.setWhatIf);
  const [sel, setSel] = useState<Set<string>>(new Set(["r07"]));
  const [dur, setDur] = useState(300);
  const [baseline, setBaseline] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => onWhatIfResult((r) => { setResult(r as WhatIfResultEx); setRunning(false); setErr(null); }), [setResult]);
  useEffect(() => onWhatIfError((m) => { setRunning(false); setErr(m); }), []);
  const trap = useFocusTrap<HTMLElement>(open);
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(null); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, setDrawer]);
  if (!open) return null;

  const injections = () => PRESETS.filter((p) => sel.has(p.id)).map((p) => p.build());
  const run = () => {
    if (source !== "online" || sel.size === 0) return;
    setRunning(true); setErr(null); markWhatIfPending(true);
    wsSend({ type: "WHATIF_RUN", request: { scenario_name: PRESETS.filter((p) => sel.has(p.id)).map((p) => p.label).join(" + "), injections: injections(), duration_ticks: dur * 10, run_baseline: baseline } });
  };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const fmt = (k: string, v: number) => k === "on_time_rate" || k === "utilization" ? `${Math.round(v * 100)}%` : k === "congestion_index" ? `${Math.round(v * 100)}%` : Number.isInteger(v) ? String(v) : v.toFixed(1);
  const pctText = (k: string, b: number, s: number) => (k === "on_time_rate" || k === "utilization" || k === "congestion_index") ? `${((s - b) * 100).toFixed(0) === "0" ? "±0" : ((s - b) * 100 > 0 ? "+" : "") + ((s - b) * 100).toFixed(0)} pt` : b ? `${s - b > 0 ? "+" : ""}${(((s - b) / b) * 100).toFixed(0)}%` : "";

  return (
    <aside className="drawer wide" role="dialog" aria-label="What-if Simulation" ref={trap} tabIndex={-1}>
      <header className="drawer-h"><span>What-if Simulation</span><button className="icon-btn" aria-label="Close" onClick={() => setDrawer(null)}>✕</button></header>
      <div className="drawer-b">
        <p className="hint">Two clones of the current twin state: Baseline runs as-is, Scenario runs with the injected failures. Same random seed, so the difference comes only from the failures. LIVE is never touched.</p>
        <h4 className="drawer-sub" style={{ marginTop: 0 }}>Scenario</h4>
        <div className="wi-list">
          {PRESETS.map((p) => (
            <label key={p.id} className={"wi-item" + (sel.has(p.id) ? " on" : "")}>
              <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} /><span>{p.label}</span><span className="demo">Demo {p.demo}</span>
            </label>
          ))}
        </div>
        <div className="wi-ctl">
          <label>Duration
            <select value={dur} onChange={(e) => setDur(+e.target.value)}>{[60, 120, 180, 300, 600].map((d) => <option key={d} value={d}>{d >= 60 ? `${d / 60} min` : `${d} s`}</option>)}</select>
          </label>
          <label className="auto"><input type="checkbox" checked={baseline} onChange={(e) => setBaseline(e.target.checked)} /> compare with baseline</label>
          <button className="btn primary" disabled={running || source !== "online" || sel.size === 0} onClick={run}>{running ? "Simulating…" : "RUN"}</button>
        </div>
        {source !== "online" && <div className="hint">What-if runs on the backend (clone of the live engine). Start the backend to enable.</div>}
        {err && <div className="form-err" style={{ marginTop: 6 }}>⚠ {err}</div>}

        {result && (
          <>
            <h4 className="drawer-sub">Result · {result.request.scenario_name} · {result.request.duration_ticks / 10}s from {tickToClock(result.start_tick, 100, true)} <span className="demo">{result.compute_ms} ms</span></h4>
            <table className="dt wi-table">
              <thead><tr><th>Metric</th><th>Baseline</th><th>Scenario</th><th>Δ</th></tr></thead>
              <tbody>
                {result.window.metrics.map((m) => {
                  const b = result.window.baseline?.[m.key], s = result.window.scenario[m.key];
                  const d = b === undefined || b === null ? 0 : s - b;
                  const good = d === 0 ? null : (d > 0) === m.higher_is_better;
                  return (
                    <tr key={m.key}>
                      <td style={{ fontFamily: "var(--font)" }}>{m.label}</td>
                      <td>{b === undefined || b === null ? "—" : fmt(m.key, b)}</td>
                      <td>{fmt(m.key, s)}</td>
                      <td className={good === null ? "" : good ? "st-inprog" : "st-fail"}>{b === undefined || b === null ? "" : `${d > 0 ? "+" : ""}${fmt(m.key, Math.abs(d)).replace(/^/, d < 0 ? "-" : "")} ${pctText(m.key, b, s)}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <h4 className="drawer-sub">AI recommendation</h4>
            <div className="bubble" style={{ maxWidth: "100%", background: "var(--panel-2)", border: "1px solid var(--border)" }}>{result.ai_recommendation}</div>
            <h4 className="drawer-sub">Key events in scenario ({result.key_events.length})</h4>
            <div className="wi-events">
              {result.key_events.slice(0, 14).map((e) => <div key={e.id} className="ev-row"><span className="t">{tickToClock(e.tick, 100, true).slice(0, 8)}</span><span className={"sev-" + e.severity}>{e.message}</span></div>)}
            </div>
            <div className="wi-actions">
              <button className="btn danger" onClick={() => { for (const i of result.request.injections) simControl.inject(i); setDrawer("scenarios"); }}>Apply scenario to LIVE</button>
              <button className="btn" onClick={() => setResult(null)}>Clear</button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

