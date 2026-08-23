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

/** 貨梯（§5）：鋼井架 + 網狀護罩 + 平台（跟隨後端 y）+ 兩層滑動門 + 狀態燈 + 指示標籤 */
function Lift({ l, elev, lite }: { l: (typeof layout.lifts)[number]; elev: number; lite: boolean }) {
  const platRef = useRef<THREE.Group>(null!);
  const gateF1 = useRef<THREE.Mesh>(null!);
  const gateF2 = useRef<THREE.Mesh>(null!);
  const lightRef = useRef<THREE.MeshBasicMaterial>(null!);
  const selectLift = useStore((s) => s.selectLift);
  const x = l.cell[0] + 0.5, z = l.cell[1] + 0.5;
  const W = 2.8, D = 3.6, H = elev + 2.6;   // §5.4 轎廂尺寸
  const graphite = <meshStandardMaterial color="#3a4150" roughness={0.5} metalness={0.65} />;

  useFrame((state, dt) => {
    const L = useStore.getState().twin.lifts[l.id];
    if (!L) return;
    const k = 1 - Math.pow(0.02, dt);
    if (platRef.current) platRef.current.position.y += (L.y + 0.08 - platRef.current.position.y) * k;
    // 滑動門：開 = 門片滑向 -z
    const slide = (gate: THREE.Mesh | null, open: boolean) => { if (gate) gate.position.z += ((open ? -1.4 : 0) - gate.position.z) * k; };
    slide(gateF1.current, L.door_f1 === "OPEN");
    slide(gateF2.current, L.door_f2 === "OPEN");
    if (lightRef.current) {
      const c = L.fault ? "#ef4444" : LIFT_LIGHT[L.state] ?? "#22c55e";
      lightRef.current.color.set(c);
      lightRef.current.opacity = L.fault ? 0.5 + Math.sin(state.clock.elapsedTime * 8) * 0.5 : 1;
    }
  });

  const L = useStore((s) => s.twin.lifts[l.id]);
  return (
    <group position={[x, 0, z]} onClick={(e) => { e.stopPropagation(); selectLift(l.id); }}
      onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
      {/* 井架四角柱 + 頂部橫樑 */}
      {[[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]].map(([dx, dz], i) => (
        <mesh key={i} position={[dx, H / 2, dz]} castShadow={!lite}><boxGeometry args={[0.22, H, 0.22]} />{graphite}</mesh>
      ))}
      <mesh position={[0, H, 0]}><boxGeometry args={[W + 0.3, 0.3, D + 0.3]} />{graphite}</mesh>
      {/* 導軌 + 纜線（§5.2 視覺細節） */}
      {[-W / 2 + 0.15, W / 2 - 0.15].map((dx, i) => (
        <mesh key={"r" + i} position={[dx, H / 2, 0]}><boxGeometry args={[0.06, H, 0.1]} /><meshStandardMaterial color="#1f2733" metalness={0.8} roughness={0.3} /></mesh>
      ))}
      <mesh position={[0, H / 2, D / 2 - 0.1]}><cylinderGeometry args={[0.025, 0.025, H, 6]} /><meshStandardMaterial color="#0f141d" /></mesh>
      {/* 金屬網護罩（東、北、南三面；西面是出入口） */}
      {([[W / 2, 0, Math.PI / 2, D], [0, -D / 2, 0, W], [0, D / 2, 0, W]] as const).map(([dx, dz, rot, len], i) => (
        <mesh key={"mesh" + i} position={[dx, H / 2 - 0.15, dz]} rotation-y={rot}>
          <planeGeometry args={[len, H - 0.3]} />
          <meshStandardMaterial color="#6c7686" transparent opacity={0.22} side={THREE.DoubleSide} metalness={0.5} roughness={0.4} wireframe />
        </mesh>
      ))}
      {/* 平台（跟隨後端 y；機器人由 Robots.tsx 以同一來源同步） */}
      <group ref={platRef} position={[0, 0.08, 0]}>
        <mesh castShadow={!lite}><boxGeometry args={[W - 0.35, 0.25, D - 0.35]} /><meshStandardMaterial color="#2d3444" roughness={0.6} metalness={0.5} /></mesh>
        {/* 平台黃色安全邊 */}
        {[[-1, 0], [1, 0]].map(([sx], i) => (
          <mesh key={i} position={[sx * (W - 0.4) / 2, 0.13, 0]}><boxGeometry args={[0.1, 0.03, D - 0.4]} /><meshBasicMaterial color="#eab308" /></mesh>
        ))}
      </group>
      {/* 滑動門（西面出入口）：F1 / F2 各一片 */}
      <mesh ref={gateF1} position={[-W / 2, 1.15, 0]}>
        <boxGeometry args={[0.08, 2.1, 2.2]} />
        <meshStandardMaterial color="#4a5364" transparent opacity={0.75} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh ref={gateF2} position={[-W / 2, elev + 1.15, 0]}>
        <boxGeometry args={[0.08, 2.1, 2.2]} />
        <meshStandardMaterial color="#4a5364" transparent opacity={0.75} metalness={0.6} roughness={0.35} />
      </mesh>
      {/* 等待區黃黑斜線（§4.3） */}
      <mesh position={[-W / 2 - 1.2, 0.02, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[2.2, 3]} /><meshBasicMaterial color="#eab308" transparent opacity={0.12} /></mesh>
      {/* 狀態燈 + 樓層指示 */}
      <mesh position={[-W / 2 - 0.05, 2.6, -D / 2 + 0.3]}>
        <sphereGeometry args={[0.12, 10, 10]} />
        <meshBasicMaterial ref={lightRef} color="#22c55e" transparent />
      </mesh>
      {!lite && (
        <Html position={[0, H + 0.7, 0]} zIndexRange={[9, 0]} center>
          <div className="lift-lbl" onClick={(e) => { e.stopPropagation(); selectLift(l.id); }}>
            <b>{l.id}</b><span>{liftLabel(L)}</span>
          </div>
        </Html>
      )}
    </group>
  );
}
