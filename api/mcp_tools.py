"""
mcp_tools.py - ArcGIS MCP tool definitions and execution for GeoAI.
"""

import hashlib
import json
import logging
import os
import sys
import time
import urllib3

import requests as http_requests

# ---------------------------------------------------------------------------
# In-memory query cache — same ArcGIS request returns immediately (5-min TTL)
# ---------------------------------------------------------------------------
_QUERY_CACHE: dict = {}
_CACHE_TTL   = 300   # seconds

def _cache_key(q: dict) -> str:
    return hashlib.md5(json.dumps(q, sort_keys=True, default=str).encode()).hexdigest()

def _cache_get(key: str):
    entry = _QUERY_CACHE.get(key)
    if entry and (time.time() - entry[1]) < _CACHE_TTL:
        return entry[0]
    if entry:
        del _QUERY_CACHE[key]
    return None

def _cache_set(key: str, result: dict):
    _QUERY_CACHE[key] = (result, time.time())

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
for _p in (_HERE, _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)
from config import MAP_SERVICE_URL

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_QUERY_URL = f"{MAP_SERVICE_URL}/0/query"

# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------
TOOL_DEFINITIONS = [
    {
        "name": "query_layer",
        "description": (
            "Query the landbank ArcGIS feature layer (layer 0 - all portfolios). "
            "Use for filtering, sorting, counting, statistics, spatial queries, and distinct value lookups."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "where": {
                    "type": "string",
                    "description": "SQL WHERE clause. e.g. \"UPPER(Portfolio)=UPPER('Seha')\", \"Plot_Area__sqm_>50000\", \"1=1\""
                },
                "out_fields": {
                    "type": "string",
                    "description": "Comma-separated field names or * for all. Default: *"
                },
                "return_geometry": {
                    "type": "boolean",
                    "description": "Include geometry. Default true. Set false for counts/stats/distinct."
                },
                "order_by_fields": {
                    "type": "string",
                    "description": "Sort field and direction. e.g. \"Plot_Area__sqm_ DESC\""
                },
                "result_record_count": {
                    "type": "integer",
                    "description": "Max records to return. Use with order_by_fields for top-N."
                },
                "return_count_only": {
                    "type": "boolean",
                    "description": "Return only count. Use for 'how many' questions only."
                },
                "return_distinct_values": {
                    "type": "boolean",
                    "description": "Return distinct values for out_fields."
                },
                "out_statistics": {
                    "type": "string",
                    "description": "JSON array for statistics. e.g. '[{\"statisticType\":\"sum\",\"onStatisticField\":\"Plot_Area__sqm_\",\"outStatisticFieldName\":\"TOTAL\"}]'"
                },
                "group_by_fields": {
                    "type": "string",
                    "description": "Field to group statistics by. e.g. \"Portfolio\""
                },
                "geometry": {
                    "type": "string",
                    "description": "Geometry JSON string. Do NOT set when [Map context] is in the message — the backend injects polygon/point geometry automatically."
                },
                "geometry_type": {
                    "type": "string",
                    "enum": ["esriGeometryPoint", "esriGeometryPolygon"],
                    "description": "Geometry type. Do NOT set when [Map context] is in the message — injected automatically by the backend."
                },
                "distance": {
                    "type": "number",
                    "description": "Buffer distance in meters for POINT spatial queries only. Never set this for polygon queries."
                }
            },
            "required": ["where"]
        }
    },
    {
        "name": "get_field_info",
        "description": "Return field names, aliases, types, and valid values. Call if unsure of correct field name or value.",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    }
]


# ---------------------------------------------------------------------------
# Feature processing
# ---------------------------------------------------------------------------
def _process_features(raw_features: list) -> list:
    """
    Convert raw ArcGIS ESRI-JSON features to frontend format:
    { id, ...attributes, coordinates, geometryType }
    """
    processed = []
    for i, f in enumerate(raw_features):
        geom  = f.get("geometry") or {}
        attrs = f.get("attributes") or {}

        coords    = None
        geom_type = "unknown"

        if "x" in geom and "y" in geom:
            x, y = geom["x"], geom["y"]
            if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                coords    = [[x, y]]
                geom_type = "Point"
        elif "rings" in geom and geom["rings"]:
            coords    = [geom["rings"][0]]
            geom_type = "Polygon"
        elif "paths" in geom and geom["paths"]:
            coords    = geom["paths"][0]
            geom_type = "Polyline"

        # Fallback: try X/Y attribute fields when geometry is null
        if coords is None:
            ax = attrs.get("X") or attrs.get("x") or attrs.get("Longitude") or attrs.get("longitude")
            ay = attrs.get("Y") or attrs.get("y") or attrs.get("Latitude")  or attrs.get("latitude")
            try:
                ax, ay = float(ax), float(ay)
                if ax != 0 and ay != 0:
                    coords    = [[ax, ay]]
                    geom_type = "Point"
            except (TypeError, ValueError):
                pass

        if coords is None:
            continue

        # Build record preserving ArcGIS field definition order.
        # Put system keys (id, coordinates, geometryType) outside the attribute
        # spread so they don't disrupt the original column sequence.
        record = {"id": attrs.get("OBJECTID", i + 1)}
        record.update(attrs)          # attrs order = service field definition order
        record["coordinates"]  = coords
        record["geometryType"] = geom_type
        processed.append(record)

    return processed


# ---------------------------------------------------------------------------
# Tool executors
# ---------------------------------------------------------------------------
def execute_query_layer(params: dict, geometry_override: dict = None) -> dict:
    q = {
        "where":          params.get("where", "1=1"),
        "outFields":      params.get("out_fields", "*"),
        "returnGeometry": "true" if params.get("return_geometry", True) else "false",
        "f":              "json",
    }

    if params.get("order_by_fields"):
        q["orderByFields"] = params["order_by_fields"]
    # result_record_count is ONLY for explicit top-N queries (order_by_fields must
    # also be set).  For general "show me all X" queries, always use the 2000
    # default so Haiku cannot silently cap results at 500 or 100.
    if not params.get("return_count_only") and not params.get("out_statistics") and not params.get("return_distinct_values"):
        if params.get("order_by_fields") and params.get("result_record_count"):
            q["resultRecordCount"] = min(int(params["result_record_count"]), 2000)
        else:
            q["resultRecordCount"] = 2000
    if params.get("return_count_only"):
        q["returnCountOnly"] = "true"
        q["returnGeometry"]  = "false"
    if params.get("return_distinct_values"):
        q["returnDistinctValues"] = "true"
        q["returnGeometry"]       = "false"
    if params.get("out_statistics"):
        stats_val = params["out_statistics"]
        # requests serialises a Python list as dict keys (wrong for ArcGIS);
        # must send as a JSON string so ArcGIS receives a proper JSON array.
        q["outStatistics"]  = json.dumps(stats_val) if isinstance(stats_val, (list, dict)) else stats_val
        q["returnGeometry"] = "false"
    if params.get("group_by_fields"):
        q["groupByFieldsForStatistics"] = params["group_by_fields"]
    if params.get("geometry") or (geometry_override or {}).get("geometry"):
        geo = params.get("geometry") or geometry_override.get("geometry")
        # geometry_override type ALWAYS wins — Claude must not override this
        geom_type = (geometry_override or {}).get("geometry_type") or params.get("geometry_type", "esriGeometryPoint")
        q["geometry"]     = geo
        q["geometryType"] = geom_type
        q["inSR"]         = "4326"
        if geom_type == "esriGeometryPolygon":
            # Polygon spatial filter — explicit containment relation, no distance buffer
            q["spatialRel"] = "esriSpatialRelIntersects"
        else:
            # Point spatial filter — optional distance buffer
            dist = params.get("distance") or (geometry_override or {}).get("distance")
            if dist:
                q["distance"] = dist
                q["units"]    = "esriSRUnit_Meter"

    # ── Console: log the full ArcGIS query ───────────────────────────────────
    print("\n" + "═"*60)
    print("  📡  ArcGIS REST Query")
    print("═"*60)
    print(f"  URL   : {BASE_QUERY_URL}")
    for k, v in q.items():
        val_str = str(v)
        if len(val_str) > 120:
            val_str = val_str[:117] + "..."
        print(f"  {k:<22}: {val_str}")
    print("═"*60 + "\n")

    # Check cache before hitting the network
    ck = _cache_key(q)
    cached = _cache_get(ck)
    if cached is not None:
        print(f"  Cache HIT — returning cached result for WHERE: {q.get('where', '1=1')}\n")
        logging.info(f"[QueryCache HIT] {q.get('where', '1=1')}")
        return cached

    try:
        resp = http_requests.get(BASE_QUERY_URL, params=q, verify=False, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logging.error(f"ArcGIS request failed: {e}")
        return {"error": str(e), "count": 0, "attributes": [], "features": [], "summary": str(e)}

    if "error" in data:
        msg = data["error"].get("message", "ArcGIS error")
        return {"error": msg, "count": 0, "attributes": [], "features": [], "summary": msg}

    # Count-only
    if "count" in data and "features" not in data:
        n      = data["count"]
        result = {"count": n, "attributes": [], "features": [], "summary": f"Count: {n}"}
        _cache_set(ck, result)
        return result

    raw_features = data.get("features", [])
    print(f"  ArcGIS returned {len(raw_features)} raw feature(s)\n")

    # Statistics / group-by
    if params.get("out_statistics") or params.get("group_by_fields"):
        stats_rows = [f["attributes"] for f in raw_features if f.get("attributes")]
        # Detect the count/stat column (first numeric-looking column)
        count_col  = None
        if stats_rows:
            for k in stats_rows[0]:
                if k.upper() in ("CNT", "COUNT", "TOTAL", "RECORD_COUNT", "PLOT_COUNT",
                                   "TOTAL_PLOTS", "VACANT_PLOTS", "OPERATIONAL_PLOTS"):
                    count_col = k
                    break
            if not count_col:
                # Fallback: pick any column whose name contains "count", "cnt", or "plots"
                for k in stats_rows[0]:
                    if "count" in k.lower() or "cnt" in k.lower() or "plots" in k.lower():
                        count_col = k
                        break
        # Sort by count column descending by default (Python-side, guaranteed correct)
        # order_by_fields from ArcGIS is unreliable for stats queries on some servers
        if count_col and stats_rows:
            order_raw = (params.get("order_by_fields") or "").upper()
            reverse   = "ASC" not in order_raw  # default DESC; only ASC if explicitly requested
            try:
                stats_rows = sorted(
                    stats_rows,
                    key=lambda r: (r.get(count_col) or 0),
                    reverse=reverse,
                )
            except Exception:
                pass  # leave unsorted if anything fails
        total_from_stats: int = 0
        if count_col:
            for row in stats_rows:
                try:
                    total_from_stats += int(row.get(count_col, 0) or 0)
                except (TypeError, ValueError):
                    pass
        summary = "; ".join(", ".join(f"{k}={v}" for k, v in row.items()) for row in stats_rows[:10])
        result  = {
            "group_count":       len(stats_rows),
            "total_from_stats":  total_from_stats,
            "count":             len(stats_rows),
            "attributes":        [],
            "features":          raw_features,
            "stats":             stats_rows,
            "summary":           summary or "No statistics data",
        }
        _cache_set(ck, result)
        return result

    # Distinct values
    if params.get("return_distinct_values"):
        field  = (params.get("out_fields") or "").split(",")[0].strip()
        vals   = [f["attributes"].get(field, "") for f in raw_features if f.get("attributes")]
        result = {"count": len(vals), "attributes": [], "features": raw_features,
                  "distinct_values": vals,
                  "summary": f"Distinct {field} values: {', '.join(str(v) for v in vals[:20])}"}
        _cache_set(ck, result)
        return result

    # Normal features
    processed = _process_features(raw_features)
    result    = {
        "count":      len(processed),
        "attributes": processed,
        "features":   raw_features,
        "summary":    f"Found {len(processed)} feature(s) where {params.get('where', '1=1')}",
    }
    _cache_set