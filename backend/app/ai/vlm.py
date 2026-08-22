"""
VLM Perception（規格 1️⃣4️⃣）：Virtual CCTV 畫面 → 視覺語言模型 → 結構化觀察

  POST /api/vlm/observe {camera_id, image_b64}  →  VlmObservation {event, zone, severity, blocked, confidence, bbox?}

- 有 OPENAI_API_KEY：送 gpt-4o-mini（vision）並強制 JSON schema。
- 沒有 key：simulated_observation() 用引擎的 ground truth（攝影機視野內有沒有人）產生觀察，標記 raw="simulated"。
- VLM 的結果只「記錄」（cameras[id].last_observation + VLM_OBSERVATION 事件）。
  是否根據 VLM 封鎖 Zone 由 TWIN_VLM_ACTS=1 控制（預設關閉，避免誤判干擾模擬）。
"""
from __future__ import annotations

import json
import os
from typing import Any

from .context import robots_near

SYSTEM_PROMPT = """You are a safety perception model watching a CCTV frame from inside an automated warehouse.
The scene is a 3D simulation: orange rack shelving with cardboard boxes, grey floor with yellow lane lines, small white/black autonomous mobile robots (AMRs) about 1.3 m long, conveyors, and occasionally a human worker wearing a yellow/green hi-vis vest and a yellow hard hat.
Decide whether a HUMAN is visible in the robot operating area. Robots are NOT humans. Boxes are NOT humans.
Return: event = human_detected | obstacle | spill | none; severity = INFO|LOW|MEDIUM|HIGH|CRITICAL (human in aisle = HIGH); blocked = true if the aisle should be closed to robots; confidence 0-1; bbox = normalized [x, y, w, h] of the most important detection or null; description = one short sentence."""

OBS_SCHEMA = {
    "name": "vlm_observation",
    "schema": {
        "type": "object",
        "properties": {
            "event": {"type": "string", "enum": ["human_detected", "obstacle", "spill", "none"]},
            "severity": {"type": "string", "enum": ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]},
            "blocked": {"type": "boolean"},
            "confidence": {"type": "number"},
            "bbox": {"type": ["array", "null"], "items": {"type": "number"}},
            "description": {"type": "string"},
        },
        "required": ["event", "severity", "blocked", "confidence", "bbox", "description"],
        "additionalProperties": False,
    },
    "strict": True,
}


def _client():
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return None
    try:
        from openai import OpenAI
        return OpenAI(api_key=key, base_url=os.environ.get("OPENAI_BASE_URL") or None, timeout=30)
    except Exception:
        return None


def observe_llm(camera_id: str, zone: str, image_b64: str, hint: dict[str, Any]) -> dict[str, Any] | None:
    client = _client()
    if client is None:
        return None
    model = os.environ.get("OPENAI_VISION_MODEL", os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))
    if not image_b64.startswith("data:"):
        image_b64 = "data:image/jpeg;base64," + image_b64
    resp = client.chat.completions.create(
        model=model, temperature=0,
        response_format={"type": "json_schema", "json_schema": OBS_SCHEMA},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": f"Camera {camera_id}, Zone {zone}. Telemetry hint (may be stale): {json.dumps(hint)}. Analyse the frame."},
                {"type": "image_url", "image_url": {"url": image_b64, "detail": "low"}},
            ]},
        ],
    )
    data = json.loads(resp.choices[0].message.content or "{}")
    data["raw"] = f"{model}: {data.get('description', '')}"
    return data


def simulated_observation(camera_id: str, S: dict[str, Any], layout: dict[str, Any]) -> dict[str, Any]:
    """沒有 VLM 時，用 ground truth 模擬（加一點保守的信心值），讓 Demo 03 流程完整。"""
    near = robots_near(S, layout, camera_id)
    people = near.get("people_in_range", [])
    if people:
        return {"event": "human_detected", "severity": "HIGH", "blocked": True, "confidence": 0.92, "bbox": [0.42, 0.35, 0.12, 0.3], "description": f"Worker visible in aisle ({people[0]})", "raw": "simulated"}
    return {"event": "none", "severity": "INFO", "blocked": False, "confidence": 0.97, "bbox": None, "description": f"{len(near.get('robots_in_range', []))} robots, no humans", "raw": "simulated"}


def observe(camera_id: str, image_b64: str | None, S: dict[str, Any], layout: dict[str, Any]) -> dict[str, Any]:
    cam = next((c for c in layout["cameras"] if c["id"] == camera_id), None)
    zone = cam["zone"] if cam else "?"
    hint = robots_near(S, layout, camera_id)
    hint.pop("people_in_range", None)  # 不要把答案洩漏給 VLM
    result = None
    if image_b64:
        try:
            result = observe_llm(camera_id, zone, image_b64, hint)
        except Exception as e:
            result = simulated_observation(camera_id, S, layout)
            result["raw"] = f"simulated (LLM error: {type(e).__name__})"
    if result is None:
        result = simulated_observation(camera_id, S, layout)
    obs = {"tick": S["sim"]["tick"], "camera_id": camera_id, "event": result["event"], "zone": zone, "severity": result["severity"],
           "blocked": bool(result["blocked"]), "confidence": float(result["confidence"]), "raw": result.get("raw")}
    obs["bbox"] = result.get("bbox")
    obs["description"] = result.get("description", "")
    return obs
