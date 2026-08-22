"""測試一律在「沒有 OpenAI key」的環境下跑（rule-based / simulated 路徑），本機 .env 有 key 也不會真的呼叫 API。"""
import os
import pytest


@pytest.fixture(autouse=True)
def _no_openai_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    yield
