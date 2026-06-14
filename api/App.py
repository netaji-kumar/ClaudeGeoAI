"""
GeoAI — Flask backend (Claude MCP tool-use architecture).

Thin routing layer only. All logic lives in:
  claude_agent.py  — agentic loop
  mcp_tools.py     — ArcGIS tool execution
  prompts/*.md     — system prompt + query rules

No FAISS required — field info fetched directly from the ArcGIS REST API at startup.
"""

import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests as http_requests
import urllib3
from flask import Flask, jsonify, request, Response, stream_with_context, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from typing import Dict, List

load_dotenv()
_HERE   = os.path.dirname(os.path.abspath(__file__))   # GeoAI/api/
_ROOT   = os.path.dirname(_HERE)                        # GeoAI/
for _p in (_HERE, _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from config import MAP_SERVICE_URL
from claude_agent import (
    run_agent_stream,
    run_agent_stream_mcp,
    set_field_cache,
    set_backend_mode,
    get_backend_mode,
)
from file_agent import run_file_agent_stream

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
logging.basicConfig(level=logging.INFO)

app = Flask(__name__)
app.json.sort_keys = False
CORS(app)

# ---------------------------------------------------------------------------
# Startup: build field cache directly from ArcGIS REST API (no FAISS)
# ---------------------------------------------------------------------------
BASE_QUERY_URL = f"{MAP_SERVICE_URL}/0/query"

_SKIP_TYPES = {
    "esriFieldTypeOID", "esriFieldTypeGeometry", "esriFieldTypeBlob",
    "esriFieldTypeGlobalID", "esriFieldTypeRaster",
}
_NUMERIC_TYPES = {
    "esriFieldTypeDouble", "esriFieldTypeInteger", "esriFieldTypeSingle",
    "esriFieldTypeSmallInteger", "esriFieldTypeFloat",
}


def _fetch_layer_fields() -> list:
    """Fetch field definitions from the ArcGIS layer endpoint."""
    try:
        r = http_requests.get(
            f"{MAP_SERVICE_URL}/0",
            params={"f": "json"},
            verify=False, timeout=15,
        )
        return r.json().get("fields", [])
    except Exception as e:
        logging.warning(f"Could not fetch layer fields: {e}")
        return []


def _extract_fields(field_info: list) -> tuple:
    fields, alias_map, numeric = [], {}, set()
    for f in field_info:
        fname = f.get("name", "")
        ftype = f.get("type", "")
        if not fname or ftype in _SKIP_TYPES:
            continue
        alias_map[fname] = f.get("alias", fname)
        if ftype in _NUMERIC_TYPES:
            numeric.add(fname)
        fields.append({"name": fname, "alias": f.get("alias", fname), "type": ftype})
    return fields, alias_map, numeric


def _fetch_distinct(field_name: str) -> List[str]:
    try:
        r = http_requests.get(
            BASE_QUERY_URL,
            params={"where": "1=1", "outFields": field_name,
                    "returnDistinctValues": "true", "returnGeometry": "false", "f": "json"},
            verify=False, timeout=15,
        )
        return sorted({
            str(f["attributes"][field_name]).strip()
            for f in r.json().get("features", [])
            if f.get("attributes", {}).get(field_name)
        })
    except Exception as e:
        logging.warning(f"Could not fetch distinct {field_name}: {e}")
        return []


# Build cache
_field_info = _fetch_layer_fields()
_fields, _alias_map, _numeric = _extract_fields(_field_info)

_DISTINCT_FIELDS = {
    "portfolio_values": "Portfolio",
    "city_values":      "City",
    "country_values":   "Country",
    "status_values":    "Property_Status",
    "type_values":      "Property_Type",
    "ownership_values": "Ownership_Type",
    "industry_values":  "Industry",
}

_distinct_results: Dict[str, List[str]] = {}
with ThreadPoolExecutor(max_workers=7) as _pool:
    _futures = {_pool.submit(_fetch_distinct, col): key for key, col in _DISTINCT_FIELDS.items()}
    for _fut in as_completed(_futures):
        _distinct_results[_futures[_fut]] = _fut.result()

FIELD_CACHE: Dict = {
    "fields":         _fields,
    "alias_map":      _alias_map,
    "numeric_fields": sorted(_numeric),
    **_distinct_results,
}

set_field_cache(FIELD_CACHE)
logging.info("Field cache ready. Portfolios: %s", FIELD_CACHE.get("portfolio_values", []))


# ---------------------------------------------------------------------------
# /api/chat  — SSE streaming endpoint
# ---------------------------------------------------------------------------
def _parse_request(data: dict):
    chat_history     = data.get("history", [])
    point_geometry   = data.get("coordinates")
    polygon_geometry = data.get("polygon") or {}

    user_message = ""
    for msg in reversed(chat_history):
        if msg.get("isUser"):
            user_message = msg.get("text", "").strip()
            break

    geometry_info = None
    if isinstance(point_geometry, list) and len(point_geometry) == 2:
        lat, lon = point_geometry
        geometry_info = {
            "type":          "Point",
            "lat":           lat,
            "lon":           lon,
            "geometry":      json.dumps({"x": lon, "y": lat, "spatialReference": {"wkid": 4326}}),
            "geometry_type": "esriGeometryPoint",
        }
    elif polygon_geometry.get("rings") and any(r for r in polygon_geometry["rings"] if r):
        geometry_info = {
            "type":          "Polygon",
            "geometry":      json.dumps(polygon_geometry),
            "geometry_type": "esriGeometryPolygon",
        }

    return user_message, chat_history, geometry_info


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json()
    user_message, chat_history, geometry_info = _parse_request(data)

    if not user_message:
        return jsonify({"error": "No user message found."}), 400

    mode = get_backend_mode()
    agent_fn = run_agent_stream_mcp if mode == "MCP" else run_agent_stream

    def generate():
        try:
            for event in agent_fn(user_message, chat_history, geometry_info):
                yield f"data: {json.dumps(event, default=str)}\n\n"
        except Exception as exc:
            logging.error(f"Stream error: {exc}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'text': str(exc)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# /api/fields  — field metadata for the frontend
# ---------------------------------------------------------------------------
@app.route("/api/fields", methods=["GET"])
def get_fields():
    return jsonify(FIELD_CACHE)


# ---------------------------------------------------------------------------
# /api/mode  — switch between API (direct) and MCP (subprocess) execution
# ---------------------------------------------------------------------------
@app.route("/api/mode", methods=["GET", "POST"])
def backend_mode():
    if request.method == "GET":
        return jsonify({"mode": get_backend_mode()})
    data = request.get_json() or {}
    mode = data.get("mode", "API").upper()
    if mode not in ("API", "MCP"):
        return jsonify({"error": "mode must be 'API' or 'MCP'"}), 400
    set_backend_mode(mode)
    icon = "🖥 " if mode == "MCP" else "⚡"
    print(f"\n{'═'*60}")
    print(f"  {icon}  Backend mode switched  →  {mode}")
    print(f"{'═'*60}\n")
    logging.info(f"[Mode] Switched to {mode}")
    return jsonify({"mode": mode, "message": f"Backend switched to {mode} mode"})


# ---------------------------------------------------------------------------
# Misc endpoints
# ---------------------------------------------------------------------------
@app.route("/api/locations", methods=["GET"])
def get_locations():
    return jsonify([])


@app.route("/api/support/email", methods=["POST"])
def send_support_request():
    d     = request.get_json()
    name  = d.get("name",  "").strip()
    query = d.get("query", "").strip()
    if not name or not query:
        return jsonify({"success": False, "message": "Name and query are required"}), 400
    logging.info(f"[Support] {name}: {query}")
    return jsonify({"success": True, "message": "Support request received"})


# ---------------------------------------------------------------------------
# /api/upload  — file upload + Claude Vision geometry extraction
# ---------------------------------------------------------------------------
_ALLOWED_TYPES = {
    "image/png", "image/jpeg", "image/jpg", "image/webp",
    "image/gif", "application/pdf",
}
_MAX_BYTES = 20 * 1024 * 1024   # 20 MB


@app.route("/api/upload", methods=["POST"])
def upload_file():
    data      = request.get_json(silent=True) or {}
    file_data = data.get("file_data", "")
    file_type = (data.get("file_type") or "").lower().strip()
    message   = (data.get("message") or "Extract all geometries and show them on the map").strip()

    if not file_data:
        return jsonify({"error": "No file data provided"}), 400
    if file_type not in _ALLOWED_TYPES:
        return jsonify({"error": f"Unsupported file type: {file_type}"}), 400

    try:
        file_bytes = __import__('base64').b64decode(file_data)
    except Exception:
        return jsonify({"error": "Invalid base64 data"}), 400

    if len(file_bytes) > _MAX_BYTES:
        return jsonify({"error": "File too large (max 20 MB)"}), 400

    # Normalise image/jpg → image/jpeg
    if file_type == "image/jpg":
        file_type = "image/jpeg"

    def generate():
        try:
            for event in run_file_agent_stream(file_bytes, file_type, message):
                yield f"data: {json.dumps(event, default=str)}\n\n"
        except Exception as exc:
            logging.error(f"Upload stream error: {exc}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'text': str(exc)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# Serve React build (production)
# ---------------------------------------------------------------------------
_DIST = os.path.join(_ROOT, "dist")

if os.path.isdir(_DIST):
    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_react(path):
        target = os.path.join(_DIST, path)
        if path and os.path.exists(target):
            return send_from_directory(_DIST, path)
        return send_from_directory(_DIST, "index.html")

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(debug=False, host="0.0.0.0", port=port)
