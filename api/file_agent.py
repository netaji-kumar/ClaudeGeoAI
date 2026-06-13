"""
file_agent.py — Claude Vision-based geometry extractor for GeoAI.

Accepts image (PNG/JPG/WEBP/GIF) or PDF uploads.
Uses claude-sonnet-4-6 to identify geographic coordinates and plot boundaries.
Yields the same SSE event dicts as run_agent_stream:
  { type: "status",     text: "…" }
  { type: "text_delta", text: "…" }
  { type: "result",     data: { results: [result_entry] } }
"""

import base64
import json
import logging
import os
import re
import sys
from typing import Generator

import anthropic
from dotenv import load_dotenv

load_dotenv()

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
for _p in (_HERE, _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

logger = logging.getLogger(__name__)

_EXTRACTION_PROMPT = """You are a GIS analyst. Carefully examine the uploaded document or image and extract every geographic feature you can identify.

Look for:
- Latitude/longitude coordinates in any format (decimal, DMS, annotated on a map)
- Plot/parcel/polygon boundaries with corner coordinates
- Tables that contain location fields (lat, lon, northing, easting, coordinates, ring)
- Points of interest with an address or coordinate label
- Any map that shows geographic extents with a grid or labels

Return your answer ONLY as a raw JSON object — no markdown fences, no explanation outside the JSON:
{
  "features": [
    {
      "name": "Unique feature name or identifier",
      "type": "Point" or "Polygon",
      "coordinates": [[lon, lat]] for a Point  OR  [[lon1,lat1],[lon2,lat2],...,[lon1,lat1]] for a closed Polygon ring,
      "attributes": { "key": "value" }
    }
  ],
  "summary": "One sentence describing what geographic content was found"
}

Rules:
- All coordinates MUST be [longitude, latitude] in WGS84 decimal degrees.
- For a Point use [[lon, lat]] (array containing one [lon,lat] pair).
- For a Polygon the ring must be closed (last point == first point).
- If you see place names or addresses without explicit coordinates, use your geographic knowledge to estimate WGS84 coordinates.
- If a polygon ring is listed as rows in a table, reconstruct it in order.
- Never omit features — if you are unsure of exact coordinates, provide your best estimate.
- If truly no geographic content exists, return {"features": [], "summary": "No geographic data found"}.
"""


def _get_client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))


def run_file_agent_stream(
    file_bytes: bytes,
    media_type: str,
    user_message: str = "Extract all geometries and show them on the map",
) -> Generator[dict, None, None]:
    """
    Analyze an uploaded file with Claude Vision / document support.
    media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/pdf"
    """
    yield {"type": "status", "text": "Analyzing uploaded file…"}

    client = _get_client()
    model  = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")
    b64    = base64.standard_b64encode(file_bytes).decode("utf-8")

    # Build content block
    if media_type == "application/pdf":
        file_block: dict = {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": b64},
        }
    else:
        file_block = {
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": b64},
        }

    messages = [{
        "role": "user",
        "content": [
            file_block,
            {"type": "text", "text": _EXTRACTION_PROMPT + f"\n\nUser request: {user_message}"},
        ],
    }]

    yield {"type": "status", "text": "Extracting geographic features…"}

    raw_response = ""
    try:
        with client.messages.stream(
            model=model,
            max_tokens=2000,
            messages=messages,
        ) as stream:
            for chunk in stream.text_stream:
                raw_response += chunk
    except Exception as exc:
        logger.error("File agent error: %s", exc)
        yield {"type": "error", "text": f"Failed to analyze file: {exc}"}
        return

    features_data = _parse_extraction(raw_response)
    processed     = _to_attributes(features_data.get("features", []))
    summary       = features_data.get("summary", "")

    if not processed:
        prose = f"No geographic features could be extracted from the uploaded file. {summary}"
        yield {"type": "text_delta", "text": prose}
        yield {
            "type": "result",
            "data": {"results": [{
                "description":   prose,
                "message":       prose,
                "attributes":    [],
                "tool_executed": True,
            }]},
        }
        return

    count = len(processed)
    prose = (
        f"Found **{count} geographic feature{'s' if count != 1 else ''}** in the uploaded file. "
        f"{summary}"
    )
    yield {"type": "text_delta", "text": prose}
    yield {
        "type": "result",
        "data": {"results": [{
            "description":   prose,
            "message":       prose,
            "attributes":    processed,
            "tool_executed": True,
            "from_file":     True,
        }]},
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_extraction(raw: str) -> dict:
    """Strip markdown fences and parse the JSON object from Claude's response."""
    text = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
    start = text.find("{")
    end   = text.rfind("}") + 1
    if start == -1 or end == 0:
        logger.warning("No JSON object found in file agent response")
        return {"features": [], "summary": "Could not parse response"}
    try:
        return json.loads(text[start:end])
    except json.JSONDecodeError as e:
        logger.warning("JSON parse error: %s", e)
        return {"features": [], "summary": "Malformed JSON in response"}


def _to_attributes(features: list) -> list:
    """
    Convert Claude's extracted features to the GeoAI frontend attribute format:
      { id, Name, Type, ...attrs, coordinates: [[lon,lat]|[ring]], geometryType }
    """
    result = []
    for i, f in enumerate(features):
        raw_coords = f.get("coordinates", [])
        ftype      = str(f.get("type", "Point"))
        attrs      = dict(f.get("attributes") or {})
        name       = f.get("name") or f"Feature {i + 1}"

        if not raw_coords:
            continue

        try:
            if ftype == "Point":
                # Accept [[lon,lat]] or [lon,lat]
                if isinstance(raw_coords[0], (int, float)):
                    coords = [list(raw_coords)]
                else:
                    coords = [list(raw_coords[0])]
            else:
                # Polygon — list of [lon,lat] pairs
                if raw_coords and isinstance(raw_coords[0][0], list):
                    coords = raw_coords   # already [[ring]]
                else:
                    coords = [raw_coords]  # wrap single ring

            # Basic sanity check
            sample = coords[0] if ftype == "Point" else coords[0][0]
            float(sample[0]), float(sample[1])
        except (TypeError, IndexError, ValueError, KeyError):
            logger.warning("Skipping feature %s — bad coordinates: %s", name, raw_coords)
            continue

        record = {
            "id":           i + 1,
            "Name":         name,
            "Type":         ftype,
            **attrs,
            "coordinates":  coords,
            "geometryType": ftype,
        }
        result.append(record)
    return result
