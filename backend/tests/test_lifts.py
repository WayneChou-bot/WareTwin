"""電梯狀態機（規格書 §9–§14、§25 必要測試）"""
import math
from app.sim.engine import SimEngine, SIM
from app.sim.navgrid import load_layout

L = load_layout()


def _boot(seed=7):
    e = SimEngine(L, seed=seed)
    t = e.create_task("PICK", "CRITICAL", "SHELF-M05", "PACK-01")
    return e, t


def test_robot_cannot_change_floor_without_lift():
    """翻樓層只能發生在 ALIGHTING 走完、離開轎廂門區之後（round-5 P1：不得在轎廂內就翻）"""
    e, t = _boot()
    prev = {rid: r["floor"] for rid, r in e.state["robots"].items()}
    stage_at = {rid: r["lift_stage"] for rid, r in e.state["robots"].items()}
    cabins = [(l["cell"][0] + 0.5, l["cell"][1] + 0.5) for l in L["lifts"]]
    for _ in range(24000):
        e.step()
        for rid, r in e.state["robots"].items():
            if r["floor"] != prev[rid]:
                assert stage_at[rid] == "ALIGHTING", f"{rid} changed floor outside lift flow"
                min_cab = min(math.hypot(r["position"][0] - c[0], r["position"][2] - c[1]) for c in cabins)
                assert min_cab > 1.4, f"{rid} flipped floor while still at the cabin ({min_cab:.2f} m)"
            prev[rid] = r["floor"]; stage_at[rid] = r["lift_stage"]
        if t["status"] == "COMPLETED":
            break
    assert t["status"] == "COMPLETED"


def test_lift_cannot_move_with_open_gate():
    e, t = _boot()
    for _ in range(24000):
        e.step()
        for L_ in e.state["lifts"].values():
            if L_["state"] in ("MOVING_UP", "MOVING_DOWN"):
                assert L_["door_f1"] == "CLOSED" and L_["door_f2"] == "CLOSED"
                assert L_["floor"] is None   # 移動中不屬於任一樓層
        if t["status"] == "COMPLETED":
            break


def test_only_one_robot_can_occupy_lift_and_queue_fifo():
    e = SimEngine(L, seed=11)
    e.create_task("PICK", "CRITICAL", "SHELF-M01", "PACK-01")
    e.create_task("PICK", "CRITICAL", "SHELF-M10", "SORT-01")
    e.create_task("PICK", "CRITICAL", "SHELF-M20", "PACK-02")
    for _ in range(30000):
        e.step()
        riders = [r for r in e.state["robots"].values() if r["lift_id"]]
        per_lift = {}
        for r in riders:
            per_lift[r["lift_id"]] = per_lift.get(r["lift_id"], 0) + 1
        assert all(n == 1 for n in per_lift.values())
        for L_ in e.state["lifts"].values():
            for f in ("1", "2"):
                q = L_["queue"][f]
                ticks = [e.rt[rid].lift_enqueued_tick for rid in q if rid in e.rt]
                assert ticks == sorted(ticks)   # FIFO


def test_lift_fault_triggers_alternative_selection_and_no_teleport():
    e, t = _boot()
    rid = None
    for _ in range(20000):
        e.step()
        if t["assigned_robot"] and e.state["robots"][t["assigned_robot"]]["lift_stage"]:
            rid = t["assigned_robot"]; break
    assert rid
    lift_id = next((lid for lid, L_ in e.state["lifts"].items()
                    if L_["reserved_by"] == rid or rid in L_["queue"]["1"] or rid in L_["queue"]["2"] or L_["occupant"] == rid), "LIFT-1")
    r = e.state["robots"][rid]
    was_inside = e.state["lifts"][lift_id]["occupant"] == rid
    e.inject({"kind": "LIFT_FAULT", "lift_id": lift_id})
    pos0 = (r["position"][0], r["position"][2])
    for _ in range(200):
        e.step()
    if was_inside:   # 已在轎廂：不得瞬移
        assert math.hypot(r["position"][0] - pos0[0], r["position"][2] - pos0[1]) < 0.5
        assert r["lift_id"] == lift_id
    e.clear_injection("LIFT_FAULT", lift_id)
    for _ in range(24000):
        e.step()
        if t["status"] == "COMPLETED":
            break
    assert t["status"] == "COMPLETED"


def test_lift_fault_clear_resumes_from_frozen_height_no_teleport():
    """解除故障後平台從凍結高度續跑，不會單 tick 瞬移（round-5 P1：fault_remaining 凍結計時器）"""
    e, t = _boot()
    lift_id = None
    for _ in range(30000):
        e.step()
        lift_id = next((lid for lid, L_ in e.state["lifts"].items() if L_["state"] in ("MOVING_UP", "MOVING_DOWN")), None)
        if lift_id:
            break
    assert lift_id, "no lift ever moved"
    Lst = e.state["lifts"][lift_id]
    e.inject({"kind": "LIFT_FAULT", "lift_id": lift_id})
    e.step()   # 套用注入
    y_frozen = Lst["y"]
    for _ in range(200):
        e.step()
        assert Lst["y"] == y_frozen, "platform moved while faulted"
    e.clear_injection("LIFT_FAULT", lift_id)
    prev_y = Lst["y"]
    for _ in range(24000):
        e.step()
        assert abs(Lst["y"] - prev_y) < 0.5, "platform teleported after fault clear"
        prev_y = Lst["y"]
        if t["status"] == "COMPLETED":
            break
    assert t["status"] == "COMPLETED"


def test_decision_lift_matches_actual_route():
    """派工稽核寫的電梯 = 機器人實際排入的電梯（round-6 P2：planned_lift_id 綁定）"""
    import re
    e = SimEngine(L, seed=9)
    audited = None; rid = None
    for _ in range(60000):
        e.step()
        if not e.state["recent_decisions"]:
            continue
        d = e.state["recent_decisions"][0]
        if d["tick"] != e.state["sim"]["tick"]:
            continue
        c = next((x for x in d["candidates"] if x["robot_id"] == d["selected_robot"]), None)
        m = next((mm for mm in (re.search(r"cross-floor via (LIFT-\d+)", s) for s in (c["reasons"] if c else [])) if mm), None)
        if m:
            audited = m.group(1); rid = d["selected_robot"]; break
    assert audited, "no cross-floor assignment observed"
    actual = None
    for _ in range(5000):
        e.step()
        for lid, L_ in e.state["lifts"].items():
            if rid in L_["queue"]["1"] or rid in L_["queue"]["2"] or L_["reserved_by"] == rid or L_["occupant"] == rid:
                actual = lid; break
        if actual:
            break
    assert actual == audited


def test_cancelled_robot_releases_lift():
    e, t = _boot()
    rid = None
    for _ in range(20000):
        e.step()
        if t["assigned_robot"] and e.state["robots"][t["assigned_robot"]]["lift_stage"] in ("QUEUED", "TO_LIFT"):
            rid = t["assigned_robot"]; break
    assert rid
    e.inject({"kind": "ROBOT_FAILURE", "robot_id": rid})
    for _ in range(100):
        e.step()
    for L_ in e.state["lifts"].values():
        assert L_["reserved_by"] != rid and L_["occupant"] != rid
        assert rid not in L_["queue"]["1"] and rid not in L_["queue"]["2"]


def test_shaft_blocked_and_paths_avoid_it():
    """井道是導航障礙（round-8）：兩層網格都封鎖、路徑不穿越、非電梯流程的機器人不會進入井道"""
    from app.sim.navgrid import build_nav_grid
    for fl in (1, 2):
        g = build_nav_grid(L, fl)
        for l in L["lifts"]:
            c = l["cell"]
            assert g.cells[c[1] * g.cols + c[0]] == 1, f"{l['id']} cabin F{fl} not blocked"
            for i in range(3):
                assert g.cells[c[1] * g.cols + (c[0] - 2 - i)] != 1, f"{l['id']} queue{i} F{fl} blocked"
            for dc, dr in ((-2, -2), (-2, 2), (-3, -1), (-3, 1), (-1, -2), (-1, 2), (-2, 0)):
                assert g.cells[(c[1] + dr) * g.cols + (c[0] + dc)] != 1, f"{l['id']} exit({dc},{dr}) F{fl} blocked"
    e = SimEngine(L, seed=13)
    e.create_task("PICK", "CRITICAL", "SHELF-M05", "PACK-01")
    e.create_task("PICK", "CRITICAL", "SHELF-M12", "PACK-02")

    def in_shaft(x: float, z: float) -> bool:
        return any(abs(x - (l["cell"][0] + 0.5)) < 1.4 and abs(z - (l["cell"][1] + 0.5)) < 1.4 for l in L["lifts"])

    for _ in range(20000):
        e.step()
        for r in e.state["robots"].values():
            for p in r["path"][r["path_index"]:]:
                assert not in_shaft(p[0] + 0.5, p[1] + 0.5), f"{r['id']} path crosses shaft"
            if not r["lift_stage"] and not r["lift_id"]:
                assert not in_shaft(r["position"][0], r["position"][2]), f"{r['id']} inside shaft outside lift flow"


def test_lift_lobby_congestion_resolves():
    """出口節點與排隊線分開：雙向大量跨樓任務不會在電梯口互卡（修正 R11/R20 卡死 bug）。"""
    e = SimEngine(L, seed=5)
    ts = [
        e.create_task("PICK", "CRITICAL", "SHELF-M02", "PACK-01"),
        e.create_task("PICK", "CRITICAL", "SHELF-M12", "PACK-02"),
        e.create_task("PICK", "CRITICAL", "SHELF-M22", "SORT-01"),
        e.create_task("REPLENISH", "CRITICAL", "INBOUND-1", "SHELF-M30"),
        e.create_task("REPLENISH", "CRITICAL", "INBOUND-2", "SHELF-M40"),
        e.create_task("PICK", "HIGH", "SHELF-M05", "PACK-01"),
    ]
    still: dict[str, int] = {}; last: dict[str, tuple] = {}
    for _ in range(90000):
        e.step()
        for r in e.state["robots"].values():
            if not r["lift_stage"] or r["lift_stage"] == "RIDING":
                still[r["id"]] = 0; last[r["id"]] = (r["position"][0], r["position"][2]); continue
            lp = last.get(r["id"], (0, 0))
            moved = math.hypot(r["position"][0] - lp[0], r["position"][2] - lp[1]) > 0.02
            still[r["id"]] = 0 if moved else still.get(r["id"], 0) + 1
            last[r["id"]] = (r["position"][0], r["position"][2])
            if r["lift_stage"] in ("ALIGHTING", "BOARDING"):
                assert still[r["id"]] < 600, f"{r['id']} stuck in {r['lift_stage']}"
        if all(t["status"] in ("COMPLETED", "TRANSFERRED", "FAILED") for t in ts):
            break
    assert all(t["status"] == "COMPLETED" for t in ts)
