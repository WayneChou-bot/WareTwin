import { Html } from "@react-three/drei";
import { useStore } from "../../state/store";
import { FLOOR_ELEV } from "./Mezzanine";

/** 人員 / 堆高機 NPC；Phase 1 為靜態裝飾，Phase 4 由故障注入驅動 */
export function People({ lite = false }: { lite?: boolean }) {
  const people = useStore((s) => s.twin.people);
  const af = useStore((s) => s.activeFloor);
  const activeFloor = lite || af === "exploded" ? "all" : af;
  const explodeY = (floor: number) => (af === "exploded" && floor === 2 ? 5 : 0);
  const show = (floor: number) => activeFloor === "all" || floor === activeFloor;
  // Phase 1：固定幾個穿螢光背心的工作人員與一台堆高機（一樓裝飾），讓畫面有生氣
  const staticWorkers: Array<[number, number, number]> = [[33, 0, 9], [66, 0, 9], [12, 0, 66], [89, 0, 60]];
  const forklift: [number, number, number] = [8, 0, 4];
  return (
    <group>
      {show(1) && staticWorkers.map((p, i) => <Worker key={i} position={p} heading={i * 1.1} />)}
      {show(1) && <Forklift position={forklift} />}
      {Object.values(people).filter((p) => show(p.floor ?? 1)).map((p) => {
        const ey = (FLOOR_ELEV[p.floor ?? 1] ?? 0) + explodeY(p.floor ?? 1);
        return (
          <group key={p.id} position-y={ey}>
            {p.kind === "WORKER" ? <Worker position={p.position} heading={p.heading} alert /> : <Forklift position={p.position} heading={p.heading} />}
            {!lite && <Html position={[p.position[0], 2.3, p.position[2]]} center zIndexRange={[12, 0]}><div className="lbl err">⚠ HUMAN</div></Html>}
          </group>
        );
      })}
    </group>
  );
}

function Worker({ position, heading = 0, alert = false }: { position: [number, number, number]; heading?: number; alert?: boolean }) {
  return (
    <group position={position} rotation-y={heading}>
      <mesh position={[0, 0.45, 0]}><capsuleGeometry args={[0.16, 0.5, 4, 8]} /><meshStandardMaterial color="#1e3a8a" /></mesh>
      <mesh position={[0, 1.05, 0]}><capsuleGeometry args={[0.2, 0.45, 4, 8]} /><meshStandardMaterial color="#a3e635" emissive="#a3e635" emissiveIntensity={0.5} /></mesh>
      <mesh position={[0, 1.58, 0]}><sphereGeometry args={[0.15, 10, 10]} /><meshStandardMaterial color="#f1c27d" /></mesh>
      <mesh position={[0, 1.7, 0]}><sphereGeometry args={[0.17, 10, 10, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color="#facc15" /></mesh>
      {alert && <mesh position={[0, 0.02, 0]} rotation-x={-Math.PI / 2}><ringGeometry args={[0.7, 0.9, 32]} /><meshBasicMaterial color="#ef4444" /></mesh>}
    </group>
  );
}

function Forklift({ position, heading = 0.4 }: { position: [number, number, number]; heading?: number }) {
  return (
    <group position={position} rotation-y={heading}>
      <mesh position={[0, 0.6, 0]} castShadow><boxGeometry args={[2.2, 0.9, 1.2]} /><meshStandardMaterial color="#f59e0b" roughness={0.5} metalness={0.3} /></mesh>
      <mesh position={[-0.3, 1.6, 0]}><boxGeometry args={[0.9, 1.1, 1.0]} /><meshStandardMaterial color="#111827" /></mesh>
      <mesh position={[1.3, 1.2, 0]}><boxGeometry args={[0.12, 2.4, 1.0]} /><meshStandardMaterial color="#374151" metalness={0.7} /></mesh>
      {[-0.45, 0.45].map((z) => <mesh key={z} position={[1.7, 0.12, z]}><boxGeometry args={[1.0, 0.06, 0.14]} /><meshStandardMaterial color="#9ca3af" metalness={0.8} /></mesh>)}
      {[[-0.7, -0.6], [0.7, -0.6], [-0.7, 0.6], [0.7, 0.6]].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.28, z]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.28, 0.28, 0.25, 14]} /><meshStandardMaterial color="#0f172a" /></mesh>
      ))}
    </group>
  );
}
