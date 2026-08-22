/**
 * 格點 A*（8 方向、禁止切角）。
 * - grid.cells：0 可通行、1 障礙、2 人行道（可通行但成本較高）
 * - blocked：臨時障礙（其他機器人佔用格、封鎖 Zone 等），以 "c,r" 字串集合傳入
 * - costMap：可選的每格額外成本（交通擁塞），長度 cols*rows
 * 回傳不含起點的格點序列；找不到路徑回傳 null。
 * 純函式、無亂數，同樣輸入必得同樣輸出（What-if 重現性的基礎）。
 */
import type { GridCell } from "../schema/twin_state";

export interface NavGrid { cols: number; rows: number; cells: Uint8Array }

const SQRT2 = Math.SQRT2;
const DIRS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

class MinHeap {
  private a: Array<{ k: number; v: number }> = [];
  get size() { return this.a.length; }
  push(k: number, v: number) {
    const a = this.a; a.push({ k, v }); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].k <= a[i].k) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop(): number {
    const a = this.a; const top = a[0].v; const last = a.pop()!;
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].k < a[m].k) m = l; if (r < a.length && a[r].k < a[m].k) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}

export function cellKey(c: number, r: number) { return `${c},${r}`; }

export function isWalkable(grid: NavGrid, c: number, r: number, blocked?: Set<string>): boolean {
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false;
  if (grid.cells[r * grid.cols + c] === 1) return false;
  if (blocked && blocked.has(cellKey(c, r))) return false;
  return true;
}

export function astar(grid: NavGrid, start: GridCell, goal: GridCell, opts: { blocked?: Set<string>; costMap?: Float32Array; maxExpand?: number } = {}): GridCell[] | null {
  const { cols, rows, cells } = grid;
  const { blocked, costMap, maxExpand = 60000 } = opts;
  const idx = (c: number, r: number) => r * cols + c;
  if (!isWalkable(grid, goal[0], goal[1])) return null; // 目標本身是牆 (不看 blocked：目標可能是被暫時佔用的格)
  const sIdx = idx(start[0], start[1]), gIdx = idx(goal[0], goal[1]);
  if (sIdx === gIdx) return [];
  const g = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const h = (c: number, r: number) => { const dx = Math.abs(c - goal[0]), dz = Math.abs(r - goal[1]); return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz); };
  const open = new MinHeap();
  g[sIdx] = 0; open.push(h(start[0], start[1]), sIdx);
  let expanded = 0;
  while (open.size) {
    const cur = open.pop();
    if (cur === gIdx) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (++expanded > maxExpand) return null;
    const cc = cur % cols, cr = (cur - cc) / cols;
    for (const [dx, dz, base] of DIRS) {
      const nc = cc + dx, nr = cr + dz;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = idx(nc, nr);
      if (closed[ni]) continue;
      const v = cells[ni];
      if (v === 1) continue;
      if (blocked && ni !== gIdx && blocked.has(cellKey(nc, nr))) continue;
      // 禁止切角：對角線移動時兩個相鄰正交格都必須可通行
      if (dx !== 0 && dz !== 0) {
        if (!isWalkable(grid, cc + dx, cr, blocked) || !isWalkable(grid, cc, cr + dz, blocked)) continue;
      }
      let cost = base * (v === 2 ? 1.6 : 1);
      if (costMap) cost += costMap[ni];
      const ng = g[cur] + cost;
      if (ng < g[ni]) { g[ni] = ng; came[ni] = cur; open.push(ng + h(nc, nr), ni); }
    }
  }
  if (came[gIdx] === -1) return null;
  const path: GridCell[] = [];
  for (let i = gIdx; i !== sIdx; i = came[i]) { const c = i % cols; path.push([c, (i - c) / cols]); }
  path.reverse();
  return path;
}

/** 世界座標 → 格點 */
export function toCell(x: number, z: number, cellSize = 1): GridCell { return [Math.floor(x / cellSize), Math.floor(z / cellSize)]; }
/** 格點中心 → 世界座標 */
export function cellCenter(c: GridCell, cellSize = 1): [number, number] { return [(c[0] + 0.5) * cellSize, (c[1] + 0.5) * cellSize]; }

/** 找離 (x,z) 最近的可通行格（access point 落在牆上時的保險） */
export function nearestWalkable(grid: NavGrid, x: number, z: number, blocked?: Set<string>): GridCell {
  const [c0, r0] = toCell(x, z);
  if (isWalkable(grid, c0, r0, blocked)) return [c0, r0];
  for (let rad = 1; rad < 8; rad++) {
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
      if (isWalkable(grid, c0 + dc, r0 + dr, blocked)) return [c0 + dc, r0 + dr];
    }
  }
  return [c0, r0];
}
