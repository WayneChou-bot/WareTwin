import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, ContactShadows } from "@react-three/drei";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer, Bloom, N8AO, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { layout, useStore } from "../../state/store";
import { WarehouseShell } from "./WarehouseShell";
import { RackInstances } from "./RackInstances";
import { Fixtures } from "./Fixtures";
import { ZoneOverlay } from "./ZoneOverlay";
import { Robots } from "./Robots";
import { CameraGizmos } from "./Cameras";
import { People } from "./People";
import { Mezzanine, FLOOR_ELEV } from "./Mezzanine";

const W = layout.size.width, D = layout.size.depth;

/** 相機聚焦動畫：focusTarget 改變時平滑移動 OrbitControls target */
function CameraRig({ controls }: { controls: React.RefObject<OrbitControlsImpl> }) {
  const focusTarget = useStore((s) => s.focusTarget);
  const focus = useStore((s) => s.focus);
  const selected = useStore((s) => s.selectedRobot);
  const robots = useStore((s) => s.twin.robots);
  const goal = useRef<THREE.Vector3 | null>(null);
  const camGoal = useRef<THREE.Vector3 | null>(null);
  const prevSel = useRef(selected);
  useEffect(() => {
    if (focusTarget) { goal.current = new THREE.Vector3(...focusTarget); camGoal.current = new THREE.Vector3(focusTarget[0], 28, focusTarget[2] + 26); }
  }, [focusTarget]);
  useEffect(() => {
    if (selected && selected !== prevSel.current) {
      const r = robots[selected];
      if (r) { const ey = FLOOR_ELEV[r.floor] ?? 0;
        goal.current = new THREE.Vector3(r.position[0], ey + 0.5, r.position[2]); // 沿走道方向 (x 軸) 看過去，避免被前方貨架擋住
        camGoal.current = new THREE.Vector3(r.position[0] + 16, ey + 11, r.position[2] + 2.5); }
    }
    prevSel.current = selected;
  }, [selected, robots]);
  useFrame(({ camera }, dt) => {
    const c = controls.current; if (!c || !goal.current) return;
    const k = 1 - Math.pow(0.001, dt);
    c.target.lerp(goal.current, k);
    if (camGoal.current) camera.position.lerp(camGoal.current, k);
    c.update();
    if (c.target.distanceTo(goal.current) < 0.05) { goal.current = null; camGoal.current = null; focus(null); }
  });
  return null;
}

function Lights({ quality }: { quality: string }) {
  const shadows = quality !== "low";
  return (
    <>
      <ambientLight intensity={0.35} color="#b9c6e0" />
      <hemisphereLight args={["#9db4e0", "#1a2233", 0.45]} />
      <directionalLight
        position={[W * 0.3, 60, D * 0.2]} intensity={1.6} color="#e8eefc" castShadow={shadows}
        shadow-mapSize={quality === "high" ? [4096, 4096] : [2048, 2048]} shadow-bias={-0.0004}
        shadow-camera-left={-W * 0.7} shadow-camera-right={W * 0.7} shadow-camera-top={D * 0.7} shadow-camera-bottom={-D * 0.7} shadow-camera-near={10} shadow-camera-far={160}
      />
      <pointLight position={[W / 2, 10, D / 2]} intensity={0.6} color="#60a5fa" distance={80} decay={1} />
      <pointLight position={[26, 8, 4]} intensity={1.2} color="#22c55e" distance={25} decay={1.5} />
      <pointLight position={[74, 8, 4]} intensity={1.2} color="#22d3ee" distance={25} decay={1.5} />
    </>
  );
}

function FpsCounter({ onFps }: { onFps: (v: number) => void }) {
  const acc = useRef({ t: 0, n: 0 });
  useFrame((_, dt) => { acc.current.t += dt; acc.current.n++; if (acc.current.t >= 0.5) { onFps(Math.round(acc.current.n / acc.current.t)); acc.current = { t: 0, n: 0 }; } });
  return null;
}

/** 背景、霧、以及程序化的環境貼圖 (RoomEnvironment，不需下載 HDR，離線可用) */
function Background({ env = true }: { env?: boolean }) {
  const { scene, gl } = useThree();
  useEffect(() => {
    scene.background = new THREE.Color("#05080f"); scene.fog = new THREE.Fog("#05080f", 120, 260);
    if (!env) return;
    const pmrem = new THREE.PMREMGenerator(gl);
    const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = tex; scene.environmentIntensity = 0.35;
    return () => { scene.environment = null; tex.dispose(); pmrem.dispose(); };
  }, [scene, gl, env]);
  return null;
}

export function SceneContent({ quality, lite = false }: { quality: "low" | "medium" | "high"; lite?: boolean }) {
  const af = useStore((s) => s.activeFloor);
  const activeFloor = lite ? "all" : af;   // CCTV / 縮圖用的 lite 場景永遠全樓層
  const f2 = layout.floors?.find((f) => f.id === 2);
  return (
    <>
      <Background env={!lite} />
      <Lights quality={lite ? "low" : quality} />
      <group visible={activeFloor === "all" || activeFloor === 1}>
        <WarehouseShell lite={lite} />
        <RackInstances castShadow={!lite && quality !== "low"} floor={1} />
        <Fixtures lite={lite} />
      </group>
      {f2 && (
        <group visible={activeFloor === "all" || activeFloor === 2}>
          <Mezzanine lite={lite} />
          <RackInstances castShadow={false} floor={2} yOffset={f2.elevation} />
        </group>
      )}
      <ZoneOverlay labels={!lite} />
      <People lite={lite} />
      <Robots lite={lite} />
      {!lite && <CameraGizmos />}
      {!lite && quality === "high" && <ContactShadows position={[W / 2, 0.01, D / 2]} scale={[W, D]} blur={2} opacity={0.5} far={4} />}
    </>
  );
}

export function Scene3D() {
  const quality = useStore((s) => s.quality);
  const tool = useStore((s) => s.tool);
  const select = useStore((s) => s.select);
  const controls = useRef<OrbitControlsImpl>(null!);
  const [fps, setFps] = useState(0);
  return (
    <>
      <Canvas
        resize={{ offsetSize: true }}
        shadows={quality !== "low"}
        dpr={quality === "high" ? [1, 2] : quality === "medium" ? [1, 1.5] : 1}
        gl={{ antialias: quality !== "low", powerPreference: "high-performance", toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.15 }}
        camera={{ position: [W / 2 + 4, 58, D + 50], fov: 36, near: 0.5, far: 400 }}
        onPointerMissed={() => tool === "select" && select(null)}
      >
        <SceneContent quality={quality} />
        <OrbitControls ref={controls} target={[W / 2, 0, D / 2 - 2]} maxPolarAngle={Math.PI / 2.15} minDistance={8} maxDistance={200} enableDamping dampingFactor={0.08} enablePan mouseButtons={tool === "pan" ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }} />
        <CameraRig controls={controls} />
        <FpsCounter onFps={setFps} />
        {quality === "high" && (
          <EffectComposer multisampling={4}>
            <N8AO aoRadius={2} intensity={1.2} distanceFalloff={1} />
            <Bloom luminanceThreshold={0.85} intensity={0.55} mipmapBlur />
            <Vignette eskil={false} offset={0.2} darkness={0.55} />
          </EffectComposer>
        )}
        {quality === "medium" && (
          <EffectComposer multisampling={0}>
            <Bloom luminanceThreshold={0.9} intensity={0.4} mipmapBlur />
          </EffectComposer>
        )}
      </Canvas>
      <div className="fps">{fps} FPS · {quality.toUpperCase()}</div>
    </>
  );
}
