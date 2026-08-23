import type { WarehouseLayout } from "./types";

/**
 * 由 layout 產生導航網格。0 = 可通行、1 = 障礙、2 = walkway (可通行但減速)。
 * 規則見格式說明「導航網格的產生規則」。後端 Python 需實作同樣規則並以同一 layout 做比對測試。
 */
export function buildNavGrid(layout: WarehouseLayout, floor = 1): { cols: number; rows: number; cells: Uint8Array } {
  const { cols, rows, cell_size: cs } = layout.grid;
  const cells = new Uint8Array(cols * rows);
  // 電梯井道（鋼架＋護網）在每個樓層都是實體障礙：一般路徑必須繞過，
  // 進出轎廂只走電梯狀態機的 microMove（不經網格）。取轎廂為中心的 3×3 格，
  // 排隊格（cell-2-i）與全部出口候選點都在外面、維持可走。
  const blockLifts = () => {
    for (const l of layout.lifts ?? []) {
      const x = l.cell[0] + 0.5, z = l.cell[1] + 0.5;
      const c0 = Math.max(0, Math.floor((x - 1.4) / cs)), c1 = Math.min(cols - 1, Math.ceil((x + 1.4) / cs) - 1);
      const r0 = Math.max(0, Math.floor((z - 1.4) / cs)), r1 = Math.min(rows - 1, Math.ceil((z + 1.4) / cs) - 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * cols + c] = 1;
    }
  };
  if (floor !== 1) {
    // 二樓（夾層）：footprint 之外全是「不存在的樓板」= 障礙；footprint 內可走，再扣掉該樓層貨架
    cells.fill(1);
    const fp = layout.floors.find((f) => f.id === floor)?.footprint;
    if (fp) {
      const xs = fp.map((p) => p[0]), zs = fp.map((p) => p[1]);
      const c0 = Math.max(0, Math.floor(Math.min(...xs) / cs)), c1 = Math.min(cols - 1, Math.ceil(Math.max(...xs) / cs) - 1);
      const r0 = Math.max(0, Math.floor(Math.min(...zs) / cs)), r1 = Math.min(rows - 1, Math.ceil(Math.max(...zs) / cs) - 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * cols + c] = 0;
    }
    for (const r of layout.racks) if (r.blocks_grid && (r.floor ?? 1) === floor) {
      const x0 = r.position[0], z0 = r.position[2], x1 = x0 + r.size[0], z1 = z0 + r.size[2];
      const c0 = Math.max(0, Math.floor(x0 / cs)), c1 = Math.min(cols - 1, Math.ceil(x1 / cs) - 1);
      const r0 = Math.max(0, Math.floor(z0 / cs)), r1 = Math.min(rows - 1, Math.ceil(z1 / cs) - 1);
      for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) cells[rr * cols + cc] = 1;
    }
    blockLifts();
    return { cols, rows, cells };
  }
  const fillRect = (x0: number, z0: number, x1: number, z1: number, v: number) => {
    const c0 = Math.max(0, Math.floor(x0 / cs)), c1 = Math.min(cols - 1, Math.ceil(x1 / cs) - 1);
    const r0 = Math.max(0, Math.floor(z0 / cs)), r1 = Math.min(rows - 1, Math.ceil(z1 / cs) - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * cols + c] = v;
  };
  for (const w of layout.walkways) {
    const xs = w.polygon.map((p) => p[0]), zs = w.polygon.map((p) => p[1]);
    fillRect(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), 2);
  }
  for (const r of layout.racks) if (r.blocks_grid && (r.floor ?? 1) === 1) fillRect(r.position[0], r.position[2], r.position[0] + r.size[0], r.position[2] + r.size[2], 1);
  for (const c of layout.conveyors) if (c.blocks_grid) {
    for (let i = 0; i < c.path.length - 1; i++) {
      const [ax, az] = c.path[i], [bx, bz] = c.path[i + 1], hw = c.width / 2;
      fillRect(Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw, 1);
    }
  }
  for (const ra of layout.restricted_areas) if (!ra.robots_allowed) fillRect(ra.rect[0], ra.rect[1], ra.rect[2], ra.rect[3], 1);
  for (const s of layout.stations) fillRect(s.rect[0], s.rect[1], s.rect[2], s.rect[3], 1);
  blockLifts();
  return { cols, rows, cells };
}
