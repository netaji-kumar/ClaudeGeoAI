"""
GeoAI MCP Server -- zero-dependency implementation.

Implements the Model Context Protocol (MCP) over stdio using only the
Python standard library + requests. No `mcp` package required.

Protocol: JSON-RPC 2.0 with Content-Length framing (same as LSP):
    Content-Length: <N>\\r\\n
    \\r\\n
    <N bytes of UTF-8 JSON>

Tools exposed:
    query_layer      -- ArcGIS Feature Service query
    get_field_info   -- layer field metadata
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from hashlib import md5
from typing import Any

import requests
import urllib3
from dotenv import load_dotenv

load_dotenv()
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s geoai_server %(levelname)s %(message)s",
)
log = logging.getLogger("geoai_server")

# ArcGIS service URL
MAP_SERVICE_URL = (
    os.getenv("MAP_SERVICE_URL") or os.getenv("VITE_MAP_SERVICE_URL", "")
).rstrip("/")
LAYER_URL = f"{MAP_SERVICE_URL}/0/query"

# In-memory cache (5-min TTL)
_CACHE: dict[str, tuple[Any, float]] = {}
_TTL = 300


def _cached(key: str, fn) -> Any:
    if key in _CACHE:
        val, ts = _CACHE[key]
        if time.time() - ts < _TTL:
            return val
    result = fn()
    _CACHE[key] = (result, time.time())
    return result


# ArcGIS REST helper

def _get(url: str, params: dict) -> dict:
    params.setdefault("f", "json")
    r = requests.get(url, params=params, verify=False, timeout=30)
    r.raise_for_status()
    data = r.json()
    if "error" in data:
        raise RuntimeError(data["error"].get("message", "ArcGIS error"))
    return data


# Tool logic

def _query_layer(args: dict) -> dict:
    where = args.get("where", "1=1") or "1=1"
    out_fields = args.get("out_fields", "*") or "*"
    return_geometry = bool(args.get("return_geometry", True))
    return_count_only = bool(args.get("return_count_only", False))
    result_record_count = args.get("result_record_count")
    order_by_fields = args.get("order_by_fields")
    out_statistics = args.get("out_statistics")
    group_by_fields = args.get("group_by_fields")
    return_distinct_values = bool(args.get("return_distinct_values", False))
    # Spatial args -- injected by claude_agent.py when geometry_info is present
    geometry = args.get("geometry")
    geometry_type = args.get("geometry_type", "esriGeometryPoint")
    distance = args.get("distance")

    params: dict[str, Any] = {
        "where":          where,
        "outFields":      out_fields,
        "returnGeometry": str(return_geometry).lower(),
    }

    # Apply 2000-record cap -- matches mcp_tools.py behaviour
    if not return_count_only and not out_statistics and not return_distinct_values:
        if order_by_fields and result_record_count:
            params["resultRecordCount"] = min(int(result_record_count), 2000)
        else:
            params["resultRecordCount"] = 2000

    if return_count_only:
        params["returnCountOnly"] = "true"
        params["returnGeometry"] = "false"
    if order_by_fields:
        params["orderByFields"] = order_by_fields
    if out_statistics:
        params["outStatistics"] = out_statistics
        params["returnGeometry"] = "false"
    if group_by_fields:
        params["groupByFieldsForStatistics"] = group_by_fields
    if return_distinct_values:
        params["returnDistinctValues"] = "true"
        params["returnGeometry"] = "false"

    # Spatial filter (point click or drawn polygon)
    if geometry:
        params["geometry"] = geometry
        params["geometryType"] = geometry_type
        params["inSR"] = "4326"
        if geometry_type == "esriGeometryPolygon":
            params["spatialRel"] = "esriSpatialRelIntersects"
        elif distance:
            params["distance"] = distance
            params["units"] = "esriSRUnit_Meter"

    key = md5(json.dumps(params, sort_keys=True, default=str).encode()).hexdigest()
    data = _cached(key, lambda: _get(LAYER_URL, dict(params)))
    features = data.get("features", [])

    if return_count_only:
        n = data.get("count", 0)
        return {"count": n, "summary": f"Total: {n}"}

    if out_statistics or group_by_fields:
        rows = [f["attributes"] for f in features if f.get("attributes")]
        return {"stats": rows, "count": len(rows), "summary": f"{len(rows)} stat row(s)"}

    if return_distinct_values:
        field = out_fields.split(",")[0].strip()
        vals = [f["attributes"].get(field) for f in features if f.get("attributes")]
        return {"distinct_values": vals, "count": len(vals)}

    processed = []
    for i, feat in enumerate(features):
        attrs = dict(feat.get("attributes") or {})
        geom = feat.get("geometry")

        coords = None
        geom_type = "unknown"

        if geom:
            if "x" in geom and "y" in geom:
                x, y = geom["x"], geom["y"]
                if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                    coords = [[x, y]]
                    geom_type = "Point"
            elif "rings" in geom and geom["rings"]:
                coords = [geom["rings"][0]]
                geom_type = "Polygon"
            elif "paths" in geom and geom["paths"]:
                coords = geom["paths"][0]
                geom_type = "Polyline"

        # Fallback: attribute-based X/Y columns
        if coords is None:
            ax = attrs.get("X") or attrs.get("x") or attrs.get("Longitude") or attrs.get("longitude")
            ay = attrs.get("Y") or attrs.get("y") or attrs.get("Latitude") or attrs.get("latitude")
            try:
                ax, ay = float(ax), float(ay)
                if ax != 0 and ay != 0:
                    coords = [[ax, ay]]
                    geom_type = "Point"
            except (TypeError, ValueError):
                pass

        if coords is None:
            continue

        record = {"id": attrs.get("OBJECTID", i + 1)}
        record.update(attrs)
        record["coordinates"] = coords
        record["geometryType"] = geom_type
        processed.append(record)

    return {"count": len(processed), "attributes": processed,
            "summary": f"Found {len(processed)} feature(s)"}


def _get_field_info(_args: dict) -> dict:
    skip = {
        "esriFieldTypeOID", "esriFieldTypeGeometry", "esriFieldTypeBlob",
        "esriFieldTypeGlobalID", "esriFieldTypeRaster",
    }
    def _fetch():
        data = _get(f"{MAP_SERVICE_URL}/0", {})
        fields = [
            {"name": f["name"], "alias": f.get("alias", f["name"]), "type": f["type"]}
            for f in data.get("fields", []) if f.get("type") not in skip
        ]
        return {"layer_name": data.get("name", ""), "fields": fields}
    return _cached("field_info", _fetch)


# Tool registry
_TOOLS = [
    {
        "name": "query_layer",
        "description": (
            "Query the ArcGIS Feature Service layer. "
            "Returns features, statistics, counts, or distinct values."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "where":                  {"type": "string"},
                "out_fields":             {"type": "string"},
                "return_geometry":        {"type": "boolean"},
                "return_count_only":      {"type": "boolean"},
                "result_record_count":    {"type": "integer"},
                "order_by_fields":        {"type": "string"},
                "out_statistics":         {"type": "string"},
                "group_by_fields":        {"type": "string"},
                "return_distinct_values": {"type": "boolean"},
                "geometry":               {"type": "string"},
                "geometry_type":          {"type": "string", "enum": ["esriGeometryPoint", "esriGeometryPolygon"]},
                "distance":               {"type": "number"},
            },
        },
    },
    {
        "name": "get_field_info",
        "description": "Return field names, aliases, and types for the layer.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]

_DISPATCH = {
    "query_layer":    _query_layer,
    "get_field_info": _get_field_info,
}

SERVER_INFO = {"name": "geoai-arcgis", "version": "1.0.0"}
PROTOCOL_VERSION = "2024-11-05"


# MCP stdio transport (Content-Length framing)

def _write(msg: dict) -> None:
    body = json.dumps(msg, default=str).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
    sys.stdout.buffer.write(header + body)
    sys.stdout.buffer.flush()


def _read() -> dict | None:
    headers: dict[bytes, bytes] = {}
    while True:
        raw = sys.stdin.buffer.readline()
        if not raw:
            return None
        line = raw.rstrip(b"\r\n")
        if not line:
            break
        key, _, val = line.partition(b":")
        headers[key.strip().lower()] = val.strip()
    length = int(headers.get(b"content-length", 0))
    if not length:
        return None
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def _respond(req_id: Any, result: Any) -> None:
    _write({"jsonrpc": "2.0", "id": req_id, "result": result})


def _error(req_id: Any, code: int, message: str) -> None:
    _write({"jsonrpc": "2.0", "id": req_id,
            "error": {"code": code, "message": message}})


# Request handlers

def _handle_initialize(req_id: Any, _params: dict) -> None:
    _respond(req_id, {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities":    {"tools": {}},
        "serverInfo":      SERVER_INFO,
    })


def _handle_list_tools(req_id: Any, _params: dict) -> None:
    _respond(req_id, {"tools": _TOOLS})


def _handle_call_tool(req_id: Any, params: dict) -> None:
    name = params.get("name", "")
    args = params.get("arguments", {}) or {}
    fn = _DISPATCH.get(name)
    if fn is None:
        _error(req_id, -32601, f"Unknown tool: {name}")
        return
    try:
        result = fn(args)
        _respond(req_id, {
            "content": [{"type": "text", "text": json.dumps(result, default=str)}],
            "isError": False,
        })
    except Exception as exc:
        log.exception("Tool error: %s", exc)
        _respond(req_id, {
            "content": [{"type": "text", "text": json.dumps({"error": str(exc)})}],
            "isError": True,
        })


_HANDLERS = {
    "initialize":  _handle_initialize,
    "tools/list":  _handle_list_tools,
    "tools/call":  _handle_call_tool,
}


# Main loop

def main() -> None:
    log.info("GeoAI MCP server started (pid=%d)", os.getpid())
    while True:
        try:
            msg = _read()
        except (EOFError, KeyboardInterrupt):
            break
        if msg is None:
            break

        method = msg.get("method", "")
        req_id = msg.get("id")        # None for notifications
        params = msg.get("params") or {}

        log.info("<- %s (id=%s)", method, req_id)

        # Notifications have no id -- no response expected
        if method == "notifications/initialized":
            continue

        handler = _HANDLERS.get(method)
        if handler is None:
            if req_id is not None:
                _error(req_id, -32601, f"Method not found: {method}")
            continue

        handler(req_id, params)

    log.info("GeoAI MCP server shutting down")


if __name__ == "__main__":
    main()
