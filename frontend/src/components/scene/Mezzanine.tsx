/**
 * Phase 8：二樓夾層 — 樓板、邊緣護欄、支撐柱，以及兩座貨梯（井架 + 會跟著機器人升降的平台）。
 * 樓板頂面 = layout.floors[2].elevation；機器人 position.y 恆為 0，由 Robots.tsx 加上樓層高度。
 */
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { layout, useStore } from "../../state/store";

export const FLOOR_ELEV: Record<number, number> = Object.fromEntries((layout.floors ?? [{ id: 1, elevation: 0 }]).map((f) => [f.id, f.elevation]));

export function Mezzanine({ lite = false }: { lite?: boolean }) {
  const f2 = layout.floors.find((f) => f.id === 2);
  if (!f2 || !f2.footprint) return null;
  const xs = f2.footprint.map((p) => p[0]), zs = f2.footprint.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const w = x1 - x0, d = z1 - z0, y = f2.elevation;
  const cols: Array<[number, number]> = [];
  for (let x = x0 + 2; x <= x1 - 2; x += 10) for (const z of [z0 + 2, z1 - 2]) cols.push([x, z]);
  return (
    <group>
      {/* 樓板（頂面在 y = elevation） */}
      <mesh position={[x0 + w / 2, y - 0.25, z0 + d / 2]} receiveShadow>
        <boxGeometry args={[w, 0.5, d]} />
        <meshStandardMaterial color="#1b2436" roughness={0.85} metalness={0.15} />
      </mesh>
      {/* 樓板邊緣黃黑條 + 護欄 */}
      {([[x0 + w / 2, z0, w, 0], [x0 + w / 2, z1, w, 0], [x0, z0 + d / 2, d, 1], [x1, z0 + d / 2, d, 1]] as const).map(([cx, cz, len, rot], i) => (
        <group key={i} position={[cx, y, cz]} rotation-y={rot ? Math.PI / 2 : 0}>
          <mesh position={[0, 0.02, 0]}><boxGeometry args={[len, 0.06, 0.25]} /><meshBasicMaterial color="#eab308" /></mesh>
          <mesh position={[0, 0.6, 0]}><boxGeometry args={[len, 0.05, 0.05]} /><meshStandardMaterial color="#64748b" metalness={0.6} roughness={0.4} /></mesh>
          <mesh position={[0, 1.1, 0]}><boxGeometry args={[len, 0.06, 0.06]} /><meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.4} /></mesh>
        </group>
      ))}
      {/* 支撐柱 */}
      {cols.map(([x, z], i) => (
        <mesh key={i} position={[x, (y - 0.5) / 2, z]} castShadow={!lite}>
          <boxGeometry args={[0.45, y - 0.5, 0.45]} />
          <meshStandardMaterial color="#26314a" roughness={0.7} metalness={0.3} />
        </mesh>
      ))}
      {(layout.lifts ?? []).map((l) => <Lift key={l.id} l={l} elev={y} lite={lite} />)}
    </group>
  );
}

/** 貨梯：井架 + 平台。有機器人搭乘時平台跟著它的視覺高度移動（Robots.tsx 用同樣的緩動速率）。 */
function Lift({ l, elev, lite }: { l: (typeof layout.lifts)[number]; elev: number; lite: boolean }) {
  const platRef = useRef<THREE.Mesh>(null!);
  const x = l.cell[0] + 0.5, z = l.cell[1] + 0.5;
  useFrame((_, dt) => {
    const robots = useStore.getState().twin.robots;
    const rider = Object.values(robots).find((r) => r.lift_id === l.id);
    const targetY = rider ? (rider.floor === 1 ? elev : 0) + 0.06 : 0.06;   // 搭乘中 → 往目的樓層走；空車停一樓
    if (platRef.current) { const k = 1 - Math.pow(0.25, dt); platRef.current.position.y += (targetY - platRef.current.position.y) * k; }
  });
  return (
    <group position={[x, 0, z]}>
      {/* 井架四柱 + 頂樑 */}
      {[[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]].map(([dx, dz], i) => (
        <mesh key={i} position={[dx, (elev + 1.6) / 2, dz]}>
          <boxGeometry args={[0.18, elev + 1.6, 0.18]} />
          <meshStandardMaterial color="#7c6df2" roughness={0.5} metalness={0.5} />
        </mesh>
      ))}
      <mesh position={[0, elev + 1.7, 0]}><boxGeometry args={[2.4, 0.2, 2.4]} /><meshStandardMaterial color="#4c3fd6" roughness={0.5} metalness={0.5} /></mesh>
      {/* 平台 */}
      <mesh ref={platRef} position={[0, 0.06, 0]} castShadow={!lite}>
        <boxGeometry args={[2.0, 0.12, 2.0]} />
        <meshStandardMaterial color="#332a80" roughness={0.6} metalness={0.4} emissive="#4c3fd6" emissiveIntensity={0.25} />
      </mesh>
      {!lite && (
        <Html position={[0, elev + 2.3, 0]} zIndexRange={[9, 0]} center>
          <div className="lbl" style={{ borderColor: "#7c6df2", color: "#c7d2fe" }}>{l.id}</div>
        </Html>
      )}
    </group>
  );
}
