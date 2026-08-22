import type { WarehouseLayout } from "./types";

/**
 * 由 layout 產生導航網格。0 = 可通行、1 = 障礙、2 = walkway (可通行但減速)。
 * 規則見格式說明「導航網格的產生規則」。後端 Python 需實作同樣規則並以同一 layout 做比對測試。
 */
export function buildNavGrid(layout: WarehouseLayout): { cols: number; rows: number; cells: Uint8Array } {
  const { cols, rows, cell_size: cs } = layout.grid;
  const cells = new Uint8Array(cols * rows);
  const fillRect = (x0: number, z0: number, x1: number, z1: number, v: number) => {
    const c0 = Math.max(0, Math.floor(x0 / cs)), c1 = Math.min(cols - 1, Math.ceil(x1 / cs) - 1);
    const r0 = Math.max(0, Math.floor(z0 / cs)), r1 = Math.min(rows - 1, Math.ceil(z1 / cs) - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * cols + c] = v;
  };
  for (const w of layout.walkways) {
    const xs = w.polygon.map((p) => p[0]), zs = w.polygon.map((p) => p[1]);
    fillRect(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), 2);
  }
  for (const r of layout.racks) if (r.blocks_grid) fillRect(r.position[0], r.position[2], r.position[0] + r.size[0], r.position[2] + r.size[2], 1);
  for (const c of layout.conveyors) if (c.blocks_grid) {
    for (let i = 0; i < c.path.length - 1; i++) {
      const [ax, az] = c.path[i], [bx, bz] = c.path[i + 1], hw = c.width / 2;
      fillRect(Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw, 1);
    }
  }
  for (const ra of layout.restricted_areas) if (!ra.robots_allowed) fillRect(ra.rect[0], ra.rect[1], ra.rect[2], ra.rect[3], 1);
  for (const s of layout.stations) fillRect(s.rect[0], s.rect[1], s.rect[2], s.rect[3], 1);
  return { cols, rows, cells };
}
