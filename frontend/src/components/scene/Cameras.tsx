import * as THREE from "three";
import { useMemo } from "react";
import { layout, useStore } from "../../state/store";

/** 攝影機小模型 + FOV 錐 (選中的攝影機錐體較亮) */
export function CameraGizmos() {
  const cams = useStore((s) => s.twin.cameras);
  const active = useStore((s) => s.activeCamera);
  const setActive = useStore((s) => s.setActiveCamera);
  const coneGeo = useMemo(() => new THREE.ConeGeometry(1, 1, 4, 1, true), []);
  return (
    <group>
      {layout.cameras.map((c) => {
        const status = cams[c.id]?.status ?? "ONLINE";
        const dir = new THREE.Vector3(...c.look_at).sub(new THREE.Vector3(...c.position));
        const len = Math.min(c.range_m * 0.35, 9);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
        const isActive = c.id === active;
        const col = status === "OFFLINE" ? "#6b7280" : isActive ? "#60a5fa" : "#22d3ee";
        return (
          <group key={c.id} position={c.position} onClick={(e) => { e.stopPropagation(); setActive(c.id); }}>
            {/* 支架與機身 */}
            <mesh position={[0, 0.4, 0]}><cylinderGeometry args={[0.05, 0.05, 0.8, 8]} /><meshStandardMaterial color="#374151" /></mesh>
            <mesh quaternion={q} position={[0, 0, 0]}>
              <boxGeometry args={[0.35, 0.6, 0.3]} />
              <meshStandardMaterial color="#111827" metalness={0.6} roughness={0.4} />
            </mesh>
            <mesh position={[0, 0.1, 0]}><sphereGeometry args={[0.07, 8, 8]} /><meshBasicMaterial color={status === "OFFLINE" ? "#6b7280" : "#ef4444"} /></mesh>
            {/* FOV 錐 */}
            <mesh quaternion={q} position={dir.clone().normalize().multiplyScalar(len / 2)} scale={[len * Math.tan((c.fov_deg * Math.PI) / 360), len, len * Math.tan((c.fov_deg * Math.PI) / 360) * 0.6]} geometry={coneGeo}>
              <meshBasicMaterial color={col} transparent opacity={isActive ? 0.16 : 0.05} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
