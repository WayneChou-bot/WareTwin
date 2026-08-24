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
        # 進出轎廂只走電梯狀態機的 micro-move（不經網格）。
        # round-9g：井道 3D 外觀是 W 2.8 × D 3.6，x 封 ±1.4（3 格）夠用，z 若也只封 ±1.4
        # 會讓南北護網各突出 0.4 m 到可走格，貼著走的機器人會插進護網與角柱；
        # 故 z 封 ±1.9（5 格）。排隊格、門軸中繼格與出口候選點都在範圍外（規則與 TS 相同）。
        for l in layout.get("lifts", []):
            x = l["cell"][0] + 0.5; z = l["cell"][1] + 0.5
            c0 = max(0, math.floor((x - 1.4) / cs)); c1 = min(cols - 1, math.ceil((x + 1.4) / cs) - 1)
            r0 = max(0, math.floor((z - 1.9) / cs)); r1 = min(rows - 1, math.ceil((z + 1.9) / cs) - 1)
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
    # 夾層支撐柱（立在 F1 地面、撐到樓板）：以柱底板 0.9×0.9 m 封成障礙 —— 路徑必須繞柱，不能穿過
    for cx, cz in layout.get("columns", []):
        fill_rect(cx - 0.45, cz - 0.45, cx + 0.45, cz + 0.45, 1)
    # 建築結構柱等實體障礙（round-9d）：整塊封鎖 —— 原本只在 3D 場景程序生成，網格不知道，機器人會穿柱
    for o in layout.get("obstacles", []):
        fill_rect(o["rect"][0], o["rect"][1], o["rect"][2], o["rect"][3], 1)
    # 充電樁櫃體（round-9e）：櫃體是實體 —— 封格後通行走廊固定在停車排南側一格，不會有人從櫃體穿過
    for c in layout["charging_stations"]:
        fill_rect(c["position"][0] - 0.45, c["position"][2] - 0.4, c["position"][0] + 0.45, c["position"][2] + 0.5, 1)
    block_lifts()
    return NavGrid(cols=cols, rows=rows, cells=cells)
