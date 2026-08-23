/**
 * Phase 8（規格書 §4/§5）：工業風夾層與貨梯。
 *  - 樓板 45 cm 厚、鋼構主梁/次梁、固定柱位（Layout Config 管理，不隨機）、黃黑警示邊、雙橫桿護欄 + toe board、電梯井道開口。
 *  - 貨梯：鋼井架 + 金屬網護罩 + 實體平台 + 滑動門 + 狀態燈/樓層指示。平台高度直接讀後端權威的 state.lifts[id].y，
 *    前端只做插值渲染（門開闔、平台位置），不自行決定電梯何時移動。
 */
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { layout, useStore } from "../../state/store";
import type { LiftState } from "../../schema/twin_state";

export const FLOOR_ELEV: Record<number, number> = Object.fromEntries((layout.floors ?? [{ id: 1, elevation: 0 }]).map((f) => [f.id, f.elevation]));

/** 支撐柱固定位置（規格書 §4.4：不得穿過走道/貨架/等待區；沿 footprint 內緣與中線） */
const COLUMNS: Array<[number, number]> = [
  [10, 41.5], [22, 41.5], [34, 41.5], [46, 41.5],
  [10, 60.5], [22, 60.5], [34, 60.5], [46, 60.5],
  [10, 51], [46, 51],
];

const SLAB_T = 0.45;           // 樓板厚度（§4.1：35–45 cm）
const SHAFT_HALF = 1.9;        // 井道開口半寬（z 方向）

export function Mezzanine({ lite = false }: { lite?: boolean }) {
  const f2 = layout.floors.find((f) => f.id === 2);
  if (!f2 || !f2.footprint) return null;
  const xs = f2.footprint.map((p) => p[0]), zs = f2.footprint.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const w = x1 - x0, d = z1 - z0, y = f2.elevation;
  const steel = <meshStandardMaterial color="#39404f" roughness={0.55} metalness={0.6} />;

  // 樓板：為電梯井道留開口 —— 東側條帶 (x1-4 .. x1) 依井道切成數段
  const lifts = layout.lifts ?? [];
  const shaftZs = lifts.map((l) => l.cell[1] + 0.5).sort((a, b) => a - b);
  const stripX = x1 - 4;
  const strips: Array<[number, number]> = [];
  let cur = z0;
  for (const sz of shaftZs) { if (sz - SHAFT_HALF > cur) strips.push([cur, sz - SHAFT_HALF]); cur = sz + SHAFT_HALF; }
  if (cur < z1) strips.push([cur, z1]);

  return (
    <group>
      {/* 主樓板（井道條帶以西） */}
      <mesh position={[x0 + (stripX - x0) / 2, y - SLAB_T / 2, z0 + d / 2]} receiveShadow>
        <boxGeometry args={[stripX - x0, SLAB_T, d]} />
        <meshStandardMaterial color="#242d3f" roughness={0.9} metalness={0.1} />
      </mesh>
      {/* 東側條帶（井道之間的樓板段） */}
      {strips.map(([za, zb], i) => (
        <mesh key={i} position={[stripX + (x1 - stripX) / 2, y - SLAB_T / 2, (za + zb) / 2]} receiveShadow>
          <boxGeometry args={[x1 - stripX, SLAB_T, zb - za]} />
          <meshStandardMaterial color="#242d3f" roughness={0.9} metalness={0.1} />
        </mesh>
      ))}
      {/* 鋼構主梁（x 向，樓板下） */}
      {[z0 + 2, z0 + d / 2, z1 - 2].map((z, i) => (
        <mesh key={"mb" + i} position={[x0 + w / 2, y - SLAB_T - 0.3, z]}>
          <boxGeometry args={[w, 0.6, 0.35]} />{steel}
        </mesh>
      ))}
      {/* 次梁（z 向） */}
      {Array.from({ length: Math.floor(w / 6) }, (_, i) => x0 + 3 + i * 6).map((x, i) => (
        <mesh key={"sb" + i} position={[x, y - SLAB_T - 0.22, z0 + d / 2]}>
          <boxGeometry args={[0.22, 0.45, d - 0.5]} />{steel}
        </mesh>
      ))}
      {/* 固定柱位 */}
      {COLUMNS.map(([x, z], i) => (
        <group key={"col" + i} position={[x, 0, z]}>
          <mesh position={[0, (y - SLAB_T) / 2, 0]} castShadow={!lite}>
            <boxGeometry args={[0.5, y - SLAB_T, 0.5]} />
            <meshStandardMaterial color="#2b3446" roughness={0.6} metalness={0.4} />
          </mesh>
          <mesh position={[0, 0.06, 0]}><boxGeometry args={[0.9, 0.12, 0.9]} />{steel}</mesh>
        </group>
      ))}
      {/* 邊緣：黃黑警示條 + 雙橫桿護欄 + toe board（東側電梯開口不放護欄） */}
      {([[x0 + w / 2, z0, w, 0, true], [x0 + w / 2, z1, w, 0, true], [x0, z0 + d / 2, d, 1, true]] as const).map(([cx, cz, len, rot, rail], i) => (
        <Edge key={i} cx={cx} cz={cz} len={len} rot={rot} y={y} rail={rail} />
      ))}
      {strips.map(([za, zb], i) => <Edge key={"e" + i} cx={x1} cz={(za + zb) / 2} len={zb - za} rot={1} y={y} rail />)}
      {/* 二樓照明 + 樓板下照明（§4.1） */}
      {!lite && <pointLight position={[x0 + w / 3, y + 5, z0 + d / 2]} intensity={0.7} color="#cfe0ff" distance={30} decay={1.5} />}
      {!lite && <pointLight position={[x0 + w / 2, y - 2.5, z0 + d / 2]} intensity={0.5} color="#93a6c9" distance={24} decay={1.5} />}
      {lifts.map((l) => <Lift key={l.id} l={l} elev={y} lite={lite} />)}
    </group>
  );
}

function Edge({ cx, cz, len, rot, y, rail }: { cx: number; cz: number; len: number; rot: 0 | 1; y: number; rail: boolean }) {
  return (
    <group position={[cx, y, cz]} rotation-y={rot ? Math.PI / 2 : 0}>
      <mesh position={[0, 0.02, 0]}><boxGeometry args={[len, 0.05, 0.3]} /><meshBasicMaterial color="#eab308" /></mesh>
      {rail && (
        <>
          {/* toe board（§4.2） */}
          <mesh position={[0, 0.1, 0]}><boxGeometry args={[len, 0.14, 0.04]} /><meshStandardMaterial color="#b45309" roughness={0.7} /></mesh>
          <mesh position={[0, 0.6, 0]}><boxGeometry args={[len, 0.05, 0.05]} /><meshStandardMaterial color="#64748b" metalness={0.6} roughness={0.4} /></mesh>
          <mesh position={[0, 1.1, 0]}><boxGeometry args={[len, 0.07, 0.07]} /><meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.4} /></mesh>
          {Array.from({ length: Math.max(2, Math.floor(len / 3)) }, (_, k) => (
            <mesh key={k} position={[-len / 2 + 0.5 + k * ((len - 1) / Math.max(1, Math.floor(len / 3) - 1)), 0.55, 0]}>
              <boxGeometry args={[0.06, 1.1, 0.06]} /><meshStandardMaterial color="#64748b" metalness={0.6} roughness={0.4} />
            </mesh>
          ))}
        </>
      )}
    </group>
  );
}

/** 電梯狀態 → 燈號顏色（規格書 §5.3） */
export const LIFT_LIGHT: Record<string, string> = {
  IDLE: "#22c55e", COOLDOWN: "#22c55e",
  MOVING_UP: "#3b82f6", MOVING_DOWN: "#3b82f6", LEVELING: "#3b82f6",
  DOOR_OPENING: "#22d3ee", DOOR_OPENING_AT_DESTINATION: "#22d3ee", BOARDING: "#22d3ee", ALIGHTING: "#22d3ee",
  DOOR_CLOSING: "#f59e0b", DOOR_CLOSING_AFTER_EXIT: "#f59e0b",
  FAULT: "#ef4444",
};

export function liftLabel(L: LiftState | undefined): string {
  if (!L) return "";
  if (L.fault) return "FAULT";
  if (L.state === "MOVING_UP" || L.state === "MOVING_DOWN") return `F${L.state === "MOVING_UP" ? "1 → F2" : "2 → F1"} · ${L.occupant ?? "empty"}`;
  const q = (L.queue["1"]?.length ?? 0) + (L.queue["2"]?.length ?? 0);
  if (L.state === "IDLE") return `IDLE AT F${L.floor}${q ? ` · QUEUE ${q}` : ""}`;
  return `${L.state.replace(/_/g, " ")}${L.occupant ? ` · ${L.occupant}` : ""}`;
}

/** 貨梯（補強規格書）：VRC 風格 —— 鋼構 carriage、雙導軌、頂置驅動箱、全高金屬網圍籬、
 *  每層雙開式連鎖安全門、門框指示燈組、防滑鋼板平台（黃黑邊、docking marker、bumper）、門檻與 leveling 指示。
 *  透明青色只作為 Digital Twin occupancy overlay，不充當平台本體。 */
function Lift({ l, elev, lite }: { l: (typeof layout.lifts)[number]; elev: number; lite: boolean }) {
  const platRef = useRef<THREE.Group>(null!);
  const leafRefs = useRef<Array<THREE.Mesh | null>>([null, null, null, null]);   // [f1L, f1R, f2L, f2R]
  const lightRef = useRef<THREE.MeshBasicMaterial>(null!);
  const levelF1 = useRef<THREE.MeshBasicMaterial>(null!);
  const levelF2 = useRef<THREE.MeshBasicMaterial>(null!);
  const occRef = useRef<THREE.Mesh>(null!);
  const selectLift = useStore((s) => s.selectLift);
  const x = l.cell[0] + 0.5, z = l.cell[1] + 0.5;
  const W = 2.8, D = 3.6, H = elev + 2.4;   // §5.4
  const LEAF = 1.12;                          // 雙開門單片寬
  const steel = <meshStandardMaterial color="#2f3542" roughness={0.5} metalness={0.7} />;
  const frame = <meshStandardMaterial color="#171c26" roughness={0.45} metalness={0.75} />;

  useFrame((state, dt) => {
    const L = useStore.getState().twin.lifts[l.id];
    if (!L) return;
    const k = 1 - Math.pow(0.02, dt);
    if (platRef.current) platRef.current.position.y += (L.y - platRef.current.position.y) * k;
    // 雙開式安全門：開 = 兩片各滑向 ±z
    const setLeaf = (idx: number, open: boolean, sign: number) => {
      const m = leafRefs.current[idx]; if (!m) return;
      const base = sign * LEAF / 2;
      m.position.z += ((open ? base + sign * LEAF : base) - m.position.z) * k;
    };
    setLeaf(0, L.door_f1 === "OPEN", -1); setLeaf(1, L.door_f1 === "OPEN", +1);
    setLeaf(2, L.door_f2 === "OPEN", -1); setLeaf(3, L.door_f2 === "OPEN", +1);
    if (lightRef.current) {
      const c = L.fault ? "#ef4444" : LIFT_LIGHT[L.state] ?? "#22c55e";
      lightRef.current.color.set(c);
      lightRef.current.opacity = L.fault ? 0.5 + Math.sin(state.clock.elapsedTime * 8) * 0.5 : 1;
    }
    // Leveling indicator（補強 §6）：平台與該層對齊時亮綠
    if (levelF1.current) levelF1.current.color.set(Math.abs(L.y - 0) < 0.05 ? "#22c55e" : "#334155");
    if (levelF2.current) levelF2.current.color.set(Math.abs(L.y - elev) < 0.05 ? "#22c55e" : "#334155");
    if (occRef.current) occRef.current.visible = !!L.occupant;
  });

  const L = useStore((s) => s.twin.lifts[l.id]);
  return (
    <group position={[x, 0, z]} onClick={(e) => { e.stopPropagation(); selectLift(l.id); }}
      onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
      {/* ── 井道鋼框（黑）＋四角柱 ── */}
      {[[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]].map(([dx, dz], i) => (
        <mesh key={i} position={[dx, H / 2, dz]} castShadow={!lite}><boxGeometry args={[0.24, H, 0.24]} />{frame}</mesh>
      ))}
      {/* 水平框樑（底/中/樓板高/頂） */}
      {[0.05, elev / 2, elev, H - 0.3].map((hy, i) => (
        <group key={"h" + i}>
          <mesh position={[W / 2, hy, 0]}><boxGeometry args={[0.12, 0.12, D]} />{frame}</mesh>
          <mesh position={[0, hy, -D / 2]}><boxGeometry args={[W, 0.12, 0.12]} />{frame}</mesh>
          <mesh position={[0, hy, D / 2]}><boxGeometry args={[W, 0.12, 0.12]} />{frame}</mesh>
        </group>
      ))}
      {/* ── 全高金屬網護罩（東/北/南；西面為門） ── */}
      {([[W / 2 - 0.02, 0, Math.PI / 2, D - 0.2], [0, -D / 2 + 0.02, 0, W - 0.2], [0, D / 2 - 0.02, 0, W - 0.2]] as const).map(([dx, dz, rot, len], i) => (
        <mesh key={"mesh" + i} position={[dx, H / 2 - 0.15, dz]} rotation-y={rot}>
          <planeGeometry args={[len, H - 0.5, Math.round(len * 3), Math.round((H - 0.5) * 2)]} />
          <meshStandardMaterial color="#59a0b8" transparent opacity={0.35} side={THREE.DoubleSide} metalness={0.4} roughness={0.5} wireframe />
        </mesh>
      ))}
      {/* 維修門（東面下方，帶框） */}
      <group position={[W / 2 - 0.01, 1.0, D / 2 - 0.9]}>
        <mesh rotation-y={Math.PI / 2}><planeGeometry args={[0.9, 1.9]} /><meshStandardMaterial color="#22303f" transparent opacity={0.85} side={THREE.DoubleSide} /></mesh>
        <mesh position={[0.02, 0, 0]} rotation-y={Math.PI / 2}><ringGeometry args={[0.05, 0.08, 8]} /><meshBasicMaterial color="#eab308" /></mesh>
      </group>
      {/* ── 雙導軌 + 導輪 + 鏈條（VRC 驅動結構） ── */}
      {[-W / 2 + 0.2, W / 2 - 0.2].map((dx, i) => (
        <group key={"rail" + i}>
          <mesh position={[dx, H / 2, D / 2 - 0.22]}><boxGeometry args={[0.1, H, 0.16]} /><meshStandardMaterial color="#454f61" metalness={0.85} roughness={0.25} /></mesh>
        </group>
      ))}
      <mesh position={[0, H / 2, D / 2 - 0.3]}><cylinderGeometry args={[0.03, 0.03, H - 0.6, 6]} /><meshStandardMaterial color="#0d1118" metalness={0.7} roughness={0.4} /></mesh>
      {/* ── 平台（防滑鋼板 carriage）── */}
      <group ref={platRef} position={[0, 0, 0]}>
        {/* 甲板 */}
        <mesh position={[0, 0.14, 0]} castShadow={!lite}><boxGeometry args={[W - 0.5, 0.1, D - 0.5]} /><meshStandardMaterial color="#3d4657" roughness={0.85} metalness={0.35} /></mesh>
        {/* 甲板下結構梁 */}
        <mesh position={[0, 0.05, 0]}><boxGeometry args={[W - 0.7, 0.08, 0.3]} />{steel}</mesh>
        <mesh position={[0, 0.05, -1.0]}><boxGeometry args={[W - 0.7, 0.08, 0.25]} />{steel}</mesh>
        <mesh position={[0, 0.05, 1.0]}><boxGeometry args={[W - 0.7, 0.08, 0.25]} />{steel}</mesh>
        {/* 黃黑安全邊 */}
        {[-1, 1].map((sx, i) => <mesh key={"ex" + i} position={[sx * (W - 0.55) / 2, 0.2, 0]}><boxGeometry args={[0.12, 0.03, D - 0.5]} /><meshBasicMaterial color="#eab308" /></mesh>)}
        {[-1, 1].map((sz, i) => <mesh key={"ez" + i} position={[0, 0.2, sz * (D - 0.55) / 2]}><boxGeometry args={[W - 0.5, 0.03, 0.12]} /><meshBasicMaterial color="#eab308" /></mesh>)}
        {/* Docking marker（青色角括號，佔用時整片 overlay 亮起 = Digital Twin occupancy） */}
        {[[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]].map(([mx, mz], i) => (
          <mesh key={"dm" + i} position={[mx, 0.2, mz]} rotation-x={-Math.PI / 2}><planeGeometry args={[0.3, 0.06]} /><meshBasicMaterial color="#22d3ee" transparent opacity={0.8} /></mesh>
        ))}
        <mesh ref={occRef} position={[0, 0.21, 0]} rotation-x={-Math.PI / 2} visible={false}>
          <planeGeometry args={[1.5, 1.5]} /><meshBasicMaterial color="#22d3ee" transparent opacity={0.12} />
        </mesh>
        {/* 輪擋 bumper（±x 端） */}
        {[-1, 1].map((sx, i) => <mesh key={"b" + i} position={[sx * (W - 0.8) / 2, 0.26, 0]}><boxGeometry args={[0.06, 0.1, D - 0.9]} /><meshStandardMaterial color="#b45309" roughness={0.6} /></mesh>)}
        {/* carriage 托架 → 導軌 */}
        {[-W / 2 + 0.2, W / 2 - 0.2].map((dx, i) => (
          <mesh key={"c" + i} position={[dx * 0.82, 0.3, D / 2 - 0.45]}><boxGeometry args={[0.35, 0.5, 0.3]} />{steel}</mesh>
        ))}
      </group>
      {/* ── 每層雙開式安全門（西面）＋門框、門檻、指示燈組 ── */}
      {[0, elev].map((fy, fi) => (
        <group key={"door" + fi} position={[-W / 2, fy, 0]}>
          {/* 門框 */}
          <mesh position={[0, 1.15, -LEAF - 0.12]}><boxGeometry args={[0.18, 2.3, 0.14]} />{frame}</mesh>
          <mesh position={[0, 1.15, LEAF + 0.12]}><boxGeometry args={[0.18, 2.3, 0.14]} />{frame}</mesh>
          <mesh position={[0, 2.36, 0]}><boxGeometry args={[0.18, 0.16, 2.6]} />{frame}</mesh>
          {/* 門檻 sill（補強 §6） */}
          <mesh position={[-0.15, 0.015, 0]}><boxGeometry args={[0.5, 0.03, 2.3]} /><meshStandardMaterial color="#556174" metalness={0.7} roughness={0.35} /></mesh>
          {/* Door zone 黃黑地面標線 */}
          <mesh position={[-0.85, fy === 0 ? 0.015 : 0.02, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[1.1, 2.4]} /><meshBasicMaterial color="#eab308" transparent opacity={0.18} /></mesh>
          {/* 指示燈柱：樓層燈 / 狀態燈 / interlock / e-stop */}
          <group position={[0, 0, -LEAF - 0.35]}>
            <mesh position={[0, 1.2, 0]}><boxGeometry args={[0.12, 0.9, 0.18]} /><meshStandardMaterial color="#1c232f" roughness={0.5} /></mesh>
            <mesh position={[-0.02, 1.5, 0]}><boxGeometry args={[0.1, 0.12, 0.12]} /><meshBasicMaterial ref={fi === 0 ? levelF1 : levelF2} color="#334155" /></mesh>
            <mesh position={[-0.02, 1.3, 0]}><boxGeometry args={[0.1, 0.12, 0.12]} /><meshBasicMaterial ref={fi === 0 ? lightRef : undefined} color="#22c55e" transparent /></mesh>
            <mesh position={[-0.02, 1.05, 0]}><cylinderGeometry args={[0.05, 0.05, 0.05, 10]} /><meshBasicMaterial color="#dc2626" /></mesh>
          </group>
          {/* 雙開門片 */}
          <mesh ref={(m) => { leafRefs.current[fi * 2] = m; }} position={[0, 1.12, -LEAF / 2]}>
            <boxGeometry args={[0.07, 2.2, LEAF]} />
            <meshStandardMaterial color="#4a5364" transparent opacity={0.8} metalness={0.6} roughness={0.35} />
          </mesh>
          <mesh ref={(m) => { leafRefs.current[fi * 2 + 1] = m; }} position={[0, 1.12, LEAF / 2]}>
            <boxGeometry args={[0.07, 2.2, LEAF]} />
            <meshStandardMaterial color="#4a5364" transparent opacity={0.8} metalness={0.6} roughness={0.35} />
          </mesh>
        </group>
      ))}
      {/* ── 頂置驅動箱（縮小：Motor–Brake–Gearbox）── */}
      <group position={[0, H + 0.35, D / 2 - 0.5]}>
        <mesh castShadow={!lite}><boxGeometry args={[1.3, 0.7, 0.9]} /><meshStandardMaterial color="#232a37" roughness={0.5} metalness={0.6} /></mesh>
        {/* 散熱縫 */}
        {[-0.3, 0, 0.3].map((dz, i) => <mesh key={i} position={[0.66, 0, dz * 0.9]}><boxGeometry args={[0.02, 0.4, 0.06]} /><meshBasicMaterial color="#0b0f16" /></mesh>)}
        {/* 驅動狀態 LED + 警示 */}
        <mesh position={[-0.55, 0.15, 0.46]}><sphereGeometry args={[0.06, 8, 8]} /><meshBasicMaterial color="#22c55e" /></mesh>
        <mesh position={[0, 0.15, 0.46]} rotation-x={0}><planeGeometry args={[0.3, 0.26]} /><meshBasicMaterial color="#eab308" /></mesh>
      </group>
      {!lite && (
        <Html position={[0, H + 1.3, 0]} zIndexRange={[9, 0]} center>
          <div className="lift-lbl" onClick={(e) => { e.stopPropagation(); selectLift(l.id); }}>
            <b>{l.id}</b><span>{liftLabel(L)}</span>
            <span className="lift-sign">AUTOMATED MATERIAL LIFT · AMR ONLY · CAP 1</span>
          </div>
        </Html>
      )}
    </group>
  );
}
