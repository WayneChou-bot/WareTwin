"""由 warehouse_layout.json 產生導航網格 — frontend/src/layout/navgrid.ts 的 Python 版本。規則必須與前端完全一致。"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .astar import NavGrid


def load_layout(path: str | Path | None = None) -> dict[str, Any]:
    p = Path(path) if path else Path(__file__).resolve().parent.parent / "warehouse_layout.json"
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def build_nav_grid(layout: dict[str, Any], floor: int = 1) -> NavGrid:
    cols, rows, cs = layout["grid"]["cols"], layout["grid"]["rows"], layout["grid"]["cell_size"]
    cells = bytearray(cols * rows)

    def block_lifts() -> None:
        # 電梯井道（鋼架＋護網）在每個樓層都是實體障礙：一般路徑必須繞過，
        # 進出轎廂只走電梯狀態機的 micro-move（不經網格）。取轎廂為中心的 3×3 格，
        # 排隊格（cell-2-i）與全部出口候選點都在外面、維持可走（規則與 TS 相同）。
        for l in layout.get("lifts", []):
            x = l["cell"][0] + 0.5; z = l["cell"][1] + 0.5
            c0 = max(0, math.floor((x - 1.4) / cs)); c1 = min(cols - 1, math.ceil((x + 1.4) / cs) - 1)
            r0 = max(0, math.floor((z - 1.4) / cs)); r1 = min(rows - 1, math.ceil((z + 1.4) / cs) - 1)
            for r in range(r0, r1 + 1):
                base = r * cols
                for c in range(c0, c1 + 1):
                    cells[base + c] = 1

    if floor != 1:
        # 二樓（夾層）：footprint 之外全是障礙；footprint 內可走，再扣掉該樓層貨架（規則與 TS 相同）
        for i in range(len(cells)):
            cells[i] = 1
        fp = next((f.get("footprint") for f in layout.get("floors", []) if f["id"] == floor), None)
        if fp:
            xs = [p[0] for p in fp]; zs = [p[1] for p in fp]
            c0 = max(0, math.floor(min(xs) / cs)); c1 = min(cols - 1, math.ceil(max(xs) / cs) - 1)
            r0 = max(0, math.floor(min(zs) / cs)); r1 = min(rows - 1, math.ceil(max(zs) / cs) - 1)
            for r in range(r0, r1 + 1):
                base = r * cols
                for c in range(c0, c1 + 1):
                    cells[base + c] = 0
        for rk in layout["racks"]:
            if rk["blocks_grid"] and rk.get("floor", 1) == floor:
                x, _, z = rk["position"]; w, _, d = rk["size"]
                c0 = max(0, math.floor(x / cs)); c1 = min(cols - 1, math.ceil((x + w) / cs) - 1)
                r0 = max(0, math.floor(z / cs)); r1 = min(rows - 1, math.ceil((z + d) / cs) - 1)
                for r in range(r0, r1 + 1):
                    base = r * cols
                    for c in range(c0, c1 + 1):
                        cells[base + c] = 1
        block_lifts()
        return NavGrid(cols=cols, rows=rows, cells=cells)

    def fill_rect(x0: float, z0: float, x1: float, z1: float, v: int) -> None:
        c0 = max(0, math.floor(x0 / cs)); c1 = min(cols - 1, math.ceil(x1 / cs) - 1)
        r0 = max(0, math.floor(z0 / cs)); r1 = min(rows - 1, math.ceil(z1 / cs) - 1)
        for r in range(r0, r1 + 1):
            base = r * cols
            for c in range(c0, c1 + 1):
                cells[base + c] = v

    for w in layout["walkways"]:
        xs = [p[0] for p in w["polygon"]]; zs = [p[1] for p in w["polygon"]]
        fill_rect(min(xs), min(zs), max(xs), max(zs), 2)
    for r in layout["racks"]:
        if r["blocks_grid"] and r.get("floor", 1) == 1:
            x, _, z = r["position"]; w, _, d = r["size"]
            fill_rect(x, z, x + w, z + d, 1)
    for c in layout["conveyors"]:
        if c["blocks_grid"]:
            for i in range(len(c["path"]) - 1):
                (ax, az), (bx, bz) = c["path"][i], c["path"][i + 1]
                hw = c["width"] / 2
                fill_rect(min(ax, bx) - hw, min(az, bz) - hw, max(ax, bx) + hw, max(az, bz) + hw, 1)
    for ra in layout["restricted_areas"]:
        if not ra["robots_allowed"]:
            fill_rect(*ra["rect"], 1)
    for s in layout["stations"]:
        fill_rect(*s["rect"], 1)
    block_lifts()
    return NavGrid(cols=cols, rows=rows, cells=cells)
