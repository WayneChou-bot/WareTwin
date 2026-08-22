"""測試一律在「沒有 OpenAI key」的環境下跑（rule-based / simulated 路徑），本機 .env 有 key 也不會真的呼叫 API。"""
import os
import pytest


@pytest.fixture(autouse=True)
def _no_openai_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    yield


@pytest.fixture(autouse=True)
def _guard_defaults(monkeypatch):
    """測試預設關閉 rate limit、Origin 不限制（個別測試再打開）。"""
    from app.guard import limiter
    monkeypatch.setenv("TWIN_RATE_LIMIT", "0")
    monkeypatch.delenv("TWIN_CORS_ORIGINS", raising=False)
    monkeypatch.delenv("TWIN_CORS_REGEX", raising=False)
    limiter.reset()
    yield
    limiter.reset()
