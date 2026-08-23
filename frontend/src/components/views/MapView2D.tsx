import { useMemo } from "react";
import { STATUS_COLOR, layout, useStore } from "../../state/store";
import { buildNavGrid } from "../../layout/navgrid";
import { getEngine } from "../../simulation/runner";

/** 俯視 2D 地圖：導航網格障礙、Zone、輸送帶、機器人。TRAFFIC / HEATMAP 模式疊上熱區。 */
export function MapView2D({ mode }: { mode: "MAP" | "TRAFFIC" | "HEATMAP" }) {
  const allRobots = useStore((s) => s.twin.robots);
  const activeFloorSel = useStore((s) => s.activeFloor);
  const mapFloor = typeof activeFloorSel === "number" ? activeFloorSel : 1;   // 2D 圖一次畫一層；All/Exploded 時畫一樓
  const robots = Object.fromEntries(Object.entries(allRobots).filter(([, r]) => r.floor === mapFloor));
  const zones = useStore((s) => s.twin.zones);
  const selected = useStore((s) => s.selectedRobot);
  const select = useStore((s) => s.select);
  const { width: W, depth: D } = layout.size;
  const grid = useMemo(() => buildNavGrid(layout, mapFloor), [mapFloor]);

  // 障礙格合併成矩形 (逐列 run-length) 以減少 SVG 元素
  const blocks = useMemo(() => {
    const fp = mapFloor === 1 ? null : layout.floors.find((f) => f.id === mapFloor)?.footprint;
    const inFp = (c: number, r: number) => !fp || (c >= Math.min(...fp.map((p) => p[0])) && c < Math.max(...fp.map((p) => p[0])) && r >= Math.min(...fp.map((p) => p[1])) && r < Math.max(...fp.map((p) => p[1])));
    const out: Array<[number, number, number]> = [];
    for (let r = 0; r < grid.rows; r++) {
      let c = 0;
      while (c < grid.cols) {
        if (grid.cells[r * grid.cols + c] === 1 && inFp(c, r)) { let e = c; while (e < grid.cols && grid.cells[r * grid.cols + e] === 1 && inFp(e, r)) e++; out.push([c, r, e - c]); c = e; } else c++;
      }
    }
    return out;
  }, [grid, mapFloor]);

  // TRAFFIC：即時密度 — 每台機器人以高斯核心擴散，速度越慢（塞住）越熱，加上最近 ~20 s 的短期軌跡
  // HEATMAP：長期累積 — 引擎的 traffic 陣列（幾乎不衰減），看的是「哪些走道一直在被使用」
  const tick = useStore((s) => s.twin.sim.tick);
  const source = useStore((s) => s.source);
  const remoteHeat = useStore((s) => s.heat);
  const heat = useMemo(() => {
    if (mode === "MAP") return null;
    const cs = 2, cols = Math.ceil(W / cs), rows = Math.ceil(D / cs), v = new Float32Array(cols * rows);
    const layer = source === "online" ? remoteHeat?.[`${mode === "HEATMAP" ? "CONGESTION" : "TRAFFIC"}:${mapFloor}`] : undefined;
    if (layer) {
      // 後端已降採樣到 2 m 格並正規化
      for (let i = 0; i < Math.min(v.length, layer.values.length); i++) v[i] = layer.values[i] * 100;
    } else if (source !== "online") {
      const eng = getEngine(); const g = eng.grid;
      const src = (mode === "HEATMAP" ? eng.traffic : eng.trafficShort)[mapFloor];
      if (src) for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) { const t = src[r * g.cols + c]; if (t > 0) v[Math.floor(r / cs) * cols + Math.floor(c / cs)] += t; }
    }
    if (mode === "TRAFFIC") {
      // 即時密度核心：半徑 ~5 m；停著不動且非閒置/充電的機器人權重加倍（瓶頸）
      for (const r of Object.values(robots)) {
        if (r.fsm === "IDLE" || r.fsm === "CHARGING" || r.fsm === "OFFLINE") continue;
        const w = r.velocity < 0.1 ? 60 : 30, cx = r.position[0] / cs, cz = r.position[2] / cs;
        for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) { const rr = Math.floor(cz) + dr, cc = Math.floor(cx) + dc; if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue; v[rr * cols + cc] += w * Math.exp(-(dr * dr + dc * dc) / 3); }
      }
    }
    // 平滑一次 (3x3)
    const out = new Float32Array(v.length);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { let s = 0, n = 0; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue; s += v[rr * cols + cc]; n++; } out[r * cols + c] = s / n; }
    let max = 0; for (let i = 0; i < out.length; i++) if (out[i] > max) max = out[i];
    return { cs, cols, rows, v: out, max: Math.max(max, 1) };
  // mapFloor / allRobots 必須在 deps 裡：暫停時切樓層才會重算，不會殘留上一層的資料（round-6 P2）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tick, W, D, source, remoteHeat, mapFloor, allRobots]);

  const heatColor = (t: number) => {
    const stops = [[0, 37, 99, 235], [0.35, 34, 197, 94], [0.6, 234, 179, 8], [0.8, 249, 115, 22], [1, 239, 68, 68]];
    let i = 1; while (i < stops.length - 1 && stops[i][0] < t) i++;
    const [t0, r0, g0, b0] = stops[i - 1], [t1, r1, g1, b1] = stops[i]; const k = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    return `rgb(${Math.round(r0 + (r1 - r0) * k)},${Math.round(g0 + (g1 - g0) * k)},${Math.round(b0 + (b1 - b0) * k)})`;
  };

  return (
    <svg className="map2d" viewBox={`-2 -7 ${W + 4} ${D + 10}`} preserveAspectRatio="xMidYMid meet">
      <rect x="0" y="0" width={W} height={D} fill="#0a1020" stroke="#334155" strokeWidth="0.4" />
      {/* 格線 */}
      {Array.from({ length: W / 10 + 1 }, (_, i) => <line key={"v" + i} x1={i * 10} x2={i * 10} y1="0" y2={D} stroke="#16213a" strokeWidth="0.15" />)}
      {Array.from({ length: D / 10 + 1 }, (_, i) => <line key={"h" + i} y1={i * 10} y2={i * 10} x1="0" x2={W} stroke="#16213a" strokeWidth="0.15" />)}
      {heat && (
        <g opacity="0.75">
          {Array.from(heat.v).map((s, i) => { const t = s / heat.max; if (t < 0.08) return null; return <rect key={i} x={(i % heat.cols) * heat.cs} y={Math.floor(i / heat.cols) * heat.cs} width={heat.cs} height={heat.cs} fill={heatColor(t)} opacity={Math.min(0.85, t + 0.15)} />; })}
        </g>
      )}
      {mapFloor !== 1 && <text x={1.5} y={-3.5} fill="#14b8a6" fontSize="2.6" fontWeight="700">FLOOR {mapFloor} · MEZZANINE</text>}
      {layout.zones.filter((z) => (z.floor ?? 1) === mapFloor).map((z) => {
        const st = zones[z.id]?.status; const col = st === "BLOCKED" ? "#ef4444" : st === "CONGESTED" ? "#f97316" : z.color;
        return <g key={z.id}><polygon points={z.polygon.map((p) => p.join(",")).join(" ")} fill={col} fillOpacity="0.05" stroke={col} strokeWidth="0.35" /><text x={z.polygon[0][0] + 1} y={z.polygon[0][1] - 1} fill={col} fontSize="2.6" fontWeight="700">{z.name.toUpperCase()}</text></g>;
      })}
      {mapFloor !== 1 && layout.floors.filter((f) => f.id === mapFloor && f.footprint).map((f) => (
        <polygon key={f.id} points={f.footprint!.map((p) => p.join(",")).join(" ")} fill="#14b8a6" fillOpacity="0.03" stroke="#14b8a6" strokeWidth="0.3" strokeDasharray="1.5 0.8" />
      ))}
      {layout.lifts.map((l) => (
        <g key={l.id}><rect x={l.cell[0] - 0.7} y={l.cell[1] - 0.7} width="2.4" height="2.4" fill="none" stroke="#a78bfa" strokeWidth="0.35" /><text x={l.cell[0] + 2} y={l.cell[1] + 0.6} fill="#a78bfa" fontSize="1.8">{l.id}</text></g>
      ))}
      {blocks.map(([c, r, len], i) => <rect key={i} x={c * grid.cols / grid.cols} y={r} width={len} height="1" fill="#334155" />)}
      {mapFloor === 1 && layout.conveyors.map((c) => <polyline key={c.id} points={c.path.map((p) => p.join(",")).join(" ")} fill="none" stroke="#22d3ee" strokeWidth="1" strokeOpacity="0.9" />)}
      {mapFloor === 1 && layout.docks.map((d) => <rect key={d.id} x={d.rect[0]} y={d.rect[1]} width={d.rect[2] - d.rect[0]} height={d.rect[3] - d.rect[1]} fill="none" stroke={d.kind === "INBOUND" ? "#22c55e" : "#22d3ee"} strokeWidth="0.3" strokeDasharray="1 0.6" />)}
      {mapFloor === 1 && layout.charging_stations.map((c) => <circle key={c.id} cx={c.position[0]} cy={c.position[2]} r="0.6" fill="#3b82f6" />)}
      {layout.cameras.filter((c) => (c.floor ?? 1) === mapFloor).map((c) => <rect key={c.id} x={c.position[0] - 0.5} y={c.position[2] - 0.5} width="1" height="1" fill="#facc15" />)}
      {Object.values(robots).map((r) => r.path.length > r.path_index && (
        <polyline key={"p" + r.id} points={[[r.position[0], r.position[2]], ...r.path.slice(r.path_index).map((c) => [c[0] + 0.5, c[1] + 0.5])].map((p) => p.join(",")).join(" ")} fill="none" stroke={r.id === selected ? "#fff" : "#22d3ee"} strokeWidth={r.id === selected ? 0.5 : 0.25} strokeOpacity={r.id === selected ? 1 : 0.5} strokeDasharray="1 0.6" />
      ))}
      {Object.values(robots).map((r) => {
        const sel = r.id === selected;
        return (
          <g key={r.id} transform={`translate(${r.position[0]},${r.position[2]})`} onClick={() => select(r.id)} style={{ cursor: "pointer" }}>
            {sel && <circle r="2.2" fill="none" stroke="#60a5fa" strokeWidth="0.3" />}
            <circle r="1" fill={STATUS_COLOR[r.status]} stroke="#05080f" strokeWidth="0.25" />
            <line x1="0" y1="0" x2={Math.cos(r.heading) * 1.6} y2={Math.sin(r.heading) * 1.6} stroke="#fff" strokeWidth="0.25" />
            <text x="1.4" y="-1" fill={sel ? "#fff" : "#cbd5e1"} fontSize="1.8" fontFamily="JetBrains Mono, monospace">{r.id}</text>
          </g>
        );
      })}
      {heat && (
        <g transform={`translate(${W - 22}, ${D - 3})`}>
          {Array.from({ length: 20 }, (_, i) => <rect key={i} x={i} y="0" width="1" height="1.2" fill={heatColor(i / 19)} />)}
          <text x="0" y="-0.6" fill="#8b98ad" fontSize="1.6">LOW</text><text x="20" y="-0.6" fill="#8b98ad" fontSize="1.6" textAnchor="end">HIGH</text>
          <text x="20" y="-3" fill="#cbd5e1" fontSize="1.7" textAnchor="end" fontWeight="600">{mode === "TRAFFIC" ? "LIVE ROBOT DENSITY" : "ACCUMULATED TRAFFIC"}</text>
        </g>
      )}
    </svg>
  );
}
