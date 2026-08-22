"""
公開 Demo 的防護層（第 2 批 review 修正）

  - Origin 檢查：設定了 TWIN_CORS_ORIGINS / TWIN_CORS_REGEX 時，WebSocket 與會改變狀態的 POST
    必須帶允許的 Origin（瀏覽器一定會帶；curl 沒帶 → 拒絕，除非 TWIN_ALLOW_NO_ORIGIN=1）。
    沒設定（本機開發，預設 "*"）則不檢查。
  - Rate limit：記憶體內的 sliding window，依 client IP（Render 之後走 X-Forwarded-For）分桶：
        mutate  注入 / 清除 / 建任務 / 播放暫停重置      20 次 / 分鐘
        ai      Copilot / VLM                           10 次 / 分鐘
        whatif  What-if                                  4 次 / 分鐘
        ws      每條 WebSocket 的訊息總量                120 次 / 分鐘
    TWIN_RATE_LIMIT=0 可關閉（測試／本機）。
  - Body 大小上限：REST 512 KB（在 ASGI receive 層以實際 bytes 計算）、WS 單則訊息 64 KB（UTF-8 bytes）。
  - 任務地點：由 app/sim/rules.py 驗證（存在、非充電樁、不相同、符合 TaskType）。
"""
from __future__ import annotations

import os
import re
import time
from collections import defaultdict, deque
from typing import Deque

MAX_BODY_BYTES = 512 * 1024
MAX_WS_MESSAGE_BYTES = 64 * 1024

LIMITS: dict[str, tuple[int, float]] = {   # bucket → (max calls, window seconds)
    "mutate": (20, 60.0),
    "ai": (10, 60.0),
    "whatif": (4, 60.0),
    "ws": (120, 60.0),
}


def rate_limit_enabled() -> bool:
    return os.environ.get("TWIN_RATE_LIMIT", "1") != "0"


class RateLimiter:
    GC_EVERY = 500   # 每 N 次 check 掃一次過期 key，避免大量不同 IP 永久留在記憶體

    def __init__(self) -> None:
        self._hits: dict[tuple[str, str], Deque[float]] = defaultdict(deque)
        self._calls = 0

    def _gc(self, now: float) -> None:
        dead = [k for k, q in self._hits.items() if not q or now - q[-1] > LIMITS[k[0]][1]]
        for k in dead:
            del self._hits[k]

    def check(self, bucket: str, key: str) -> tuple[bool, float]:
        """回傳 (允許?, 需等待秒數)。"""
        if not rate_limit_enabled():
            return True, 0.0
        limit, window = LIMITS[bucket]
        now = time.monotonic()
        self._calls += 1
        if self._calls % self.GC_EVERY == 0:
            self._gc(now)
        q = self._hits[(bucket, key)]
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= limit:
            return False, round(window - (now - q[0]), 1) if q else window
        q.append(now)
        return True, 0.0

    def reset(self) -> None:
        self._hits.clear()


limiter = RateLimiter()


def client_key(headers: dict[str, str] | None, host: str | None) -> str:
    """反向代理（Render）會把真實 client IP **附加**到 X-Forwarded-For 尾端，client 自己塞的假值在前面；
    所以要取「倒數第 TWIN_TRUSTED_PROXIES 個」（預設 1 = 最後一段，即 proxy 親眼看到的連線）。
    TWIN_TRUSTED_PROXIES=0 = 不信任 header，直接用連線來源（本機開發）。"""
    h = {k.lower(): v for k, v in (headers or {}).items()}
    n = int(os.environ.get("TWIN_TRUSTED_PROXIES", "1"))
    xff = h.get("x-forwarded-for")
    if xff and n > 0:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-n] if len(parts) >= n else parts[0]
    return host or "unknown"


def _allowed_origins() -> tuple[list[str], re.Pattern[str] | None, bool]:
    raw = os.environ.get("TWIN_CORS_ORIGINS", "*")
    origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    regex = os.environ.get("TWIN_CORS_REGEX") or None
    open_ = "*" in origins and not regex
    return origins, re.compile(regex) if regex else None, open_


def origin_allowed(origin: str | None) -> bool:
    origins, regex, open_ = _allowed_origins()
    if open_:
        return True
    if not origin:
        return os.environ.get("TWIN_ALLOW_NO_ORIGIN", "0") == "1"
    o = origin.rstrip("/")
    if o in origins:
        return True
    return bool(regex and regex.fullmatch(o))
