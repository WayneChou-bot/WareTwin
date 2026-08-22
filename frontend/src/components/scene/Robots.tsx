import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { STATUS_COLOR, useStore } from "../../state/store";
import type { RobotState } from "../../schema/twin_state";

/** 程序化 AMR 模型：底盤、深色頂蓋、四輪、前方藍色燈條、狀態燈；載貨時頂上放箱子 */
export function RobotMesh({ r, selected, onSelect, showLabel, lite, smooth = true }: { r: RobotState; selected: boolean; onSelect: () => void; showLabel: boolean; lite?: boolean; smooth?: boolean }) {
  const color = STATUS_COLOR[r.status];
  const ringRef = useRef<THREE.Mesh>(null!);
  const lampRef = useRef<THREE.MeshBasicMaterial>(null!);
  const groupRef = useRef<THREE.Group>(null!);
  const wheelsRef = useRef<THREE.Group>(null!);
  // 模擬 10 Hz 更新位置，畫面 60 Hz：用指數平滑追上目標，移動才不會一格一格跳
  useFrame(({ clock }, dt) => {
    const g = groupRef.current;
    if (g) {
      const k = smooth ? 1 - Math.pow(0.0005, dt) : 1;
      g.position.x += (r.position[0] - g.position.x) * k;
      g.position.z += (r.position[2] - g.position.z) * k;
      let dh = -r.heading - g.rotation.y; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
      g.rotation.y += dh * k;
      if (wheelsRef.current && r.velocity > 0.05) wheelsRef.current.rotation.z -= (r.velocity / 0.12) * dt;
    }
    if (ringRef.current) { const s = 1 + Math.sin(clock.elapsedTime * 3) * 0.08; ringRef.current.scale.set(s, s, s); }
    if (lampRef.current && (r.status === "ERROR" || r.status === "WARNING")) lampRef.current.opacity = 0.5 + Math.sin(clock.elapsedTime * 8) * 0.5;
  });
  const loaded = r.load.current > 0;
  return (
    <group ref={groupRef} position={r.position} rotation-y={-r.heading}>
      <group onClick={(e) => { e.stopPropagation(); onSelect(); }} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
        {/* 底盤 */}
        <mesh position={[0, 0.22, 0]} castShadow>
          <boxGeometry args={[1.3, 0.32, 0.9]} />
          <meshStandardMaterial color="#d7dce6" roughness={0.35} metalness={0.5} />
        </mesh>
        {/* 黑色頂蓋 */}
        <mesh position={[0, 0.42, 0]} castShadow>
          <boxGeometry args={[1.1, 0.1, 0.78]} />
          <meshStandardMaterial color="#111827" roughness={0.5} metalness={0.3} />
        </mesh>
        {/* 頂升平台 */}
        <mesh position={[0, 0.5, 0]}>
          <cylinderGeometry args={[0.3, 0.3, 0.06, 20]} />
          <meshStandardMaterial color="#1f2937" roughness={0.6} metalness={0.4} />
        </mesh>
        {/* 前燈條 */}
        <mesh position={[0.66, 0.22, 0]}>
          <boxGeometry args={[0.02, 0.08, 0.7]} />
          <meshBasicMaterial color="#60a5fa" />
        </mesh>
        {/* 黃黑警示條 */}
        {[-0.46, 0.46].map((z) => (
          <mesh key={z} position={[0, 0.1, z]}>
            <boxGeometry args={[1.3, 0.06, 0.02]} />
            <meshBasicMaterial color="#facc15" />
          </mesh>
        ))}
        {/* 輪子 */}
        <group ref={wheelsRef}>
          {[[-0.45, -0.42], [0.45, -0.42], [-0.45, 0.42], [0.45, 0.42]].map(([x, z], i) => (
            <mesh key={i} position={[x, 0.12, z]} rotation-x={Math.PI / 2}>
              <cylinderGeometry args={[0.12, 0.12, 0.1, 14]} />
              <meshStandardMaterial color="#0f172a" roughness={0.9} />
            </mesh>
          ))}
        </group>
        {/* 狀態燈 */}
        <mesh position={[-0.45, 0.5, 0]}>
          <sphereGeometry args={[0.07, 10, 10]} />
          <meshBasicMaterial ref={lampRef} color={color} transparent />
        </mesh>
        {/* 載貨箱 */}
        {loaded && (
          <mesh position={[0, 0.85, 0]} castShadow>
            <boxGeometry args={[1.0, 0.65, 0.8]} />
            <meshStandardMaterial color="#c49a6c" roughness={0.9} />
          </mesh>
        )}
      </group>
      {/* Phase 7：虛擬 LiDAR 視覺化（選取時畫 270° 扇形 + 到各障礙的射線；任何機器人因感知停車時畫前方紅弧） */}
      {!lite && selected && <PerceptionGizmo r={r} />}
      {!lite && !selected && r.perception?.state === "STOPPED" && (
        <mesh position={[0, 0.03, 0]} rotation-x={-Math.PI / 2}><ringGeometry args={[0.95, 1.12, 24, 1, -Math.PI / 6, Math.PI / 3]} /><meshBasicMaterial color="#ef4444" transparent opacity={0.9} side={THREE.DoubleSide} /></mesh>
      )}
      {/* 地面光環 */}
      <mesh ref={ringRef} position={[0, 0.02, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.75, 0.95, 40]} />
        <meshBasicMaterial color={selected ? "#60a5fa" : color} transparent opacity={selected ? 0.9 : 0.45} side={THREE.DoubleSide} />
      </mesh>
      {selected && <mesh position={[0, 0.015, 0]} rotation-x={-Math.PI / 2}><circleGeometry args={[1.4, 40]} /><meshBasicMaterial color="#3b82f6" transparent opacity={0.18} /></mesh>}
      {!lite && (r.status === "ERROR") && <pointLight position={[0, 1, 0]} color="#ef4444" intensity={4} distance={5} />}
      {showLabel && (
        <Html position={[0, 1.5, 0]} zIndexRange={[10, 0]}>
          <div className={"lbl" + (selected ? " sel" : r.status === "ERROR" ? " err" : r.status === "CHARGING" ? " chg" : "")} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
            {r.status === "ERROR" ? "⚠ " : ""}{r.id}
          </div>
        </Html>
      )}
    </group>
  );
}

const PERC_COLOR = { CLEAR: "#22d3ee", SLOWING: "#f59e0b", STOPPED: "#ef4444", OFF: "#475569" } as const;
/** 選取機器人的感知層：270° / 4 m 扇形（顏色 = 感知狀態）、正前方淨空線、到每個障礙的射線（紅 = 擋路的動態障礙） */
function PerceptionGizmo({ r }: { r: RobotState }) {
  const P = r.perception; if (!P) return null;
  const col = PERC_COLOR[P.state];
  const range = 4;
  return (
    <group>
      <mesh position={[0, 0.025, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.7, range, 48, 1, -Math.PI * 0.75, Math.PI * 1.5]} />
        <meshBasicMaterial color={col} transparent opacity={P.state === "STOPPED" ? 0.16 : 0.09} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.03, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[range - 0.05, range, 48, 1, -Math.PI * 0.75, Math.PI * 1.5]} />
        <meshBasicMaterial color={col} transparent opacity={0.5} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Line points={[[0.7, 0.08, 0], [Math.max(0.7, P.ahead_m), 0.08, 0]]} color={col} lineWidth={2} transparent opacity={0.9} />
      {P.obstacles.map((o, i) => {
        const b = (-o.bearing_deg * Math.PI) / 180; const x = o.distance_m * Math.cos(b), z = o.distance_m * Math.sin(b);
        const blocking = o.kind !== "RACK" && P.state !== "CLEAR" && o.distance_m <= P.ahead_m + 0.05;
        const c = o.kind === "RACK" ? "#94a3b8" : blocking ? "#ef4444" : o.kind === "HUMAN" ? "#f97316" : "#fbbf24";
        return (
          <group key={i}>
            <Line points={[[0, 0.1, 0], [x, 0.1, z]]} color={c} lineWidth={blocking ? 2 : 1} dashed={o.kind === "RACK"} dashSize={0.3} gapSize={0.2} transparent opacity={0.85} />
            {o.kind !== "RACK" && <mesh position={[x, 0.1, z]}><sphereGeometry args={[0.12, 8, 8]} /><meshBasicMaterial color={c} /></mesh>}
          </group>
        );
      })}
    </group>
  );
}

/** 機器人目前的 A* 路徑（格點 → 世界座標），選取時加粗；終點畫圓環 */
function RobotPath({ r, selected }: { r: RobotState; selected: boolean }) {
  const pts = useMemo(() => {
    if (r.path.length === 0 || r.path_index >= r.path.length) return null;
    const out: [number, number, number][] = [[r.position[0], 0.06, r.position[2]]];
    for (let i = r.path_index; i < r.path.length; i++) out.push([r.path[i][0] + 0.5, 0.06, r.path[i][1] + 0.5]);
    return out;
  }, [r.path, r.path_index, r.position]);
  if (!pts) return null;
  const end = pts[pts.length - 1];
  const col = r.fsm === "GOING_TO_CHARGE" ? "#60a5fa" : r.load.current > 0 ? "#f59e0b" : "#22d3ee";
  return (
    <group>
      <Line points={pts} color={selected ? "#ffffff" : col} lineWidth={selected ? 2.4 : 1.1} dashed dashSize={0.7} gapSize={0.4} transparent opacity={selected ? 1 : 0.5} />
      <mesh position={[end[0], 0.05, end[2]]} rotation-x={-Math.PI / 2}><ringGeometry args={[0.45, 0.65, 24]} /><meshBasicMaterial color={col} transparent opacity={0.85} /></mesh>
    </group>
  );
}

export function Robots({ lite = false }: { lite?: boolean }) {
  const robots = useStore((s) => s.twin.robots);
  const selected = useStore((s) => s.selectedRobot);
  const select = useStore((s) => s.select);
  const showLabels = useStore((s) => s.showLabels);
  const showPaths = useStore((s) => s.showPaths);
  return (
    <group>
      {Object.values(robots).map((r) => (
        <group key={r.id}>
          <RobotMesh r={r} selected={r.id === selected} onSelect={() => select(r.id)} showLabel={showLabels && !lite} lite={lite} />
          {showPaths && !lite && <RobotPath r={r} selected={r.id === selected} />}
        </group>
      ))}
    </group>
  );
}
