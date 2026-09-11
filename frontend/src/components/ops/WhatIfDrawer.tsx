/**
 * What-if Simulation 抽屜（規格 1️⃣7️⃣ / Demo 08）
 *  ☑ 情境 → Duration → RUN → 後端複製 LIVE 引擎跑 Baseline 與 Scenario → 對照表 / 關鍵事件 / AI 建議
 *  「Apply to LIVE」把同一組注入打到 LIVE。
 */
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../ui/useFocusTrap";
import { useStore, tickToClock } from "../../state/store";
import { wsSend, onWhatIfResult, onWhatIfError, onWhatIfProgress, markWhatIfPending } from "../../services/ws";
import { simControl } from "../../simulation/runner";
import type { ScenarioInjection, WhatIfResult } from "../../schema/twin_state";

/** 結果型別以共用 schema（twin_state.ts ≡ backend schema.py WhatIfResult）為準，抽屜不再自行定義 */
export type WhatIfResultEx = WhatIfResult;

/** ensemble 時單次時長上限（秒）——與 backend sim/whatif.py ensemble_duration_cap 同一條規則：seeds × duration ≤ 9000 tick */
const durationCapS = (seeds: number) => (seeds <= 1 ? 600 : Math.max(30, Math.floor(9000 / seeds / 10)));

const PRESETS: Array<{ id: string; label: string; demo: string; build: () => ScenarioInjection }> = [
  { id: "r07", label: "R07 failure", demo: "08", build: () => ({ kind: "ROBOT_FAILURE", robot_id: "R07" }) },
  { id: "cv03", label: "Conveyor #03 failure", demo: "04", build: () => ({ kind: "CONVEYOR_FAILURE", conveyor_id: "CV03" }) },
  { id: "human", label: "Human intrusion · Zone B (90 s)", demo: "03", build: () => ({ kind: "HUMAN_INTRUSION", zone_id: "B", duration_ticks: 900 }) },
  { id: "traffic", label: "Traffic congestion · Zone C (80%)", demo: "06", build: () => ({ kind: "TRAFFIC_CONGESTION", zone_id: "C", level: 0.8, duration_ticks: 1800 }) },
  { id: "cam", label: "Camera B03 offline", demo: "07", build: () => ({ kind: "CAMERA_OFFLINE", camera_id: "CAM-B03" }) },
  { id: "burst", label: "Peak demand · +20 HIGH tasks", demo: "—", build: () => ({ kind: "TASK_BURST", count: 20, priority: "HIGH" }) },
  { id: "lowbat", label: "R03 battery → 8%", demo: "02", build: () => ({ kind: "ROBOT_BATTERY_SET", robot_id: "R03", battery: 8 }) },
  { id: "lift1", label: "LIFT-1 fault (cross-floor via LIFT-2 only)", demo: "12", build: () => ({ kind: "LIFT_FAULT", lift_id: "LIFT-1" }) },
];

export function WhatIfDrawer() {
  const open = useStore((s) => s.drawer === "whatif");
  const setDrawer = useStore((s) => s.setDrawer);
  const source = useStore((s) => s.source);
  const result = useStore((s) => s.whatif) as WhatIfResultEx | null;
  const setResult = useStore((s) => s.setWhatIf);
  const [sel, setSel] = useState<Set<string>>(new Set(["r07"]));
  const [dur, setDur] = useState(300);
  const [seeds, setSeeds] = useState(1);
  const [baseline, setBaseline] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => onWhatIfResult((r) => { pendingId.current = null; setResult(r as WhatIfResultEx); setRunning(false); setProgress(null); setErr(null); }), [setResult]);
  const seq = useRef(0); const pendingId = useRef<string | null>(null);
  useEffect(() => onWhatIfError((m, id) => { if (id === pendingId.current) { pendingId.current = null; setRunning(false); setProgress(null); setErr(m); } }), []);
  useEffect(() => onWhatIfProgress((done, total, id) => { if (id === pendingId.current) setProgress({ done, total }); }), []);
  const trap = useFocusTrap<HTMLElement>(open);
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(null); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, setDrawer]);
  if (!open) return null;

  const injections = () => PRESETS.filter((p) => sel.has(p.id)).map((p) => p.build());
  const run = () => {
    if (source !== "online" || sel.size === 0) return;
    const request_id = `w${++seq.current}-${Date.now().toString(36)}`; pendingId.current = request_id;
    setRunning(true); setProgress(null); setErr(null); markWhatIfPending(request_id);
    wsSend({ type: "WHATIF_RUN", request_id, request: { scenario_name: PRESETS.filter((p) => sel.has(p.id)).map((p) => p.label).join(" + "), injections: injections(), duration_ticks: Math.min(dur, durationCapS(seeds)) * 10, run_baseline: baseline, ensemble_seeds: seeds } });
  };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const fmt = (k: string, v: number) => k === "on_time_rate" || k === "utilization" ? `${Math.round(v * 100)}%` : k === "congestion_index" ? `${Math.round(v * 100)}%` : Number.isInteger(v) ? String(v) : v.toFixed(1);
  const pctText = (k: string, b: number, s: number) => (k === "on_time_rate" || k === "utilization" || k === "congestion_index") ? `${((s - b) * 100).toFixed(0) === "0" ? "±0" : ((s - b) * 100 > 0 ? "+" : "") + ((s - b) * 100).toFixed(0)} pt` : b ? `${s - b > 0 ? "+" : ""}${(((s - b) / b) * 100).toFixed(0)}%` : "";

  return (
    <aside className="drawer wide" role="dialog" aria-label="What-if Simulation" ref={trap} tabIndex={-1}>
      <header className="drawer-h"><span>What-if Simulation</span><button className="icon-btn" aria-label="Close" onClick={() => setDrawer(null)}>✕</button></header>
      <div className="drawer-b">
        <p className="hint">Two clones of the current twin state: Baseline runs as-is, Scenario runs with the injected failures. Same random seed, so the difference comes only from the failures. LIVE operational state is never changed (only an audit event records that the analysis ran).</p>
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
            <select value={Math.min(dur, durationCapS(seeds))} onChange={(e) => setDur(+e.target.value)}>{[60, 120, 180, 300, 600].filter((d) => d <= durationCapS(seeds)).map((d) => <option key={d} value={d}>{d >= 60 ? `${d / 60} min` : `${d} s`}</option>)}</select>
          </label>
          <label>Seeds
            <select value={seeds} onChange={(e) => setSeeds(+e.target.value)} title="Replay the same window under different random seeds to get a range instead of a single number">{[1, 3, 5].map((n) => <option key={n} value={n}>{n === 1 ? "1 (single)" : `${n} (range)`}</option>)}</select>
          </label>
          <label className="auto"><input type="checkbox" checked={baseline} onChange={(e) => setBaseline(e.target.checked)} /> compare with baseline</label>
          <button className="btn primary" disabled={running || source !== "online" || sel.size === 0} onClick={run}>{running ? (progress ? `Simulating… ${progress.done}/${progress.total}` : "Simulating…") : "RUN"}</button>
        </div>
        {seeds > 1 && <div className="hint">Multi-seed range: {seeds} seeded replays per side. The range is the empirical spread across those replays — the model's internal stochastic variability, not real-world uncertainty. Compute budget caps duration at {durationCapS(seeds) / 60} min for {seeds} seeds.</div>}
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
                  const dr = result.ensemble?.delta_range?.[m.key];
                  // 沒有 baseline 時 Δ 欄是空的，多 seed 的區間改在 Scenario 欄呈現（median + [min … max]）
                  const sr = !dr ? result.ensemble?.scenario_range?.[m.key] : undefined;
                  return (
                    <tr key={m.key}>
                      <td style={{ fontFamily: "var(--font)" }}>{m.label}</td>
                      <td>{b === undefined || b === null ? "—" : fmt(m.key, b)}</td>
                      <td>
                        {sr ? fmt(m.key, sr.median) : fmt(m.key, s)}
                        {sr && <div className="demo" style={{ whiteSpace: "nowrap" }}>[{fmt(m.key, sr.min)} … {fmt(m.key, sr.max)}] · median of {result.ensemble!.seeds_run}</div>}
                      </td>
                      <td className={good === null ? "" : good ? "st-inprog" : "st-fail"}>
                        {b === undefined || b === null ? "" : `${d > 0 ? "+" : ""}${fmt(m.key, Math.abs(d)).replace(/^/, d < 0 ? "-" : "")} ${pctText(m.key, b, s)}`}
                        {dr && <div className="demo" style={{ whiteSpace: "nowrap" }}>Δ [{fmt(m.key, dr.min)} … {fmt(m.key, dr.max)}] · med {fmt(m.key, dr.median)}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {result.ensemble && <div className="hint">Multi-seed range across {result.ensemble.seeds_run} seeded replays — the empirical spread of the model's internal stochastic variability, not real-world uncertainty.</div>}
            {result.event_diff && (
              <>
                <h4 className="drawer-sub">Divergence vs baseline (same seed)</h4>
                {result.event_diff.first_divergence ? (
                  <div className="wi-events">
                    <div className="ev-row"><span className="t">{tickToClock(result.event_diff.first_divergence.tick, 100, true).slice(0, 8)}</span>
                      <span>First divergence — scenario: <b>{result.event_diff.first_divergence.scenario.length ? result.event_diff.first_divergence.scenario.map((e) => e.message).join("; ") : "no event"}</b>
                        <span className="demo"> · baseline at this tick: {result.event_diff.first_divergence.baseline.length ? result.event_diff.first_divergence.baseline.map((e) => e.message).join("; ") : "no event"}</span></span></div>
                    {result.event_diff.event_count_delta.slice(0, 8).map((c) => (
                      <div key={c.type} className="ev-row"><span className="t">{c.delta > 0 ? "+" : ""}{c.delta}</span><span className="demo">{c.type}</span></div>
                    ))}
                  </div>
                ) : result.event_diff.complete
                  ? <div className="hint">Event streams are identical — the injections produced no observable divergence in this window.</div>
                  : <div className="hint">No divergence found up to {tickToClock(result.event_diff.compared_until_tick, 100, true).slice(0, 8)} — the event log was truncated after that point, so the rest of the window was not compared.</div>}
              </>
            )}
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

