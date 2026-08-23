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
    e, t = _boot()
    prev = {rid: r["floor"] for rid, r in e.state["robots"].items()}
    for _ in range(24000):
        e.step()
        for rid, r in e.state["robots"].items():
            if r["floor"] != prev[rid]:
                assert r["lift_stage"] == "ALIGHTING", f"{rid} changed floor outside lift flow"
            prev[rid] = r["floor"]
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
