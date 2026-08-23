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
    assert at(51.5, 44.5) != 1   # 電梯格
    assert at(20.5, 47.5) != 1   # 夾層走道
    assert at(80, 20) == 1       # footprint 外
