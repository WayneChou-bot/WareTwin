"""引擎測試 — 與 frontend/tests/engine.test.ts 對應。"""
import json
from app.sim.navgrid import load_layout, build_nav_grid
from app.sim.astar import astar, to_cell, NavGrid
from app.sim.engine import SimEngine, mulberry32
from app.schema import TwinState

L = load_layout()


def test_prng_matches_js():
    r = mulberry32(7)
    assert [round(r(), 12) for _ in range(3)] == [0.011704753153, 0.061958257575, 0.976907632779]


def test_astar_path_valid():
    g = build_nav_grid(L)
    a = next(l for l in L["locations"] if l["id"] == "SHELF-A01")["access_point"]
    b = next(l for l in L["locations"] if l["id"] == "SHELF-D40")["access_point"]
    p = astar(g, to_cell(*a), to_cell(*b))
    assert p and len(p) > 50
    prev = to_cell(*a)
    for c, r in p:
        assert g.cells[r * g.cols + c] != 1
        assert max(abs(c - prev[0]), abs(r - prev[1])) == 1
        prev = (c, r)


def test_all_access_points_walkable():
    grids = {1: build_nav_grid(L), 2: build_nav_grid(L, 2)}
    for l in L["locations"]:
        g = grids[l.get("floor", 1)]
        c, r = to_cell(*l["access_point"])
        assert g.cells[r * g.cols + c] != 1, l["id"]


def test_astar_walled_goal_returns_none():
    cells = bytearray(25)
    for c, r in [(1, 1), (2, 1), (3, 1), (1, 2), (3, 2), (1, 3), (2, 3), (3, 3)]:
        cells[r * 5 + c] = 1
    assert astar(NavGrid(5, 5, cells), (0, 0), (2, 2)) is None


def test_20_minutes_no_collisions_and_schema_valid():
    """碰撞定義：兩台機器人中心距離 < 0.5 m（格點共用在斜向穿越時會短暫發生，不算碰撞）"""
    e = SimEngine(L, seed=7)
    min_d = 99.0
    for t in range(12000):
        e.step()
        if t % 10 == 0:
            rs = list(e.state["robots"].values())
            for r in rs:
                assert 0 <= r["battery"] <= 100
            for i in range(len(rs)):
                for j in range(i + 1, len(rs)):
                    if rs[i]["floor"] != rs[j]["floor"] or rs[i]["lift_id"] or rs[j]["lift_id"]:
                        continue   # 不同樓層的 2D 座標會重疊，物理間距只看同樓層
                    d = ((rs[i]["position"][0] - rs[j]["position"][0]) ** 2 + (rs[i]["position"][2] - rs[j]["position"][2]) ** 2) ** 0.5
                    min_d = min(min_d, d)
    assert e.state["kpi"]["operation"]["completed_today"] > 40
    assert min_d >= 0.5, min_d
    TwinState.model_validate(e.state)


def test_no_gridlock_under_compound_failure():
    """Demo 10：輸送帶故障 + 人員入侵 30 分鐘，吞吐不能歸零（deadlock breaker）"""
    e = SimEngine(L, seed=42)
    for _ in range(3000): e.step()
    e.inject({"kind": "CONVEYOR_FAILURE", "conveyor_id": "CV03"}); e.inject({"kind": "HUMAN_INTRUSION", "zone_id": "B", "duration_ticks": 2000})
    before = e.state["kpi"]["operation"]["completed_today"]
    for _ in range(18000): e.step()
    assert e.state["kpi"]["operation"]["completed_today"] - before > 120


def test_deterministic():
    a, b = SimEngine(L, seed=3), SimEngine(L, seed=3)
    for _ in range(3000):
        a.step(); b.step()
    assert json.dumps(a.state, sort_keys=True) == json.dumps(b.state, sort_keys=True)


def test_low_battery_transfer_and_charge():
    e = SimEngine(L, seed=1)
    for _ in range(600): e.step()
    busy = next(r for r in e.state["robots"].values() if r["fsm"] == "TRANSPORTING")
    e.inject({"kind": "ROBOT_BATTERY_SET", "robot_id": busy["id"], "battery": 12})
    seen = set()
    for _ in range(4000):
        e.step(); seen.add(e.state["robots"][busy["id"]]["fsm"])
    assert "TASK_TRANSFER" in seen or "CHARGING" in seen
    assert e.state["robots"][busy["id"]]["battery"] > 12


def test_human_intrusion_blocks_and_clears():
    e = SimEngine(L, seed=5)
    for _ in range(1500): e.step()
    e.inject({"kind": "HUMAN_INTRUSION", "zone_id": "B", "duration_ticks": 600})
    e.step(); e.step()
    assert e.state["zones"]["B"]["status"] == "BLOCKED"
    for _ in range(700): e.step()
    assert e.state["zones"]["B"]["status"] != "BLOCKED"


def test_cross_floor_task_rides_lift():
    """二樓貨架 → 一樓包裝站：機器人要搭電梯、樓層會切換、任務完成。"""
    from app.sim.navgrid import load_layout
    e = SimEngine(load_layout(), seed=7)
    t = e.create_task("PICK", "CRITICAL", "SHELF-M05", "PACK-01")
    boarded = False; floors = set()
    for _ in range(24000):
        e.step()
        if t["assigned_robot"]:
            r = e.state["robots"][t["assigned_robot"]]
            floors.add(r["floor"])
            if r["lift_id"]:
                boarded = True
        if t["status"] == "COMPLETED":
            break
    assert t["status"] == "COMPLETED" and boarded and floors == {1, 2}


def test_floor2_grid_matches_ts_rules():
    from app.sim.navgrid import build_nav_grid, load_layout
    g2 = build_nav_grid(load_layout(), 2)
    at = lambda x, z: g2.cells[int(z) * g2.cols + int(x)]
    assert at(51.5, 44.5) == 1   # 電梯井道 = 障礙（round-8：進出轎廂走 micro-move，不經網格）
    assert at(20.5, 47.5) != 1   # 夾層走道
    assert at(80, 20) == 1       # footprint 外


def test_pillars_blocked_and_charging_docks_on_pad():
    """round-9d：建築柱進 layout.obstacles 並封鎖網格；充電機器人必須正好停在充電板中央、朝樁、不重疊"""
    import math
    from app.sim.navgrid import build_nav_grid, load_layout
    from app.sim.engine import SimEngine
    L = load_layout()
    assert L.get("obstacles"), "layout.obstacles missing"
    g = build_nav_grid(L, 1)
    for o in L["obstacles"]:
        x0, z0, x1, z1 = o["rect"]
        for c in range(max(0, math.floor(x0)), min(g.cols, math.ceil(x1))):
            for r in range(max(0, math.floor(z0)), min(g.rows, math.ceil(z1))):
                assert g.cells[r * g.cols + c] == 1, f"{o['id']} cell ({c},{r}) not blocked"
        # 建築柱不得落在輸送帶上（round-9d 的視覺 bug：程序生成柱插在 CV01/CV02 上）
        # —— 只檢查 PILLAR：CONVEYOR_EQUIP（round-9f 端點機台）本來就位於輸送帶端點
        if o["kind"] != "PILLAR":
            continue
        cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
        for cv in L["conveyors"]:
            for (ax, az), (bx, bz) in zip(cv["path"], cv["path"][1:]):
                if min(ax, bx) - 0.5 <= cx <= max(ax, bx) + 0.5 and min(az, bz) - 0.5 <= cz <= max(az, bz) + 0.5:
                    raise AssertionError(f"{o['id']} sits on conveyor {cv['id']}")
    e = SimEngine(L, seed=3)
    for rid in list(e.state["robots"].keys())[:3]:
        e.inject({"kind": "ROBOT_BATTERY_SET", "robot_id": rid, "battery": 25})
    pads = [(c["position"][0], c["position"][2] - 1.9) for c in L["charging_stations"]]
    seen = set()
    for _ in range(20000):
        e.step()
        chg = [r for r in e.state["robots"].values() if r["fsm"] == "CHARGING"]
        for r in chg:
            d = min(math.hypot(r["position"][0] - p[0], r["position"][2] - p[1]) for p in pads)
            assert d < 0.05, f"{r['id']} not docked on a pad (d={d:.2f})"
            assert abs(r["heading"] - math.pi / 2) < 0.01, f"{r['id']} not facing the charger"
        for i in range(len(chg)):
            for j in range(i + 1, len(chg)):
                assert not SimEngine.obb_overlap(chg[i]["position"][0], chg[i]["position"][2], chg[i]["heading"],
                                                 chg[j]["position"][0], chg[j]["position"][2], chg[j]["heading"]), \
                    f"{chg[i]['id']} overlaps {chg[j]['id']} while charging"
        seen |= {r["id"] for r in chg}
        if len(chg) >= 2:   # round-9e：必須「同時」兩台在充 —— 進場走廊不被充電中的車擋住
            break
    assert len(seen) >= 2, "fewer than 2 robots ever charged"
    assert len(chg) >= 2, "second robot could not dock while first still charging (approach lane blocked)"

def test_conveyor_end_equipment_blocked_and_lanes_wide():
    """round-9f：端點機台 footprint 進 layout.obstacles 封鎖網格；直向輸送帶靠牆 ——
    貼牆 1–2 格窄道消失（機器人不再貼牆走），內側車道 ≥4 格寬；模擬中機器人不進任何機台/柱子範圍"""
    from app.sim.navgrid import build_nav_grid, load_layout
    from app.sim.engine import SimEngine
    L = load_layout()
    eq = [o for o in L["obstacles"] if o["kind"] == "CONVEYOR_EQUIP"]
    assert eq, "CONVEYOR_EQUIP obstacles missing"
    for cv in L["conveyors"]:   # 每條輸送帶兩端都要有機台 footprint（單一資料源：端點 ±1.5 m）
        for px, pz in (cv["path"][0], cv["path"][-1]):
            assert any(o["rect"][0] <= px <= o["rect"][2] and o["rect"][1] <= pz <= o["rect"][3] for o in eq), \
                f"{cv['id']} endpoint ({px},{pz}) has no CONVEYOR_EQUIP obstacle"
    g = build_nav_grid(L, 1)
    at = lambda c, r: g.cells[r * g.cols + c]
    for r in range(34, 61):     # 直向帶身：帶到牆之間全封（貼牆窄道不存在）
        assert at(0, r) == 1 and at(1, r) == 1, f"west wall strip row {r} not sealed"
        assert at(98, r) == 1 and at(99, r) == 1, f"east wall strip row {r} not sealed"
    for r in range(37, 58):     # 機台範圍外的帶身側：內側車道保持通暢（西 4 格、東 5 格）
        for c in (2, 3, 4, 5):
            assert at(c, r) != 1, f"west inner lane ({c},{r}) blocked"
        for c in (93, 94, 95, 96, 97):
            assert at(c, r) != 1, f"east inner lane ({c},{r}) blocked"
    for r in range(33, 37):     # 跨 z=35 的三處穿越口（西/中/東）都要通 —— 動線不得全擠進電梯廳前的中央走道
        for c in (*range(3, 8), *range(48, 52), *range(92, 97)):
            assert at(c, r) != 1, f"crossing cell ({c},{r}) blocked"
    e = SimEngine(L, seed=11)
    rects = [o["rect"] for o in L["obstacles"]]
    for _ in range(6000):
        e.step()
        for r in e.state["robots"].values():
            if r["floor"] != 1 or r["lift_id"]:
                continue
            x, z = r["position"][0], r["position"][2]
            for x0, z0, x1, z1 in rects:
                assert not (x0 + 0.1 < x < x1 - 0.1 and z0 + 0.1 < z < z1 - 0.1), \
                    f"{r['id']} inside obstacle at ({x:.2f},{z:.2f})"
