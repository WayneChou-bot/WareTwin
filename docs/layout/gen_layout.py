"""
產生 warehouse_layout.json 範例。
執行：python gen_layout.py > warehouse_layout.json
座標：x 0..100 (長邊)、z 0..70 (短邊)，單位公尺。z=0 為「上方」(Inbound/Outbound 碼頭側)。
"""
import json

W, D = 100, 70
CELL = 1.0

layout = {
    "schema_version": "1.0",
    "id": "wh-main-v1",
    "name": "Main Warehouse (100x70m)",
    "units": "m",
    "size": {"width": W, "depth": D, "height": 12},
    "grid": {"cell_size": CELL, "cols": int(W / CELL), "rows": int(D / CELL)},
    "zones": [],
    "docks": [],
    "racks": [],
    "conveyors": [],
    "stations": [],
    "charging_stations": [],
    "parking": [],
    "restricted_areas": [],
    "walkways": [],
    "cameras": [],
    "sensors": [],
    "locations": [],
    "obstacles": [],
    "spawn": {"robots": []},
}

# ── Zones：四象限，保留中央走道 (x 46..54) 與中央輸送帶走廊 (z 32..38)
zones = {
    "A": (4, 10, 46, 32, "#3b82f6"),
    "B": (54, 10, 96, 32, "#a855f7"),
    "C": (4, 38, 46, 62, "#22c55e"),
    "D": (54, 38, 96, 62, "#f59e0b"),
}
for zid, (x0, z0, x1, z1, color) in zones.items():
    layout["zones"].append({
        "id": zid, "name": f"Zone {zid}", "color": color,
        "polygon": [[x0, z0], [x1, z0], [x1, z1], [x0, z1]],
    })

# ── Docks (上方)
layout["docks"] = [
    {"id": "INBOUND-1", "kind": "INBOUND", "zone": "A", "rect": [20, 0, 32, 8], "door": [26, 0]},
    {"id": "INBOUND-2", "kind": "INBOUND", "zone": "A", "rect": [34, 0, 46, 8], "door": [40, 0]},
    {"id": "OUTBOUND-1", "kind": "OUTBOUND", "zone": "B", "rect": [54, 0, 66, 8], "door": [60, 0]},
    {"id": "OUTBOUND-2", "kind": "OUTBOUND", "zone": "B", "rect": [68, 0, 80, 8], "door": [74, 0]},
]

# ── Racks：每 zone 4 排雙面貨架，每排 10 個 bay，走道 4 m
rack_len, rack_depth, aisle = 3.0, 1.2, 4.0
loc_id_counter = {}
for zid, (x0, z0, x1, z1, _) in zones.items():
    n_rows = 4
    for r in range(n_rows):
        z = z0 + 3 + r * (rack_depth + aisle)
        for b in range(10):
            x = x0 + 2 + b * (rack_len + 0.6)
            rid = f"RACK-{zid}{r+1:d}{b+1:02d}"
            layout["racks"].append({
                "id": rid, "zone": zid,
                "position": [x, 0, z], "size": [rack_len, 6.0, rack_depth],
                "rotation": 0, "levels": 4, "model": "rack_double",
                "blocks_grid": True,
            })
            # 每個 bay 兩側各一個可存取位置 (shelf location)，供任務 source/destination 使用
            for side, dz in (("N", -1.0), ("S", rack_depth + 1.0)):
                n = loc_id_counter.get(zid, 0) + 1
                loc_id_counter[zid] = n
                layout["locations"].append({
                    "id": f"SHELF-{zid}{n:02d}", "kind": "SHELF", "zone": zid,
                    "rack_id": rid, "level_range": [1, 4],
                    "access_point": [round(x + rack_len / 2, 1), round(z + dz, 1)],
                })

# ── Conveyors：中央橫向一條 + 左右各一條短的進 packing
layout["conveyors"] = [
    {"id": "CV01", "name": "Conveyor #01", "zone": "A",
     "path": [[10, 35], [46, 35]], "width": 1.0, "speed_mps": 0.6, "direction": "FORWARD", "blocks_grid": True, "feeds": "PACK-02"},
    {"id": "CV02", "name": "Conveyor #02", "zone": "B",
     "path": [[54, 35], [97.5, 35]], "width": 1.0, "speed_mps": 0.6, "direction": "FORWARD", "blocks_grid": True, "feeds": "SORT-01"},
    {"id": "CV03", "name": "Conveyor #03", "zone": "D",
     "path": [[97.5, 35], [97.5, 60]], "width": 1.0, "speed_mps": 0.6, "direction": "FORWARD", "blocks_grid": True, "feeds": "PACK-01"},
]

# ── Stations：Packing / Sorting
layout["stations"] = [
    {"id": "PACK-01", "kind": "PACKING", "zone": "D", "rect": [82, 62, 96, 68], "access_point": [89, 61]},
    {"id": "PACK-02", "kind": "PACKING", "zone": "C", "rect": [4, 62, 18, 68], "access_point": [11, 61]},
    {"id": "SORT-01", "kind": "SORTING", "zone": "B", "rect": [82, 0, 96, 8], "access_point": [89, 9]},
]
for s in layout["stations"]:
    layout["locations"].append({"id": s["id"], "kind": s["kind"], "zone": s["zone"],
                                "rack_id": None, "level_range": None, "access_point": s["access_point"]})
for d in layout["docks"]:
    layout["locations"].append({"id": d["id"], "kind": d["kind"], "zone": d["zone"],
                                "rack_id": None, "level_range": None,
                                "access_point": [(d["rect"][0] + d["rect"][2]) / 2, d["rect"][3] + 1]})

# ── Charging：下方左側 6 座
for i in range(6):
    x = 22 + i * 2.5
    layout["charging_stations"].append({
        "id": f"CHG-{i+1:02d}", "zone": "C", "position": [x, 0, 66], "heading": 3.14159,
        "power_kw": 3.0, "access_point": [x, 65],
    })
    layout["locations"].append({"id": f"CHG-{i+1:02d}", "kind": "CHARGING", "zone": "C",
                                "rack_id": None, "level_range": None, "access_point": [x, 65]})

# ── Parking：下方中間
layout["parking"] = [{"id": "PARK-1", "zone": "C", "rect": [40, 63, 60, 68], "slots": 10}]

# ── Restricted / Walkways
layout["restricted_areas"] = [
    {"id": "RESTRICT-1", "name": "Maintenance bay", "rect": [0, 0, 18, 8], "robots_allowed": False},
]
layout["walkways"] = [
    {"id": "WALK-1", "polygon": [[0, 8], [100, 8], [100, 10], [0, 10]], "robots_allowed": True, "speed_limit_mps": 0.8},
    {"id": "WALK-2", "polygon": [[46, 10], [54, 10], [54, 62], [46, 62]], "robots_allowed": True, "speed_limit_mps": 1.0},
]

# ── Cameras：每 zone 3 台，架在走道端點、沿走道方向看 (aisle z = z0+1.1 + row*5.2)
layout["cameras"] = []
for zid, (x0, z0, x1, z1, _) in zones.items():
    spots = [(x0 + 0.6, z0 + 1.1 + 1 * 5.2, +1), (x1 - 0.6, z0 + 1.1 + 2 * 5.2, -1), (x0 + 0.6, z0 + 1.1 + 3 * 5.2, +1)]
    for i, (x, z, d) in enumerate(spots, 1):
        layout["cameras"].append({
            "id": f"CAM-{zid}{i:02d}", "zone": zid, "position": [round(x, 1), 4.5, round(z, 1)],
            "look_at": [round(x + d * 18, 1), 0.5, round(z, 1)], "fov_deg": 65, "range_m": 30,
        })
layout["cameras"] += [
    {"id": "CAM-DOCK-IN", "zone": "A", "position": [33, 6, 2], "look_at": [33, 0, 12], "fov_deg": 80, "range_m": 20},
    {"id": "CAM-DOCK-OUT", "zone": "B", "position": [67, 6, 2], "look_at": [67, 0, 12], "fov_deg": 80, "range_m": 20},
]

# ── Sensors
layout["sensors"] = [
    {"id": "S-A01", "kind": "PRESENCE", "zone": "A", "position": [26, 1, 9]},
    {"id": "S-B01", "kind": "PRESENCE", "zone": "B", "position": [74, 1, 9]},
    {"id": "S-C01", "kind": "LIDAR", "zone": "C", "position": [50, 1, 50]},
    {"id": "S-D01", "kind": "LIDAR", "zone": "D", "position": [50, 1, 20]},
    {"id": "S-CV03", "kind": "WEIGHT", "zone": "D", "position": [97.5, 0.5, 48]},
    {"id": "S-T01", "kind": "TEMP", "zone": "A", "position": [5, 3, 12]},
]

# ── Robot spawn：20 台，從 parking 與 charging 出發
for i in range(20):
    x = 40 + (i % 10) * 2.0
    z = 64 + (i // 10) * 2.0
    layout["spawn"]["robots"].append({"id": f"R{i+1:02d}", "position": [x, 0, z], "heading": -1.5708, "battery": 70 + (i * 7) % 30})

print(json.dumps(layout, ensure_ascii=False, indent=2))
