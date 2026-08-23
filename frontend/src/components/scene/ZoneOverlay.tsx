import { Html, Line } from "@react-three/drei";
import { layout, useStore } from "../../state/store";
import { FLOOR_ELEV } from "./Mezzanine";

/** Zone 地面霓虹邊框 + 浮動標籤；BLOCKED 紅、CONGESTED 橘 */
export function ZoneOverlay({ labels = true }: { labels?: boolean }) {
  const zones = useStore((s) => s.twin.zones);
  const focus = useStore((s) => s.focus);
  const af = useStore((s) => s.activeFloor);
  const activeFloor = labels ? af : "all";   // lite 場景（CCTV）全樓層
  return (
    <group>
      {layout.zones.filter((z) => activeFloor === "all" || (z.floor ?? 1) === activeFloor).map((z) => {
        const st = zones[z.id]?.status ?? "NORMAL";
        const color = st === "BLOCKED" ? "#ef4444" : st === "CONGESTED" ? "#f97316" : z.color;
        const ey = FLOOR_ELEV[z.floor ?? 1] ?? 0;
        const pts = [...z.polygon, z.polygon[0]].map(([x, zz]) => [x, ey + 0.03, zz] as [number, number, number]);
        const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...zs) - Math.min(...zs);
        // 標籤放在 zone 靠外側的角落 (A 左上、B 右上、C 左下、D 右下)
        const lx = z.id === "A" || z.id === "C" ? Math.min(...xs) + 4 : Math.max(...xs) - 4;
        const lz = z.id === "A" || z.id === "B" ? Math.min(...zs) - 1.5 : Math.max(...zs) + 1.5;
        return (
          <group key={z.id}>
            <Line points={pts} color={color} lineWidth={1.6} transparent opacity={0.9} />
            {st !== "NORMAL" && (
              <mesh position={[cx, ey + 0.02, cz]} rotation-x={-Math.PI / 2}>
                <planeGeometry args={[w, d]} />
                <meshBasicMaterial color={color} transparent opacity={0.08} />
              </mesh>
            )}
            {labels && (
              <Html position={[lx, ey + 1.2, lz]} zIndexRange={[30, 20]}>
                <div className="zone-lbl" style={{ color, borderColor: color }} onClick={() => focus([cx, ey, cz])}>
                  {z.name.toUpperCase()}{st === "CONGESTED" ? " ⚠" : st === "BLOCKED" ? " ⛔" : ""}
                </div>
              </Html>
            )}
          </group>
        );
      })}
      {/* Inbound / Outbound 門牌 */}
      {labels && layout.docks.filter((d, i) => i % 2 === 0).map((d) => (
        <Html key={d.id} position={[(d.rect[0] + d.rect[2]) / 2 + 6, 6.2, 1]} zIndexRange={[30, 20]} style={{ pointerEvents: "none" }}>
          <div className="sign-lbl" style={{ color: d.kind === "INBOUND" ? "#86efac" : "#67e8f9", borderColor: d.kind === "INBOUND" ? "#15803d" : "#0e7490" }}>{d.kind}</div>
        </Html>
      ))}
    </group>
  );
}
