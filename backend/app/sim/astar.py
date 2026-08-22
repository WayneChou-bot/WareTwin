"""
格點 A*（8 方向、禁止切角）— frontend/src/simulation/astar.ts 的 Python 版本。
grid.cells: 0 可通行、1 障礙、2 人行道（成本 ×1.6）。
blocked: 臨時障礙 (set of (c, r))；cost_map: 每格額外成本 (list[float] 長 cols*rows)。
回傳不含起點的格點列表；找不到回傳 None。純函式、無亂數。
"""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass
from typing import Optional, Sequence

SQRT2 = math.sqrt(2.0)
DIRS = ((1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
        (1, 1, SQRT2), (1, -1, SQRT2), (-1, 1, SQRT2), (-1, -1, SQRT2))

Cell = tuple[int, int]


@dataclass
class NavGrid:
    cols: int
    rows: int
    cells: bytearray  # row-major


def is_walkable(grid: NavGrid, c: int, r: int, blocked: Optional[set[Cell]] = None) -> bool:
    if c < 0 or r < 0 or c >= grid.cols or r >= grid.rows:
        return False
    if grid.cells[r * grid.cols + c] == 1:
        return False
    if blocked is not None and (c, r) in blocked:
        return False
    return True


def astar(grid: NavGrid, start: Cell, goal: Cell, blocked: Optional[set[Cell]] = None,
          cost_map: Optional[Sequence[float]] = None, max_expand: int = 60000) -> Optional[list[Cell]]:
    cols, rows, cells = grid.cols, grid.rows, grid.cells
    if not is_walkable(grid, goal[0], goal[1]):
        return None
    s_idx = start[1] * cols + start[0]
    g_idx = goal[1] * cols + goal[0]
    if s_idx == g_idx:
        return []
    n = cols * rows
    g = [math.inf] * n
    came = [-1] * n
    closed = bytearray(n)
    gx, gz = goal

    def h(c: int, r: int) -> float:
        dx = abs(c - gx); dz = abs(r - gz)
        return (dx + dz) + (SQRT2 - 2.0) * min(dx, dz)

    g[s_idx] = 0.0
    # (f, 插入序號, idx) — 序號讓同 f 時保持插入順序，與 TS 的 heap 行為一致 (不嚴格相同但結果穩定)
    seq = 0
    open_heap: list[tuple[float, int, int]] = [(h(start[0], start[1]), seq, s_idx)]
    expanded = 0
    while open_heap:
        _, _, cur = heapq.heappop(open_heap)
        if cur == g_idx:
            break
        if closed[cur]:
            continue
        closed[cur] = 1
        expanded += 1
        if expanded > max_expand:
            return None
        cc = cur % cols; cr = cur // cols
        gcur = g[cur]
        for dx, dz, base in DIRS:
            nc = cc + dx; nr = cr + dz
            if nc < 0 or nr < 0 or nc >= cols or nr >= rows:
                continue
            ni = nr * cols + nc
            if closed[ni]:
                continue
            v = cells[ni]
            if v == 1:
                continue
            if blocked is not None and ni != g_idx and (nc, nr) in blocked:
                continue
            if dx != 0 and dz != 0:
                if not is_walkable(grid, cc + dx, cr, blocked) or not is_walkable(grid, cc, cr + dz, blocked):
                    continue
            cost = base * (1.6 if v == 2 else 1.0)
            if cost_map is not None:
                cost += cost_map[ni]
            ng = gcur + cost
            if ng < g[ni]:
                g[ni] = ng; came[ni] = cur
                seq += 1
                heapq.heappush(open_heap, (ng + h(nc, nr), seq, ni))
    if came[g_idx] == -1:
        return None
    path: list[Cell] = []
    i = g_idx
    while i != s_idx:
        path.append((i % cols, i // cols))
        i = came[i]
    path.reverse()
    return path


def to_cell(x: float, z: float, cell_size: float = 1.0) -> Cell:
    return (math.floor(x / cell_size), math.floor(z / cell_size))


def cell_center(c: Cell, cell_size: float = 1.0) -> tuple[float, float]:
    return ((c[0] + 0.5) * cell_size, (c[1] + 0.5) * cell_size)


def nearest_walkable(grid: NavGrid, x: float, z: float, blocked: Optional[set[Cell]] = None) -> Cell:
    c0, r0 = to_cell(x, z)
    if is_walkable(grid, c0, r0, blocked):
        return (c0, r0)
    for rad in range(1, 8):
        for dr in range(-rad, rad + 1):
            for dc in range(-rad, rad + 1):
                if max(abs(dr), abs(dc)) != rad:
                    continue
                if is_walkable(grid, c0 + dc, r0 + dr, blocked):
                    return (c0 + dc, r0 + dr)
    return (c0, r0)
