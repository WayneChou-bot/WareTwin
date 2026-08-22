"""SQLite 事件 / KPI 持久層（第一版；之後換 PostgreSQL 只需改這個檔）。"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable


class TwinDB:
    def __init__(self, path: str | Path = "twin.db") -> None:
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, id TEXT, tick INTEGER, type TEXT, source TEXT, severity TEXT,
              message TEXT, robot_id TEXT, task_id TEXT, zone_id TEXT, conveyor_id TEXT, camera_id TEXT, payload TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_events_run_tick ON events(run_id, tick);
            CREATE TABLE IF NOT EXISTS kpi_snapshots (run_id TEXT, tick INTEGER, kpi TEXT, PRIMARY KEY(run_id, tick));
            CREATE TABLE IF NOT EXISTS decisions (run_id TEXT, id TEXT, tick INTEGER, decision TEXT, PRIMARY KEY(run_id, id));
            """
        )

    def insert_events(self, run_id: str, events: Iterable[dict[str, Any]]) -> None:
        rows = [(run_id, e["id"], e["tick"], e["type"], e["source"], e["severity"], e["message"], e.get("robot_id"), e.get("task_id"),
                 e.get("zone_id"), e.get("conveyor_id"), e.get("camera_id"), json.dumps(e.get("payload")) if e.get("payload") else None) for e in events]
        if rows:
            self.conn.executemany("INSERT INTO events(run_id,id,tick,type,source,severity,message,robot_id,task_id,zone_id,conveyor_id,camera_id,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            self.conn.commit()

    def insert_kpi(self, run_id: str, tick: int, kpi: dict[str, Any]) -> None:
        self.conn.execute("INSERT OR REPLACE INTO kpi_snapshots(run_id,tick,kpi) VALUES(?,?,?)", (run_id, tick, json.dumps(kpi)))
        self.conn.commit()

    def insert_decisions(self, run_id: str, decisions: Iterable[dict[str, Any]]) -> None:
        rows = [(run_id, d["id"], d["tick"], json.dumps(d)) for d in decisions]
        if rows:
            self.conn.executemany("INSERT OR IGNORE INTO decisions(run_id,id,tick,decision) VALUES(?,?,?,?)", rows)
            self.conn.commit()

    def query_events(self, run_id: str, limit: int = 200, types: list[str] | None = None, severity: list[str] | None = None,
                     robot_id: str | None = None, zone_id: str | None = None, since_tick: int | None = None) -> list[dict[str, Any]]:
        q = "SELECT id,tick,type,source,severity,message,robot_id,task_id,zone_id,conveyor_id,camera_id,payload FROM events WHERE run_id=?"
        args: list[Any] = [run_id]
        if types:
            q += f" AND type IN ({','.join('?' * len(types))})"; args += types
        if severity:
            q += f" AND severity IN ({','.join('?' * len(severity))})"; args += severity
        if robot_id:
            q += " AND robot_id=?"; args.append(robot_id)
        if zone_id:
            q += " AND zone_id=?"; args.append(zone_id)
        if since_tick is not None:
            q += " AND tick>=?"; args.append(since_tick)
        q += " ORDER BY seq DESC LIMIT ?"; args.append(limit)
        cols = ["id", "tick", "type", "source", "severity", "message", "robot_id", "task_id", "zone_id", "conveyor_id", "camera_id", "payload"]
        out = []
        for row in self.conn.execute(q, args):
            d = {c: v for c, v in zip(cols, row) if v is not None}
            if "payload" in d:
                d["payload"] = json.loads(d["payload"])
            out.append(d)
        return out

    def close(self) -> None:
        self.conn.close()
