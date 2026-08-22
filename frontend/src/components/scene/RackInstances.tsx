import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { layout } from "../../state/store";
import { mulberry32 } from "../../simulation/engine";

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const BOX_PALETTE = ["#b8834a", "#c99a63", "#a87440", "#d2a874", "#9c6b3c"];

/**
 * 160 貨架，每座：立柱 ×4 + 橫樑 ×levels，箱子依 levels 隨機填充 (seed 固定)。
 * 全部走 InstancedMesh：三個 draw call 畫完整個倉庫的貨架與箱子。
 */
export function RackInstances({ castShadow = true }: { castShadow?: boolean }) {
  const postRef = useRef<THREE.InstancedMesh>(null!);
  const beamRef = useRef<THREE.InstancedMesh>(null!);
  const boxRef = useRef<THREE.InstancedMesh>(null!);

  const data = useMemo(() => {
    const rnd = mulberry32(1234);
    const posts: THREE.Matrix4[] = [], beams: THREE.Matrix4[] = [];
    const boxes: { m: THREE.Matrix4; c: string }[] = [];
    for (const r of layout.racks) {
      const [x, , z] = r.position; const [w, h, d] = r.size;
      const levelH = h / r.levels;
      for (const [dx, dz] of [[0, 0], [w, 0], [0, d], [w, d]]) {
        dummy.position.set(x + dx, h / 2, z + dz); dummy.scale.set(0.1, h, 0.1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
        posts.push(dummy.matrix.clone());
      }
      for (let l = 0; l < r.levels; l++) {
        const y = l * levelH + 0.05;
        for (const dz of [0.02, d - 0.02]) {
          dummy.position.set(x + w / 2, y, z + dz); dummy.scale.set(w, 0.1, 0.08); dummy.updateMatrix(); beams.push(dummy.matrix.clone());
        }
        // 層板
        dummy.position.set(x + w / 2, y - 0.02, z + d / 2); dummy.scale.set(w, 0.04, d); dummy.updateMatrix(); beams.push(dummy.matrix.clone());
        // 箱子：每層 2 格，各 70% 機率有箱子，尺寸微隨機
        for (let s = 0; s < 2; s++) {
          if (rnd() > 0.72) continue;
          const bw = 1.1 + rnd() * 0.3, bh = Math.min(levelH - 0.25, 0.7 + rnd() * 0.6), bd = d - 0.2;
          dummy.position.set(x + 0.75 + s * 1.5, y + bh / 2 + 0.03, z + d / 2);
          dummy.scale.set(bw, bh, bd); dummy.rotation.set(0, (rnd() - 0.5) * 0.08, 0); dummy.updateMatrix();
          boxes.push({ m: dummy.matrix.clone(), c: BOX_PALETTE[Math.floor(rnd() * BOX_PALETTE.length)] });
        }
      }
    }
    return { posts, beams, boxes };
  }, []);

  useLayoutEffect(() => {
    data.posts.forEach((m, i) => postRef.current.setMatrixAt(i, m));
    data.beams.forEach((m, i) => beamRef.current.setMatrixAt(i, m));
    data.boxes.forEach((b, i) => { boxRef.current.setMatrixAt(i, b.m); boxRef.current.setColorAt(i, color.set(b.c)); });
    postRef.current.instanceMatrix.needsUpdate = true;
    beamRef.current.instanceMatrix.needsUpdate = true;
    boxRef.current.instanceMatrix.needsUpdate = true;
    if (boxRef.current.instanceColor) boxRef.current.instanceColor.needsUpdate = true;
    [postRef, beamRef, boxRef].forEach((r) => r.current.computeBoundingSphere());
  }, [data]);

  return (
    <group>
      <instancedMesh ref={postRef} args={[undefined, undefined, data.posts.length]} castShadow={castShadow} receiveShadow frustumCulled={false}>
        <boxGeometry />
        <meshStandardMaterial color="#2f3a4a" roughness={0.6} metalness={0.6} />
      </instancedMesh>
      <instancedMesh ref={beamRef} args={[undefined, undefined, data.beams.length]} frustumCulled={false}>
        <boxGeometry />
        <meshStandardMaterial color="#e07a1f" roughness={0.5} metalness={0.5} />
      </instancedMesh>
      <instancedMesh ref={boxRef} args={[undefined, undefined, data.boxes.length]} castShadow={castShadow} receiveShadow frustumCulled={false}>
        <boxGeometry />
        <meshStandardMaterial roughness={0.9} metalness={0} />
      </instancedMesh>
    </group>
  );
}
