import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { layout, useStore } from "../../state/store";
import type { LayoutConveyor } from "../../layout/types";

/** 輸送帶：沿 path 擠出，RUNNING 時包裹沿帶面移動（速度 = 模擬的 speed_mps × 播放倍速），ERROR 紅色閃爍、包裹停住 */
function Conveyor({ c }: { c: LayoutConveyor }) {
  const status = useStore((s) => s.twin.conveyors[c.id]?.status ?? "RUNNING");
  const beltSpeed = useStore((s) => s.twin.conveyors[c.id]?.speed_mps ?? c.speed_mps);
  const matRef = useRef<THREE.MeshStandardMaterial>(null!);
  const parcelsRef = useRef<THREE.Group>(null!);

  // 折線參數化：總長與各段起點，讓包裹能沿整條 path 移動（含轉角）
  const segsGeo: Array<{ ax: number; az: number; ang: number; len: number; start: number }> = [];
  let total = 0;
  for (let i = 0; i < c.path.length - 1; i++) {
    const [ax, az] = c.path[i], [bx, bz] = c.path[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    segsGeo.push({ ax, az, ang: Math.atan2(bz - az, bx - ax), len, start: total });
    total += len;
  }
  const pointAt = (d: number): [number, number, number] => {
    d = ((d % total) + total) % total;
    const seg = segsGeo.find((g) => d >= g.start && d <= g.start + g.len) ?? segsGeo[segsGeo.length - 1];
    const t = d - seg.start;
    return [seg.ax + Math.cos(seg.ang) * t, 1.15, seg.az + Math.sin(seg.ang) * t];
  };
  const N_PARCELS = Math.max(2, Math.floor(total / 5));
  const offsets = useRef<number[]>(Array.from({ length: N_PARCELS }, (_, k) => (k * total) / N_PARCELS));

  useFrame(({ clock }, dt) => {
    if (status === "ERROR" && matRef.current) matRef.current.emissiveIntensity = 0.4 + Math.sin(clock.elapsedTime * 6) * 0.35;
    const st = useStore.getState();
    const v = status === "RUNNING" && !st.paused ? beltSpeed * st.speed : 0;
    const g = parcelsRef.current; if (!g) return;
    for (let k = 0; k < g.children.length; k++) {
      if (v > 0) offsets.current[k] = (offsets.current[k] + v * dt) % total;
      const [x, y, z] = pointAt(offsets.current[k]);
      g.children[k].position.set(x, y, z);
    }
  });

  const segs = [] as JSX.Element[];
  for (let i = 0; i < segsGeo.length; i++) {
    const gseg = segsGeo[i]; const len = gseg.len;
    const [ax, az] = c.path[i], [bx, bz] = c.path[i + 1];
    segs.push(
      <group key={i} position={[(ax + bx) / 2, 0, (az + bz) / 2]} rotation-y={-gseg.ang}>
        {/* 帶面 */}
        <mesh position={[0, 0.8, 0]} castShadow receiveShadow>
          <boxGeometry args={[len, 0.12, c.width]} />
          <meshStandardMaterial ref={i === 0 ? matRef : undefined} color={status === "ERROR" ? "#7f1d1d" : "#1f2937"} roughness={0.7} metalness={0.3} emissive={status === "ERROR" ? "#ef4444" : "#000"} emissiveIntensity={0.6} />
        </mesh>
        {/* 側框 */}
        {[-1, 1].map((s) => (
          <mesh key={s} position={[0, 0.75, (s * (c.width + 0.12)) / 2]}>
            <boxGeometry args={[len, 0.3, 0.1]} />
            <meshStandardMaterial color="#4b5563" metalness={0.7} roughness={0.4} />
          </mesh>
        ))}
        {/* 腳架 */}
        {Array.from({ length: Math.max(2, Math.floor(len / 3)) }, (_, k) => (
          <mesh key={k} position={[-len / 2 + 1 + k * ((len - 2) / Math.max(1, Math.floor(len / 3) - 1)), 0.37, 0]}>
            <boxGeometry args={[0.12, 0.74, c.width]} />
            <meshStandardMaterial color="#374151" metalness={0.6} roughness={0.5} />
          </mesh>
        ))}
        {/* 狀態燈條 */}
        <mesh position={[0, 0.92, 0]}>
          <boxGeometry args={[len, 0.02, 0.05]} />
          <meshBasicMaterial color={status === "RUNNING" ? "#22d3ee" : status === "ERROR" ? "#ef4444" : "#eab308"} />
        </mesh>
      </group>,
    );
  }
  // 包裹放在世界座標的群組裡（不隨段旋轉），每 frame 沿折線推進
  const parcels = (
    <group ref={parcelsRef}>
      {Array.from({ length: N_PARCELS }, (_, k) => (
        <mesh key={k} castShadow>
          <boxGeometry args={[0.7, 0.5, 0.6]} />
          <meshStandardMaterial color={k % 3 === 0 ? "#b98a5e" : "#c49a6c"} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
  // round-9e：兩端設備 —— 起點進料斗、終點接收機台（包裹不再看起來掉到地上）
  const p0 = c.path[0], pN = c.path[c.path.length - 1];
  const endEquip = (
    <group>
      <group position={[p0[0], 0, p0[1]]}>
        <mesh position={[0, 0.75, 0]} castShadow><boxGeometry args={[1.6, 1.5, 1.6]} /><meshStandardMaterial color="#39424f" metalness={0.5} roughness={0.5} /></mesh>
        <mesh position={[0, 1.62, 0]}><boxGeometry args={[1.9, 0.28, 1.9]} /><meshStandardMaterial color="#2a323d" metalness={0.6} roughness={0.4} /></mesh>
      </group>
      <group position={[pN[0], 0, pN[1]]}>
        <mesh position={[0, 0.45, 0]} castShadow><boxGeometry args={[1.7, 0.9, 1.7]} /><meshStandardMaterial color="#39424f" metalness={0.5} roughness={0.5} /></mesh>
        <mesh position={[0, 0.95, 0]} rotation-x={0.35}><boxGeometry args={[1.5, 0.08, 1.3]} /><meshStandardMaterial color="#4a5568" metalness={0.6} roughness={0.35} /></mesh>
        <mesh position={[0, 1.1, 0]}><boxGeometry args={[0.25, 0.5, 0.25]} /><meshStandardMaterial color="#22303f" /></mesh>
        <mesh position={[0, 1.4, 0]}><sphereGeometry args={[0.08, 8, 8]} /><meshBasicMaterial color="#22c55e" /></mesh>
      </group>
    </group>
  );
  return <group>{segs}{parcels}{endEquip}</group>;
}

/** 工作站、充電樁、停車區、限制區、人行道、感測器 */
export function Fixtures({ lite = false }: { lite?: boolean }) {
  const robots = useStore((s) => s.twin.robots);
  return (
    <group>
      {layout.conveyors.map((c) => <Conveyor key={c.id} c={c} />)}

      {layout.stations.map((s) => {
        const [x0, z0, x1, z1] = s.rect; const w = x1 - x0, d = z1 - z0;
        return (
          <group key={s.id} position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}>
            <mesh position={[0, 0.005, 0]} rotation-x={-Math.PI / 2}>
              <planeGeometry args={[w, d]} />
              <meshBasicMaterial color={s.kind === "PACKING" ? "#1e3a5f" : "#3b2a5f"} transparent opacity={0.35} />
            </mesh>
            {/* 工作台 */}
            {Array.from({ length: Math.floor(w / 4) }, (_, i) => (
              <group key={i} position={[-w / 2 + 2 + i * 4, 0, 0]}>
                <mesh position={[0, 0.45, 0]} castShadow><boxGeometry args={[2.4, 0.9, 1.2]} /><meshStandardMaterial color="#334155" metalness={0.4} roughness={0.6} /></mesh>
                <mesh position={[0, 1.15, 0]}><boxGeometry args={[0.8, 0.5, 0.7]} /><meshStandardMaterial color="#c49a6c" /></mesh>
                {/* 機械手臂 (Packing) */}
                {s.kind === "PACKING" && i % 2 === 0 && (
                  <group position={[1.6, 0, 0]}>
                    <mesh position={[0, 0.3, 0]}><cylinderGeometry args={[0.35, 0.45, 0.6, 16]} /><meshStandardMaterial color="#1f2937" metalness={0.7} roughness={0.3} /></mesh>
                    <mesh position={[0, 1.2, 0]} rotation-z={0.35}><boxGeometry args={[0.3, 1.8, 0.3]} /><meshStandardMaterial color="#e5e7eb" metalness={0.5} roughness={0.3} /></mesh>
                    <mesh position={[-0.5, 2.1, 0]} rotation-z={-0.9}><boxGeometry args={[0.25, 1.5, 0.25]} /><meshStandardMaterial color="#e5e7eb" metalness={0.5} roughness={0.3} /></mesh>
                  </group>
                )}
              </group>
            ))}
            {!lite && <Html position={[0, 0.1, d / 2 + 1]} center zIndexRange={[2, 0]} style={{ pointerEvents: "none" }}>
              <div className="sign-lbl" style={{ color: s.kind === "PACKING" ? "#93c5fd" : "#d8b4fe", borderColor: s.kind === "PACKING" ? "#1d4ed8" : "#7e22ce" }}>{s.kind}</div>
            </Html>}
          </group>
        );
      })}

      {layout.charging_stations.map((c) => {
        const occupied = Object.values(robots).some((r) => r.status === "CHARGING" && Math.abs(r.position[0] - c.position[0]) < 1);
        return (
          <group key={c.id} position={[c.position[0], 0, c.position[2]]}>
            <mesh position={[0, 0.6, 0]} castShadow><boxGeometry args={[0.8, 1.2, 0.4]} /><meshStandardMaterial color="#1f2937" metalness={0.6} roughness={0.4} /></mesh>
            <mesh position={[0, 0.9, 0.21]}><planeGeometry args={[0.5, 0.25]} /><meshBasicMaterial color={occupied ? "#3b82f6" : "#22c55e"} /></mesh>
            <mesh position={[0, 0.01, -1.9]} rotation-x={-Math.PI / 2}><planeGeometry args={[1.6, 1.6]} /><meshBasicMaterial color="#1d4ed8" transparent opacity={0.25} /></mesh>
            {occupied && <pointLight position={[0, 1, -1.9]} color="#3b82f6" intensity={lite ? 0 : 3} distance={4} />}
          </group>
        );
      })}

      {layout.parking.map((p) => {
        const [x0, z0, x1, z1] = p.rect;
        return (
          <mesh key={p.id} position={[(x0 + x1) / 2, 0.005, (z0 + z1) / 2]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[x1 - x0, z1 - z0]} />
            <meshBasicMaterial color="#334155" transparent opacity={0.25} />
          </mesh>
        );
      })}

      {layout.restricted_areas.map((r) => {
        const [x0, z0, x1, z1] = r.rect;
        return (
          <group key={r.id} position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}>
            <mesh position={[0, 0.006, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[x1 - x0, z1 - z0]} /><meshBasicMaterial color="#7f1d1d" transparent opacity={0.18} /></mesh>
            <lineSegments position={[0, 0.02, 0]}>
              <edgesGeometry args={[new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2)]} />
              <lineBasicMaterial color="#ef4444" />
            </lineSegments>
          </group>
        );
      })}

      {layout.walkways.map((w) => {
        const xs = w.polygon.map((p) => p[0]), zs = w.polygon.map((p) => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
        return (
          <mesh key={w.id} position={[(x0 + x1) / 2, 0.004, (z0 + z1) / 2]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[x1 - x0, z1 - z0]} />
            <meshBasicMaterial color="#facc15" transparent opacity={0.06} />
          </mesh>
        );
      })}

      {!lite && layout.sensors.map((s) => (
        <mesh key={s.id} position={s.position}>
          <sphereGeometry args={[0.18, 12, 12]} />
          <meshBasicMaterial color="#22d3ee" />
        </mesh>
      ))}
    </group>
  );
}
