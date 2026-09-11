"""Phase 6：What-if — clone 確定性、LIVE 不受影響、scenario 有差異、endpoint 契約"""
import json
from fastapi.testclient import TestClient
from app.main import app, server
from app.sim.navgrid import load_layout
from app.sim.engine import SimEngine
from app.sim.whatif import run_whatif
from app.schema import WhatIfResult

L = load_layout()


def test_clone_is_deterministic_and_independent():
    e = SimEngine(L, seed=42)
    for _ in range(2000): e.step()
    snap = json.dumps(e.state, sort_keys=True)
    a, b = e.clone(), e.clone()
    for _ in range(1000): a.step(); b.step()
    assert json.dumps(a.state, sort_keys=True) == json.dumps(b.state, sort_keys=True)
    assert json.dumps(e.state, sort_keys=True) == snap           # LIVE 沒動
    assert a.state["sim"]["tick"] == e.state["sim"]["tick"] + 1000


def test_whatif_compound_scenario_hurts_task_time():
    e = SimEngine(L, seed=42)
    for _ in range(3000): e.step()
    r = run_whatif(e.clone(), e.clone(), {"injections": [{"kind": "CONVEYOR_FAILURE", "conveyor_id": "CV03"}, {"kind": "HUMAN_INTRUSION", "zone_id": "B", "duration_ticks": 900}, {"kind": "TASK_BURST", "count": 20, "priority": "HIGH"}], "duration_ticks": 3000}, e.state["sim"]["tick"])
    b, s = r["window"]["baseline"], r["window"]["scenario"]
    assert e.state["sim"]["tick"] == 3000
    assert s["avg_task_time_s"] > b["avg_task_time_s"] * 1.15
    # （吞吐不做斷言：TASK_BURST 會補進更多任務，完成數可能高於 baseline；核心指標是上面的平均任務時間變差）
    assert any(ev["type"] == "CONVEYOR_STATUS_CHANGED" for ev in r["key_events"])
    assert r["ai_recommendation"]
    WhatIfResult.model_validate(r)   # 完整結果必須符合共用契約（extra="forbid"：多一個欄位就會炸）


def test_whatif_ensemble_ranges_and_event_diff():
    """round-10 A1+A3：多 seed 區間（min≤median≤max、pair0 的 Δ 落在區間內）、事件流分岔可指認、整體可重現"""
    e = SimEngine(L, seed=7)
    for _ in range(1500): e.step()
    req = {"scenario_name": "cv03", "injections": [{"kind": "CONVEYOR_FAILURE", "conveyor_id": "CV03"}],
           "duration_ticks": 1200, "run_baseline": True, "ensemble_seeds": 3}

    def run_once():
        pairs = [(e.clone(), e.clone()) for _ in range(3)]
        return run_whatif(pairs[0][0], pairs[0][1], req, e.state["sim"]["tick"], extra_pairs=pairs[1:])

    r = run_once()
    ens = r["ensemble"]
    assert ens["seeds_run"] == 3 and r["request"]["ensemble_seeds"] == 3
    for k, rng in ens["delta_range"].items():
        assert rng["min"] <= rng["median"] <= rng["max"], k
        assert rng["min"] - 1e-9 <= r["delta"][k] <= rng["max"] + 1e-9, f"pair0 delta of {k} outside range"
    for k, rng in ens["scenario_range"].items():
        assert rng["min"] <= rng["median"] <= rng["max"], k
    # 重設 seed 必須真的產生不同的隨機流（否則所有 pair 相同、區間永遠塌成單點）
    assert any(rng["min"] != rng["max"] for rng in ens["scenario_range"].values()), "reseeding produced identical runs"
    # A3：按 tick 分組比對 —— 第一個分岔 tick 就是注入後第一步（輸送帶狀態事件），
    # 且該 tick 的 baseline 側必須是「無事件」（review P1：不可把後面 tick 的不相干事件配成對照）
    t0 = e.state["sim"]["tick"]
    ed = r["event_diff"]
    assert ed and ed["first_divergence"], "no divergence found for a conveyor failure"
    fd = ed["first_divergence"]
    assert fd["tick"] == t0 + 1, fd
    assert any(ev["type"] == "CONVEYOR_STATUS_CHANGED" for ev in fd["scenario"]), fd
    assert all(ev["tick"] == fd["tick"] for ev in fd["scenario"] + fd["baseline"]), "divergence events must share the divergence tick"
    assert fd["baseline"] == [], "baseline had no event at the injection tick; pairing anything here is the P1 bug"
    assert ed["complete"] is True and ed["compared_until_tick"] == t0 + 1200
    assert any(c["delta"] != 0 for c in ed["event_count_delta"])
    assert not any(c["type"] == "SCENARIO_INJECTED" for c in ed["event_count_delta"])
    WhatIfResult.model_validate(r)   # ensemble / event_diff / window 全部在共用契約內
    # 可重現：同 start_tick + 同 pair 序號 → 衍生 seed 相同 → 整份結果（去掉計時）逐位相同
    r2 = run_once()
    strip = lambda d: {k: v for k, v in d.items() if k != "compute_ms"}
    assert json.dumps(strip(r), sort_keys=True) == json.dumps(strip(r2), sort_keys=True)
    # 單 seed 路徑不受影響：不帶 ensemble 欄位、無 ensemble 結果
    r1 = run_whatif(e.clone(), e.clone(), {**req, "ensemble_seeds": 1}, t0)
    assert "ensemble" not in r1 and r1["request"]["ensemble_seeds"] == 1
    assert r1["event_diff"]["first_divergence"]           # A3 與 ensemble 無關，單 seed 也有
    # review P2：關掉 baseline 時仍要有 scenario_range（無 delta_range、無 event_diff）
    pairs = [(None, e.clone()) for _ in range(3)]
    r0 = run_whatif(None, pairs[0][1], {**req, "run_baseline": False}, t0, extra_pairs=pairs[1:])
    assert r0["ensemble"]["scenario_range"] and "delta_range" not in r0["ensemble"] and "event_diff" not in r0
    assert r0["delta"] == {}
    WhatIfResult.model_validate(r0)
    # 容量預算：seeds × duration ≤ 9000 → 5 seeds 時 6000 tick 被夾到 1800
    from app.sim.whatif import ensemble_duration_cap
    assert ensemble_duration_cap(1) == 6000 and ensemble_duration_cap(3) == 3000 and ensemble_duration_cap(5) == 1800


def test_whatif_busy_rejects_instead_of_queueing():
    """review 容量風險：同時只跑一個 What-if；忙碌時立即丟 WhatIfBusy（WS → ERROR BUSY、REST → 503），不排隊"""
    import asyncio
    import pytest
    from app.sim.whatif import WhatIfBusy

    class HeldLock:
        def locked(self): return True

    real = server._whatif_lock
    server._whatif_lock = HeldLock()   # type: ignore[assignment]
    try:
        with pytest.raises(WhatIfBusy):
            asyncio.run(server.run_whatif_safe({"injections": [], "duration_ticks": 100}))
    finally:
        server._whatif_lock = real


def test_whatif_endpoints():
    with TestClient(app) as client:
        body = {"scenario_name": "t", "injections": [{"kind": "ROBOT_FAILURE", "robot_id": "R07"}], "duration_ticks": 300, "run_baseline": True}
        r = client.post("/api/whatif", json=body); assert r.status_code == 200
        d = r.json(); assert "delta" in d and d["window"]["scenario"]["robots_offline"] == 1
        assert client.post("/api/whatif", json={"injections": [{"kind": "NOPE"}]}).status_code == 400
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "WHATIF_RUN", "request": body, "request_id": "w-test-1"})
            for _ in range(400):
                m = ws.receive_json()
                if m["type"] == "WHATIF_RESULT":
                    assert m["request_id"] == "w-test-1" and m["result"]["request"]["duration_ticks"] == 300; break
            else:
                raise AssertionError("no WHATIF_RESULT")
        server.paused = True
