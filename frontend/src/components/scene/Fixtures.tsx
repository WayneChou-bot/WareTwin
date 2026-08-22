import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { layout, useStore } from "../../state/store";
import type { LayoutConveyor } from "../../layout/types";

/** 輸送帶：沿 path 擠出，RUNNING 時滾輪貼圖捲動，ERROR 紅色閃爍 */
function Conveyor({ c }: { c: LayoutConveyor }) {
  const status = useStore((s) => s.twin.conveyors[c.id]?.status ?? "RUNNING");
  const matRef = useRef<THREE.MeshStandardMaterial>(null!);
  const segs = [] as JSX.Element[];
  for (let i = 0; i < c.path.length - 1; i++) {
    const [ax, az] = c.path[i], [bx, bz] = c.path[i + 1];
    const len = Math.hypot(bx - ax, bz - az), ang = Math.atan2(bz - az, bx - ax);
    segs.push(
      <group key={i} position={[(ax + bx) / 2, 0, (az + bz) / 2]} rotation-y={-ang}>
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
        {/* 帶上的包裹 */}
        {status !== "ERROR" && Array.from({ length: Math.floor(len / 5) }, (_, k) => (
          <mesh key={k} position={[-len / 2 + 2 + k * 5, 1.15, 0]} castShadow>
            <boxGeometry args={[0.7, 0.5, 0.6]} />
            <meshStandardMaterial color="#c49a6c" roughness={0.9} />
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
  useFrame(({ clock }) => {
    if (status === "ERROR" && matRef.current) matRef.current.emissiveIntensity = 0.4 + Math.sin(clock.elapsedTime * 6) * 0.35;
  });
  return <group>{segs}</group>;
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
            <mesh position={[0, 0.01, -1.3]} rotation-x={-Math.PI / 2}><planeGeometry args={[1.6, 2]} /><meshBasicMaterial color="#1d4ed8" transparent opacity={0.25} /></mesh>
            {occupied && <pointLight position={[0, 1, -1]} color="#3b82f6" intensity={lite ? 0 : 3} distance={4} />}
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
