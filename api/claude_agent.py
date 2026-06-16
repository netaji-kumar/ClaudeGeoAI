"""
claude_agent.py - Claude agentic tool-use loop for GeoAI.
Prompts loaded from prompts/*.md. Returns format ChatBot.tsx expects.

Performance optimisations:
  - Anthropic prompt caching on system prompt (saves ~1-2s per request)
  - Haiku for tool-use iterations (~5× faster than Sonnet, equally accurate)
  - Sonnet only for the final prose response (streamed via SSE)
  - History window capped at 8 messages (last 4 exchanges)
  - Raw features omitted from wire payload (frontend uses attributes only)
"""

import json
import logging
import os
import re
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import anthropic
from dotenv import load_dotenv

load_dotenv()
_HERE = os.path.dirname(os.path.abspath(__file__))   # GeoAI/api/
_ROOT = os.path.dirname(_HERE)                        # GeoAI/
for _p in (_HERE, _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from mcp_tools import TOOL_DEFINITIONS, execute_query_layer, execute_get_field_info

logger = logging.getLogger(__name__)

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"

def _load_md(filename):
    path = _PROMPTS_DIR / filename
    return path.read_text(encoding="utf-8") if path.exists() else ""

SYSTEM_MD      = _load_md("system.md")
QUERY_RULES_MD = _load_md("query_rules.md")
_STATIC_PROMPT = SYSTEM_MD + "\n\n---\n\n" + QUERY_RULES_MD

# ---------------------------------------------------------------------------
# Skill loader
# ---------------------------------------------------------------------------
_SKILLS_DIR = _PROMPTS_DIR / "skills"

_SKILL_TRIGGERS = {
    "portfolio_report.md": [
        "portfolio report", "portfolio summary", "portfolio breakdown",
        "report of portfolios", "all portfolios report", "portfolios report",
    ],
}

def _detect_skill(message):
    """Return skill name (without .md) if a trigger matches, else empty string."""
    low = message.lower().strip()
    for filename, triggers in _SKILL_TRIGGERS.items():
        if any(t in low for t in triggers):
            return filename.replace(".md", "")
    return ""


def _run_skill_portfolio_report() -> Dict[str, Any]:
    """Execute 3 ArcGIS queries and merge into a portfolio report.

    Returns dict with keys: stats (list of rows), context (str for Sonnet).
    Each stats row: {Portfolio, Total_Plots, Vacant_Plots, Operational_Plots}
    """
    q1 = execute_query_layer({
        "where": "1=1",
        "out_statistics": [{"statisticType": "count", "onStatisticField": "OBJECTID",
                            "outStatisticFieldName": "Total_Plots"}],
        "group_by_fields": "Portfolio",
        "order_by_fields": "Total_Plots DESC",
    })
    q2 = execute_query_layer({
        "where": "UPPER(Property_Status) LIKE UPPER('%Vacant%')",
        "out_statistics": [{"statisticType": "count", "onStatisticField": "OBJECTID",
                            "outStatisticFieldName": "Vacant_Plots"}],
        "group_by_fields": "Portfolio",
    })
    q3 = execute_query_layer({
        "where": "UPPER(Property_Status) LIKE UPPER('%Operational%')",
        "out_statistics": [{"statisticType": "count", "onStatisticField": "OBJECTID",
                            "outStatisticFieldName": "Operational_Plots"}],
        "group_by_fields": "Portfolio",
    })

    def _merge_stat(rows: list, val_key: str) -> dict:
        """Build {portfolio: max_count} -- handles duplicate 0-count rows ArcGIS returns."""
        out: dict = {}
        for r in rows:
            name = r.get("Portfolio") or r.get("portfolio") or ""
            if not name:
                continue
            val = int(r.get(val_key) or 0)
            out[name] = max(out.get(name, 0), val)
        return out

    totals  = _merge_stat(q1.get("stats") or [], "Total_Plots")
    vacants = _merge_stat(q2.get("stats") or [], "Vacant_Plots")
    ops     = _merge_stat(q3.get("stats") or [], "Operational_Plots")

    merged = []
    for portfolio, total in sorted(totals.items(), key=lambda x: -(x[1] or 0)):
        if not total:
            continue  # skip 0-count duplicate rows ArcGIS sometimes returns
        merged.append({
            "Portfolio":         portfolio,
            "Total_Plots":       total or 0,
            "Vacant_Plots":      vacants.get(portfolio, 0),
            "Operational_Plots": ops.get(portfolio, 0),
        })

    grand_total   = sum(r["Total_Plots"]       for r in merged)
    grand_vacant  = sum(r["Vacant_Plots"]      for r in merged)
    grand_ops     = sum(r["Operational_Plots"] for r in merged)

    # Build markdown table for Sonnet context
    lines = [
        "| Portfolio | Total Plots | Vacant | Operational |",
        "|-----------|-------------|--------|-------------|",
    ]
    for r in merged:
        lines.append(f"| {r['Portfolio']} | {r['Total_Plots']} | {r['Vacant_Plots']} | {r['Operational_Plots']} |")
    lines.append(f"| **Total** | **{grand_total}** | **{grand_vacant}** | **{grand_ops}** |")
    table_md = "\n".join(lines)

    context = f"Portfolio report data (from 3 ArcGIS queries):\n\n{table_md}"
    return {"stats": merged, "context": context, "table_md": table_md}


_client = None

def _get_client():
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise EnvironmentError("ANTHROPIC_API_KEY not set")
        _client = anthropic.Anthropic(api_key=api_key)
    return _client

_FIELD_CACHE: Dict[str, Any] = {}

def set_field_cache(cache: Dict[str, Any]) -> None:
    global _FIELD_CACHE
    _FIELD_CACHE = cache

def _build_field_context() -> str:
    lines = ["## Live Field Values\n"]
    for key in ("portfolio_values", "city_values", "country_values",
                "status_values", "type_values", "ownership_values", "industry_values"):
        label  = key.replace("_values", "").replace("_", " ").title()
        values = _FIELD_CACHE.get(key, [])
        if values:
            lines.append(f"{label}: {', '.join(values)}")
    lines.append("\n## Fields\n")
    for f in _FIELD_CACHE.get("fields", []):
        lines.append(f"  {f.get('alias', f['name']):<50} -> {f['name']}  [{f['type']}]")
    return "\n".join(lines)

# Build field context once at import and cache it — it never changes at runtime
_FIELD_CONTEXT_CACHED: str = ""

def _get_field_context() -> str:
    global _FIELD_CONTEXT_CACHED
    if not _FIELD_CONTEXT_CACHED and _FIELD_CACHE:
        _FIELD_CONTEXT_CACHED = _build_field_context()
    return _FIELD_CONTEXT_CACHED

def _convert_history(history: List[Dict]) -> List[Dict]:
    relevant = [m for m in history if not m.get("isLocation") and m.get("text")]
    recent   = relevant[-8:]   # last 4 exchanges — enough context, far fewer tokens
    msgs = []
    for msg in recent:
        role    = "user" if msg.get("isUser") else "assistant"
        content = msg.get("text", "").strip()
        if content:
            msgs.append({"role": role, "content": content})
    merged = []
    for m in msgs:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] += "\n" + m["content"]
        else:
            merged.append(dict(m))
    return merged

# Count-intent keywords — allow return_count_only through without override.
# Keep these specific; bare "total " / "how much" / "average" are too broad
# and mis-flag non-data sentences like "total agreement" or "how much does coffee cost?".
_COUNT_KEYWORDS = [
    "how many", "count", "total number", "number of",
    "sum of", "statistics", "total plots", "total records",
    "total properties", "total assets", "total landbank",
]

# GIS-intent keywords — strong signals that a message needs the tool loop.
# Keep this set TIGHT: every keyword here must be unlikely in casual conversation.
# Removed in this version (too broad — cause false positives):
#   "get"           → "I get it", "to get there"
#   "list"          → "list of languages"
#   "search"        → "I searched Google"
#   "record/records"→ "for the records"
#   "feature/s"     → "app features"
#   "status"        → "what is your status?" — field cache handles "Vacant"/"Operational"
#   "type"          → "what type of person?" — field cache handles "Land"/"Building"
#   "zone"          → "comfort zone" — covered by "spatial"/"polygon"
#   "point"         → "good point" — too common in English
#   "equal"         → "equal rights" — rarely the sole indicator
#   "sum"           → "sum it up" — covered by "statistics"
#   "total"         → "total agreement" — specific combos kept in _COUNT_KEYWORDS
#   "location"      → "what is your location?" — too broad
#   "country"       → field cache handles it
#   "first "/"top " → "first of all", "top of the morning" — replaced by _TOP_N_RE
#   "what are"      → "what are you?" — moved to _GIS_CONTEXT_PHRASES
#   "tell me about" → "tell me about yourself" — moved to _GIS_CONTEXT_PHRASES
#   "what is the"   → "what is the capital?" — moved to _GIS_CONTEXT_PHRASES
#   "what's the"    → "what's the time?" — moved to _GIS_CONTEXT_PHRASES
#   "how much"      → "how much does coffee cost?" — moved to _GIS_CONTEXT_PHRASES
#   "greater"       → changed to full phrase "greater than"
_GIS_KEYWORDS = {
    # measurement — specific enough in a GIS app
    "sqm", "hectare",
    # action verbs — only those rare enough NOT to appear in general questions.
    # "show" removed: "show me python code", "show me how to..."
    # "find" removed: "find the bug in my code", "find me a recipe"
    # All legitimate GIS uses of show/find are caught by domain nouns below.
    "display", "fetch", "filter", "query",
    "give me",
    # domain nouns
    "plot", "plots", "property", "properties", "parcel", "parcels",
    "landbank", "land bank", "asset", "assets", "layer",
    # field names kept (city is GIS-contextual even if slightly broad)
    "portfolio", "city", "ownership", "industry", "coordinate", "geometry",
    # spatial terms
    # NOTE: "map" intentionally excluded — it appears in UI commands like
    # "pan map", "clear map", "reset map" which must stay conversational.
    "near", "within", "inside", "outside", "around", "boundary",
    "polygon", "spatial",
    # count/stats
    "how many", "statistics", "count", "average",
    # report / summary queries
    "report", "summary", "breakdown",
    # ranking/comparison
    "largest", "smallest", "biggest",
    # range operators — full phrases only to avoid partial "greater" match
    "greater than", "less than", "more than", "between",
    # size/area — slightly broad but nearly always GIS-contextual here
    "area", "size",
}

# "Top N" / "first N" pattern — matches ranked queries but NOT "top of the morning"
# or "first of all".
_TOP_N_RE = re.compile(r'\b(top|first)\s+\d+\b', re.IGNORECASE)

# Phrases that look like GIS queries ONLY when paired with a confirming domain noun.
# Without a domain noun they catch too many general questions ("what are you?",
# "tell me about yourself", "what's the time?", etc.).
_GIS_CONTEXT_PHRASES = (
    "what is the", "what's the", "what are", "tell me about", "how much",
)

# Domain nouns that confirm a context phrase belongs to a GIS query.
_GIS_CONTEXT_NOUNS = frozenset({
    "plot", "plots", "property", "properties", "parcel", "asset", "assets",
    "landbank", "portfolio", "sqm", "hectare", "area", "size",
    "count", "total", "average", "largest", "smallest",
    "freehold", "leasehold", "vacant", "operational",
    "ownership", "industry", "layer", "coordinate",
})

# Exact phrases that must always stay on the conversational path.
_GREETINGS = {
    "hi", "hello", "hey", "thanks", "thank you", "bye", "goodbye",
    "ok", "okay", "yes", "sure", "great", "awesome", "nice",
    "good", "perfect", "understood", "got it",
}

# Words that, when they appear as the FIRST word of a message, indicate a
# UI control command or navigation intent — never a data query.
# Checked BEFORE all GIS keyword rules so "clear results", "clear map",
# "reset", "pan left", "zoom in" etc. always stay conversational.
_UI_START_WORDS = {
    "clear", "reset", "cancel", "undo", "remove", "delete",
    "close", "exit", "pan", "zoom", "rotate", "tilt",
    "refresh", "reload",
}

# Words that start a general question → conversational even if short
# "tell" is included so "tell me about X" bypasses Rule 4 and is handled
# exclusively by _has_gis_context_phrase (which requires a GIS noun to confirm).
_QUESTION_STARTERS = {
    "what", "when", "where", "who", "why", "how", "is", "are",
    "can", "could", "would", "should", "does", "do", "did",
    "tell",
}


def _has_gis_context_phrase(low: str) -> bool:
    """Return True if *low* contains a broad GIS phrase AND a confirming domain noun.

    Prevents over-triggering: "what are you?" → False, "what are the Seha plots?" → True.
    """
    if not any(ph in low for ph in _GIS_CONTEXT_PHRASES):
        return False
    # Confirmed by a domain noun in the message itself
    if any(noun in low for noun in _GIS_CONTEXT_NOUNS):
        return True
    # Or by a live field-cache value — but NOT city names alone.
    # "tell me about Dubai" is ambiguous: Dubai is a city, not a GIS noun.
    # Portfolio / status / ownership names ARE specific enough to confirm GIS intent.
    # City names only confirm GIS via Rule 3 (_GIS_KEYWORDS) or Rule 4 (exact match).
    for key in ("portfolio_values", "status_values",
                "type_values", "ownership_values", "industry_values"):
        for val in _FIELD_CACHE.get(key, []):
            if len(val) >= 3 and val.lower() in low:
                return True
    return False


def _is_gis_query(message: str, chat_history: List[Dict] = None) -> bool:  # noqa: ARG001
    """Return True if the message should go through the GIS tool-use loop.

    Decision order
    ──────────────
    1. Greeting phrase (exact match)           → always conversational
    2. UI control word at start of message     → always conversational
       ("clear results", "reset", "pan map", "zoom in", …)
    3. Contains a GIS keyword                  → GIS
    4. Short (≤4 words), not a question, AND
       at least one word / phrase matches a
       known field-cache value (portfolio,
       city, status, type, ownership, industry) → GIS
       ("seha", "abu dhabi", "vacant", "government", …)
    5. Everything else                         → conversational

    NOTE: The old "Rule 3" (short message after a confirmed GIS result →
    GIS) has been intentionally removed.  It caused UI commands such as
    "clear results", "reset", "done" to route to the tool loop and fetch
    all 2000+ records whenever a GIS result appeared in history.
    Rule 4 (field-cache matching) already handles every legitimate
    short follow-up: portfolio names, city names, status values, etc.
    are all stored in _FIELD_CACHE and matched there.
    """
    low   = message.lower().strip()
    words = low.split()
    if not words:
        return False

    # Strip punctuation from the first word for reliable rule matching
    # e.g. "Hello!" → "hello", "Found," → "found"
    first = re.sub(r"[^a-z]", "", words[0])

    # Affirmatives — full phrases that signal GIS continuation
    _AFFIRMATIVES = {"yes", "sure", "ok", "okay", "yeah", "yep", "go ahead", "do it",
                     "do", "go"}

    def _last_bot_offered_gis() -> bool:
        """Return True if the most recent assistant message offered GIS options."""
        if not chat_history:
            return False
        for msg in reversed(chat_history):
            if not msg.get("isUser") and msg.get("text"):
                last_bot = msg["text"].lower()
                return any(phrase in last_bot for phrase in [
                    "on the map", "displayed on the map", "shall i", "want to",
                    "would you like", "interested in", "how about", "should i",
                    "filter", "narrow",
                ])
        return False

    # Rule 1 — exact greeting phrase OR first word is a greeting
    if low in _GREETINGS or first in _GREETINGS:
        # Affirmative after a GIS offer → GIS continuation
        if first in _AFFIRMATIVES and _last_bot_offered_gis():
            return True

        # "yes. vacant" / "ok show me seha" — greeting prefix + GIS content after
        rest = " ".join(words[1:]).strip() if len(words) > 1 else ""
        if rest:
            if any(kw in rest for kw in _GIS_KEYWORDS):
                return True
            for key in ("portfolio_values", "city_values", "country_values",
                        "status_values", "type_values", "ownership_values", "industry_values"):
                for val in _FIELD_CACHE.get(key, []):
                    val_low = val.lower().strip()
                    if len(val_low) >= 3 and val_low in rest:
                        return True
        return False

    # Rule 1b — multi-word affirmatives not caught by first-word check
    # "go ahead", "do it" — first word not in _GREETINGS so Rule 1 never fires
    if low in _AFFIRMATIVES and _last_bot_offered_gis():
        return True

    # Rule 2 — UI / map-navigation command (first word check)
    if first in _UI_START_WORDS:
        return False

    # Rule 2b — assistant response openers pasted back as a query
    # Excludes "should i" / "shall i" so genuine user questions aren't blocked
    if re.match(r"^(found|displaying|here are|i found|i've found|want to|would you)\b", low):
        return False

    # Rule 2c — explicit user negation: "not related to plots", "not about this"
    # The user is clarifying their intent is conversational, not a data query.
    if re.match(r"^not (related|about|a query|gis|from|connected)", low):
        return False

    # Rule 2c — long message starting with "i" ONLY when it looks like a pasted
    # assistant reply (no GIS keywords present). Genuine long queries like
    # "I want to see all operational Seha plots sorted by area" have GIS keywords
    # and will be caught by Rule 3 before this fires.
    if len(message) > 100 and first in {"hello", "hi", "hey"}:
        return False

    # Rule 2d — meta/educational openers never trigger GIS tool loop.
    # "explain geospatial data", "describe how arcgis works", etc.
    # Note: "show" and "find" are caught by Rule 3 before this fires, so
    # genuine retrieval commands ("show me seha plots") are unaffected.
    if re.match(r'^(explain|describe|define|elaborate|what does|what do)\b', low):
        return False

    # Rule 2f — explicit meta-instruction: user wants text, not GIS data.
    # "dont show any plots. Only tell about Abu Dhabi"  → negation + text request
    # "only tell about Abu Dhabi"                       → text-only instruction
    # "just tell me"                                    → text-only instruction
    # Note: we only suppress if no portfolio name is present (safety net so
    # "dont show plots for seha, just give me the count" still hits Rule 4b).
    _META_NEG_RE = re.compile(
        r"^(don'?t\s+show(\s+(any|me|the|all))?\s*(plots?|propert\w*|asset\w*|record\w*|anything|map)|"
        r"don'?t\s+display|"
        r"only\s+tell|just\s+tell|just\s+answer|"
        r"no\s+plots?|no\s+records?|no\s+map)",
        re.IGNORECASE,
    )
    if _META_NEG_RE.match(low):
        _has_portfolio = any(
            val.lower() in low
            for val in _FIELD_CACHE.get("portfolio_values", [])
            if len(val) >= 3
        )
        if not _has_portfolio:
            return False

    # Rule 2e — live-data / time queries without genuine GIS content.
    # "current time now", "today's weather", "latest price of oil" all contain
    # words like "current", "now", "today" that may coincidentally match a field-
    # cache value (e.g. status="Current") and fire Rule 4. Short-circuit them here
    # before any field-cache or keyword check runs.
    if _wants_live_data(message) and not any(kw in low for kw in _GIS_KEYWORDS):
        return False

    # Rule 3 — explicit GIS keyword anywhere in message
    if any(kw in low for kw in _GIS_KEYWORDS):
        return True

    # Rule 3b — broad context phrase ("what are", "tell me about", "what is the",
    #            "what's the", "how much") confirmed by a GIS domain noun.
    #            Prevents: "what are you?", "tell me about yourself", "what's the time?"
    #            Allows:   "what are the Seha plots?", "what is the largest plot?"
    if _has_gis_context_phrase(low):
        return True

    # Rule 3c — "top N" / "first N" ranked query (e.g. "top 5 largest plots").
    #            Uses regex so "top of the morning" and "first of all" don't match.
    if _TOP_N_RE.search(low):
        return True

    # Rule 3d — short pronoun-reference retrieval phrases.
    #            "get" was removed from _GIS_KEYWORDS (too broad: "I get it"),
    #            but "get them" / "get those" / "fetch them" are unambiguously
    #            data-retrieval follow-ups in a GIS context.
    _PRONOUN_RETRIEVE = {
        "get them", "get those", "fetch them", "fetch those",
        "give them", "give those", "retrieve them", "retrieve those",
    }
    if low in _PRONOUN_RETRIEVE:
        return True

    # Rule 3e -- ordinal / deictic item references from a previous result list.
    # "last one in this", "the first one", "show me this", "that one", "this plot"
    # are always follow-up references to a previously displayed result set.
    # Route to GIS so Haiku can build the appropriate ranked/filtered query
    # instead of Sonnet hallucinating specific plot details from memory.
    _ORDINAL_REF_RE = re.compile(
        r'\b(last one|first one|second one|third one|fourth one|fifth one'
        r'|the last|the first|the second|the third'
        r'|1st one|2nd one|3rd one|4th one|5th one'
        r'|this plot|that plot|this one|that one|show me this|show this)\b',
        re.IGNORECASE,
    )
    if _ORDINAL_REF_RE.search(low):
        return True

    # Rule 3f -- "what about X" / "how about X" follow-up qualifier.
    # These are ALWAYS follow-up refinements in a GIS context, never general
    # knowledge questions. Strip the opener and check the remainder against
    # the field cache (city, portfolio, status, ownership, industry, country).
    # Examples: "what about Abu Dhabi", "how about Freehold", "what about Seha"
    _ABOUT_RE = re.compile(r'^(what|how)\s+about\s+(.+)$', re.IGNORECASE)
    _about_m = _ABOUT_RE.match(low)
    if _about_m:
        remainder = _about_m.group(2).strip()
        for key in ("portfolio_values", "city_values", "country_values",
                    "status_values", "type_values", "ownership_values", "industry_values"):
            for val in _FIELD_CACHE.get(key, []):
                val_low = val.lower().strip()
                if len(val_low) >= 3 and (val_low in remainder or remainder in val_low):
                    return True
        # Also check for GIS keywords in the remainder
        if any(kw in remainder for kw in _GIS_KEYWORDS):
            return True

    # Rule 4 — short message matching a live field-cache value
    # Covers portfolio names ("seha", "silal"), cities ("abu dhabi"),
    # countries ("uae", "in uae"), statuses ("vacant", "operational"), etc.
    # Min value length = 3 chars to avoid spurious single-letter matches.
    if 1 <= len(words) <= 4 and words[0] not in _QUESTION_STARTERS:
        for key in ("portfolio_values", "city_values", "country_values",
                    "status_values", "type_values", "ownership_values", "industry_values"):
            for val in _FIELD_CACHE.get(key, []):
                val_low = val.lower().strip()
                if len(val_low) >= 3 and (val_low in low or low in val_low):
                    return True

    # Rule 4b — portfolio name anywhere in a longer message.
    # Portfolio names (Seha, Miza, Masdar…) are specific enough that their
    # presence in ANY message — regardless of length — signals GIS intent.
    # Catches: "do you have Seha data", "can you show Miza plots", etc.
    for val in _FIELD_CACHE.get("portfolio_values", []):
        val_low = val.lower().strip()
        if len(val_low) >= 3 and val_low in low:
            return True

    return False


# Common UTC offsets used when answering time questions
_NAMED_ZONES = [
    ("UTC",  0),
    ("UAE/GST", 4),
    ("IST",  5.5),
    ("PKT",  5),
    ("SGT/MYT", 8),
    ("JST",  9),
    ("GMT",  0),
    ("CET",  1),
    ("EST", -5),
    ("PST", -8),
]

# ---------------------------------------------------------------------------
# Web search — Anthropic built-in tool (no extra API key required)
# ---------------------------------------------------------------------------
_WEB_SEARCH_TOOL = {
    "type": "web_search_20250305",
    "name": "web_search",
}

# Keywords that signal the user needs live / real-time data.
# Everything else stays on the fast Haiku conversational path.
_LIVE_DATA_KEYWORDS = {
    # time-sensitive qualifiers
    "today", "now", "current", "currently", "latest", "live", "real-time",
    "this week", "this month", "right now", "at the moment",
    # financial / market data
    "price", "rate", "cost", "gold", "silver", "oil", "petrol", "fuel",
    "bitcoin", "crypto", "stock", "share price", "exchange rate",
    "usd", "aed", "eur", "gbp", "inr",
    # news / events
    "news", "score", "result", "winner", "match",
    # weather
    "weather", "forecast", "temperature", "humidity",
}


def _wants_live_data(message: str) -> bool:
    """Return True if the message is asking for real-time / live information."""
    low = message.lower()
    return any(kw in low for kw in _LIVE_DATA_KEYWORDS)


def _current_time_context() -> str:
    """Return a one-line string with the current time in major zones."""
    now_utc = datetime.now(timezone.utc)
    parts = []
    for name, offset in _NAMED_ZONES:
        h  = int(offset)
        m  = int(abs(offset % 1) * 60)
        tz = timezone(timedelta(hours=h, minutes=m))
        parts.append(f"{name} {now_utc.astimezone(tz).strftime('%H:%M')}")
    return (
        f"[System clock — {now_utc.strftime('%A %d %b %Y')}, "
        f"current times: {', '.join(parts)}]"
    )

def run_agent(user_message: str, chat_history: List[Dict], geometry_info: Optional[Dict] = None) -> Dict:
    client = _get_client()

    # System prompt with prompt caching — Anthropic caches this for 5 min,
    # saving ~1-2s on every call after the first in a warm window.
    full_system = _STATIC_PROMPT + "\n\n---\n\n" + _get_field_context()
    system_param = [{"type": "text", "text": full_system, "cache_control": {"type": "ephemeral"}}]

    user_content = user_message
    if geometry_info:
        gtype = geometry_info.get("type", "")
        if gtype == "Point":
            lat, lon = geometry_info.get("lat"), geometry_info.get("lon")
            user_content += f"\n\n[Map context: user clicked point at lat={lat}, lon={lon}]"
        elif gtype == "Polygon":
            user_content += "\n\n[Map context: user drew a polygon on the map - apply spatial filter]"

    messages = _convert_history(chat_history[:-1])
    messages.append({"role": "user", "content": user_content})

    all_attributes: List[Any] = []
    all_stats: List[Any] = []
    all_distinct: List[Any] = []
    final_text = ""

    user_low = user_message.lower()
    is_count_intent = any(kw in user_low for kw in _COUNT_KEYWORDS)

    seen_calls: set = set()
    # Spatial-mode guard: once the first query_layer call completes in a spatial
    # context, its result is the ground truth.  Any subsequent query_layer calls
    # (Claude retrying or running a fallback) must NOT add to all_attributes —
    # otherwise a second non-spatial fallback would dump all 2000 records in
    # even though the spatial query legitimately found 0.
    _spatial_first_done: bool = False

    for iteration in range(1, 5):   # max 4 iterations
        # Use fewer tokens for tool-use turns; a bit more for the final prose response
        max_tok = 600 if iteration == 1 else 512

        response = client.messages.create(
            model      = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6"),
            max_tokens = max_tok,
            system     = system_param,
            tools      = TOOL_DEFINITIONS,
            messages   = messages,
        )

        logger.info(f"[Agent iter {iteration}] stop_reason={response.stop_reason} "
                    f"input_tokens={response.usage.input_tokens} "
                    f"cache_read={getattr(response.usage, 'cache_read_input_tokens', 0)} "
                    f"cache_write={getattr(response.usage, 'cache_creation_input_tokens', 0)}")

        for block in response.content:
            if hasattr(block, "text"):
                final_text = block.text.strip()

        if response.stop_reason == "end_turn":
            break

        if response.stop_reason == "tool_use":
            messages.append({"role": "assistant", "content": response.content})
            tool_results = []
            should_break = False

            for block in response.content:
                if block.type != "tool_use":
                    continue

                tool_name  = block.name
                tool_input = block.input or {}
                logger.info(f"[Tool] {tool_name}({json.dumps(tool_input, default=str)[:200]})")

                # Detect and break infinite loops
                call_sig = f"{tool_name}:{json.dumps(tool_input, sort_keys=True, default=str)}"
                if call_sig in seen_calls:
                    logger.warning("[Agent] Duplicate tool call — breaking loop")
                    should_break = True
                    break
                seen_calls.add(call_sig)

                if tool_name == "query_layer":
                    has_stats = bool(
                        tool_input.get("out_statistics") or
                        tool_input.get("group_by_fields") or
                        tool_input.get("return_distinct_values")
                    )
                    # Override return_count_only for non-count queries
                    if tool_input.get("return_count_only") and not (is_count_intent or has_stats):
                        logger.info("[Agent] Overriding return_count_only -> fetching full features")
                        tool_input["return_count_only"] = False

                    # Ensure geometry returned for feature queries
                    if not (is_count_intent or has_stats or tool_input.get("return_count_only")):
                        tool_input["return_geometry"] = True

                    result = execute_query_layer(tool_input, geometry_info)

                    # Spatial-mode guard: only the FIRST query_layer call contributes
                    # features to all_attributes.  Claude may attempt follow-up queries
                    # (e.g. a broader fallback after seeing 0 spatial results), but those
                    # must NOT overwrite or augment the authoritative spatial result.
                    if not geometry_info or not _spatial_first_done:
                        all_attributes.extend(result.get("attributes", []))
                    else:
                        logger.info("[Agent] Spatial guard: ignoring attributes from secondary query")
                    if geometry_info:
                        _spatial_first_done = True

                    if result.get("stats"):
                        all_stats.extend(result["stats"])
                    if result.get("distinct_values"):
                        all_distinct.extend(result["distinct_values"])

                    # Send Claude only what it needs to write a response — not the full feature set
                    tool_content = {
                        "count":            result.get("count", 0),
                        "summary":          result.get("summary", ""),
                        "stats":            result.get("stats"),
                        "distinct_values":  result.get("distinct_values"),
                        "sample_records":   result.get("attributes", [])[:2],
                        # For group-by queries: pre-computed total so Claude never sums rows itself
                        "group_count":      result.get("group_count"),
                        "total_from_stats": result.get("total_from_stats"),
                    }
                    tool_content = {k: v for k, v in tool_content.items() if v is not None}

                elif tool_name == "get_field_info":
                    tool_content = execute_get_field_info(_FIELD_CACHE)
                else:
                    tool_content = {"error": f"Unknown tool: {tool_name}"}

                tool_results.append({
                    "type":        "tool_result",
                    "tool_use_id": block.id,
                    "content":     json.dumps(tool_content, default=str),
                })

            if should_break:
                break

            messages.append({"role": "user", "content": tool_results})
            continue

        break

    if not final_text:
        if all_attributes:
            final_text = f"Found {len(all_attributes)} record(s)."
        elif all_stats:
            final_text = "Statistics computed successfully."
        elif all_distinct:
            final_text = f"Found {len(all_distinct)} distinct value(s)."
        else:
            final_text = "No results found for your query."

    result_entry: Dict[str, Any] = {
        "description": final_text,
        "message":     final_text,
        "attributes":  all_attributes,
        # raw features omitted — frontend only uses processed attributes
    }
    if all_stats:
        result_entry["stats"] = all_stats
    if all_distinct:
        result_entry["distinct_values"] = all_distinct

    return {"results": [result_entry]}


# ---------------------------------------------------------------------------
# Streaming agent — used by the SSE /api/chat endpoint
# ---------------------------------------------------------------------------
# Model roles:
#   TOOL_MODEL     — Haiku  : decides which tool to call and builds params (~5× faster)
#   RESPONSE_MODEL — Sonnet : writes the final natural-language response (streamed)
_TOOL_MODEL = "claude-haiku-4-5-20251001"

# Regex that strips leaked tool-call XML that Haiku sometimes emits when
# tool_choice="any" is used (it writes a text preamble alongside the tool_use
# block).  Applied to ALL text chunks before they are yielded to the frontend.
_FUNC_CALL_RE = re.compile(
    r'(<function_calls>.*?</function_calls>'
    r'|<tool_call>.*?</tool_call>'
    r'|<tool_response>.*?</tool_response>'
    r'|<tool_calls>.*?</tool_calls>)',
    re.DOTALL | re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Prompt injection guard
# ---------------------------------------------------------------------------
_INJECTION_PATTERNS = [
    r"ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?",
    r"forget\s+(everything|all|your|previous)",
    r"disregard\s+(your|all|the|previous|prior)",
    r"you\s+are\s+now\s+(a|an|the)",
    r"act\s+as\s+(a|an|the|if)",
    r"pretend\s+(you\s+are|to\s+be)",
    r"new\s+(system\s+)?prompt\s*:",
    r"override\s+(your\s+)?(instructions?|prompt|system)",
    r"jailbreak",
    r"do\s+anything\s+now",
    r"dan\s+mode",
    r"<\s*system\s*>",
    r"\[system\]",
    r"instructions?:\s*always",
]
_INJECTION_RE = re.compile("|".join(_INJECTION_PATTERNS), re.IGNORECASE)

def _check_injection(message: str) -> bool:
    """Return True if the message looks like a prompt injection attempt."""
    return bool(_INJECTION_RE.search(message))


def _clean_chunk(text: str) -> str:
    """Remove any leaked <function_calls>...</function_calls> XML from a stream chunk.

    IMPORTANT: do NOT strip whitespace here.  Stream chunks often end with a
    space (e.g. "Found ") or start with one ("125 Seha").  Stripping removes
    those boundary spaces and causes adjacent words to merge in the frontend
    (e.g. "Found125", "Operationalor").  We only strip when processing a
    *complete* response (see callers that use .strip() explicitly).
    """
    return _FUNC_CALL_RE.sub('', text)

# Lightweight system prompt for the conversational fast path (no GIS tools).
# Using the full GIS prompt causes Haiku to hallucinate <function_calls> XML
# because the prompt repeatedly instructs it to call query_layer — but the
# streaming call in the conversational path passes no tools at all.
_CONV_SYSTEM = (
    "You are GeoAI, a friendly AI assistant embedded in a GIS mapping application. "
    "Answer the user's question directly and concisely in 1–3 sentences. "
    "For questions about property data, plots, or the landbank, let the user know "
    "they can ask you to search the database (e.g. 'show me Seha plots'). "
    "Never output XML tags, function calls, or code blocks in your reply."
)

def run_agent_stream(
    user_message: str,
    chat_history: List[Dict],
    geometry_info: Optional[Dict] = None,
):
    """
    Generator that yields SSE-ready dicts throughout the agentic loop.

    Event shapes
    ────────────
    {"type": "status",     "text": "Analyzing query..."}
    {"type": "text_delta", "text": "Found 42 plots…"}
    {"type": "result",     "data": {results: [{description, attributes, ...}]}}
    {"type": "error",      "text": "..."}
    """
    print("\n" + "*"*60)
    print("  🔌  Backend Mode : API  (direct Python call)")
    print(f"  💬  User Query   : {user_message[:100]}")
    if geometry_info:
        print(f"  🗺️   Geometry     : {geometry_info.get('type')} — {json.dumps({k:v for k,v in geometry_info.items() if k != 'geometry'})}")
    print("*"*60 + "\n")

    # ── Injection guard ───────────────────────────────────────────────────────
    if _check_injection(user_message):
        logger.warning("[Security] Prompt injection attempt blocked: %s", user_message[:100])
        msg = "I can only help with geospatial queries about the property database."
        yield {"type": "text_delta", "text": msg}
        yield {"type": "result", "data": {"results": [{"description": msg, "message": msg, "attributes": []}]}}
        return

    client = _get_client()

    skill_content = _detect_skill(user_message)
    full_system  = _STATIC_PROMPT + "\n\n---\n\n" + _get_field_context()
    system_param = [{"type": "text", "text": full_system, "cache_control": {"type": "ephemeral"}}]

    user_content = user_message
    if geometry_info:
        gtype = geometry_info.get("type", "")
        if gtype == "Point":
            lat, lon = geometry_info.get("lat"), geometry_info.get("lon")
            user_content += f"\n\n[Map context: user clicked point at lat={lat}, lon={lon}]"
        elif gtype == "Polygon":
            user_content += "\n\n[Map context: user drew a polygon on the map - apply spatial filter]"

    messages = _convert_history(chat_history[:-1])

    # Strip non-ASCII characters (Arabic, CJK, emoji, etc.) from the current
    # turn before it reaches Haiku for tool-call decisions.  Non-English text
    # in what is meant to be a data query confuses WHERE clause generation:
    #   "masdar المؤامرات" → Haiku builds WHERE 1=1 → returns ALL 2000+ plots.
    # Cleaning strips the Arabic while leaving "masdar" intact so Haiku builds
    # WHERE Portfolio='Masdar' correctly.  The original message stays in
    # chat_history so Sonnet can still reference it in the prose response.
    _non_ascii_re = re.compile(r'[^\x00-\x7F]+')
    _cleaned_content = _non_ascii_re.sub(' ', user_content).strip()
    _cleaned_content = ' '.join(_cleaned_content.split())            # normalise spaces
    if _cleaned_content and _cleaned_content != user_content.strip():
        logger.info("[Stream] Non-ASCII stripped for tool call: '%s' → '%s'",
                    user_message[:60], _cleaned_content[:60])
        messages.append({"role": "user", "content": _cleaned_content})
    else:
        messages.append({"role": "user", "content": user_content})

    # ── Fast path: conversational / non-GIS questions ─────────────────────────
    # Skip the tool loop entirely for greetings, help questions, etc.
    # geometry_info always forces the GIS path (user drew/clicked something).
    if not geometry_info and not _is_gis_query(user_message, chat_history):
        logger.info("[Stream] Conversational fast path (no tools)")
        response_model = _TOOL_MODEL   # Haiku — fast enough for general Q&A

        # Use a lean system prompt here — the full GIS prompt instructs Haiku
        # to call query_layer, which makes it hallucinate <function_calls> XML
        # because no tools are passed in this streaming call.
        conv_system = [{"type": "text", "text": _CONV_SYSTEM}]

        # Inject current clock time so the model can answer time-zone questions.
        conv_messages = list(messages)
        conv_messages[-1] = dict(conv_messages[-1])
        conv_messages[-1]["content"] = (
            conv_messages[-1]["content"] + "\n\n" + _current_time_context()
        )
        final_text = ""

        # ── Web search branch: live data questions (prices, weather, news…) ──
        if _wants_live_data(user_message):
            logger.info("[Stream] Web search path")
            yield {"type": "status", "text": "Searching the web…"}
            try:
                # Non-streaming call — Anthropic performs the search server-side
                ws_response = client.messages.create(
                    model      = response_model,
                    max_tokens = 500,
                    system     = conv_system,
                    tools      = [_WEB_SEARCH_TOOL],
                    tool_choice= {"type": "auto"},
                    messages   = conv_messages,
                )
                final_text = " ".join(
                    block.text.strip()
                    for block in ws_response.content
                    if hasattr(block, "text") and block.text.strip()
                )
                if not final_text:
                    final_text = "I searched but couldn't find a current answer. Please check a live source."
            except Exception as exc:
                logger.error(f"[Stream] Web search error: {exc}")
                final_text = "Web search unavailable right now. Please try a financial site for live rates."
            # Yield in ~30-char chunks to simulate streaming
            chunk_size = 30
            for i in range(0, len(final_text), chunk_size):
                yield {"type": "text_delta", "text": final_text[i:i + chunk_size]}

        # ── Regular conversational branch: fast Haiku streaming ──────────────
        else:
            try:
                with client.messages.stream(
                    model      = response_model,
                    max_tokens = 1024,
                    system     = conv_system,
                    messages   = conv_messages,
                ) as stream:
                    for chunk in stream.text_stream:
                        final_text += chunk
                        yield {"type": "text_delta", "text": chunk}
            except Exception as exc:
                logger.error(f"[Stream] Conversational error: {exc}")
                final_text = "Sorry, I couldn't process that. Please try again."
                yield {"type": "text_delta", "text": final_text}

        yield {"type": "result", "data": {"results": [{
            "description":   final_text,
            "message":       final_text,
            "attributes":    [],
            "tool_executed": False,
        }]}}
        return

    all_attributes: List[Any] = []
    all_stats:      List[Any] = []
    all_distinct:   List[Any] = []
    final_text      = ""

    user_low        = user_message.lower()
    is_count_intent = any(kw in user_low for kw in _COUNT_KEYWORDS)
    seen_calls: set = set()
    _spatial_first_done: bool = False
    ran_tools = False   # True once at least one tool_result round trip completed

    # ── Skill short-circuit ────────────────────────────────────────────
    if skill_content == "portfolio_report":
        yield {"type": "status", "text": "Running portfolio report…"}
        try:
            skill_result = _run_skill_portfolio_report()
            all_stats = skill_result["stats"]
            ran_tools = True
            messages.append({"role": "assistant", "content": [
                {"type": "text", "text": "I queried the GIS database 3 times and gathered the portfolio report data."}
            ]})
            messages.append({"role": "user", "content": skill_result['context']})
        except Exception as exc:
            logger.error(f"[Skill] portfolio_report failed: {exc}")
            final_text = f"Portfolio report is unavailable right now: {exc}"
            yield {"type": "text_delta", "text": final_text}
            yield {"type": "result", "data": {"results": [{"description": final_text,
                "message": final_text, "attributes": []}]}}
            return

    yield {"type": "status", "text": "Analyzing your query…"}

    # ── Phase 1: tool-use loop with fast Haiku ────────────────────────────────
    for iteration in range(1, 5):
        if ran_tools:
            break  # skill already ran all queries
        # First iteration: force a tool call so Haiku never answers from history
        # context (fixes "same query second time shows no results" bug).
        # Subsequent iterations: auto — lets Haiku stop once it has what it needs.
        tc = {"type": "any"} if iteration == 1 else {"type": "auto"}
        response = client.messages.create(
            model        = _TOOL_MODEL,
            max_tokens   = 256,
            system       = system_param,
            tools        = TOOL_DEFINITIONS,
            tool_choice  = tc,
            messages     = messages,
        )

        logger.info(f"[Stream iter {iteration}] stop={response.stop_reason} "
                    f"in={response.usage.input_tokens} "
                    f"cache_read={getattr(response.usage, 'cache_read_input_tokens', 0)}")

        for block in response.content:
            if hasattr(block, "text"):
                final_text = block.text.strip()

        if response.stop_reason == "end_turn":
            break   # Haiku answered without needing tools

        if response.stop_reason != "tool_use":
            break

        messages.append({"role": "assistant", "content": response.content})
        tool_results = []
        should_break = False

        for block in response.content:
            if block.type != "tool_use":
                continue

            tool_name  = block.name
            tool_input = block.input or {}

            call_sig = f"{tool_name}:{json.dumps(tool_input, sort_keys=True, default=str)}"
            if call_sig in seen_calls:
                logger.warning("[Stream] Duplicate tool call — breaking")
                should_break = True
                break
            seen_calls.add(call_sig)

            if tool_name == "query_layer":
                yield {"type": "status", "text": "Querying GIS database…"}

                has_stats = bool(
                    tool_input.get("out_statistics") or
                    tool_input.get("group_by_fields") or
                    tool_input.get("return_distinct_values")
                )
                if tool_input.get("return_count_only") and not (is_count_intent or has_stats):
                    tool_input["return_count_only"] = False
                if not (is_count_intent or has_stats or tool_input.get("return_count_only")):
                    tool_input["return_geometry"] = True

                print(f"  🛠️   Tool Called  : query_layer")
                print(f"  📋  Tool Input   : {json.dumps(tool_input, default=str)[:300]}")

                try:
                    result = execute_query_layer(tool_input, geometry_info)
                    print(f"  📊  Tool Result  : count={result.get('count',0)}  summary={result.get('summary','')[:80]}")

                    if not geometry_info or not _spatial_first_done:
                        all_attributes.extend(result.get("attributes", []))
                    else:
                        logger.info("[Stream] Spatial guard: ignoring secondary query attributes")
                    if geometry_info:
                        _spatial_first_done = True
                    if result.get("stats"):
                        all_stats.extend(result["stats"])
                    if result.get("distinct_values"):
                        all_distinct.extend(result["distinct_values"])

                    tool_content = {
                        "count":            result.get("count", 0),
                        "summary":          result.get("summary", ""),
                        "stats":            result.get("stats"),
                        "distinct_values":  result.get("distinct_values"),
                        "sample_records":   result.get("attributes", [])[:2],
                        "group_count":      result.get("group_count"),
                        "total_from_stats": result.get("total_from_stats"),
                    }
                    tool_content = {k: v for k, v in tool_content.items() if v is not None}
                    ran_tools = True

                except Exception as exc:
                    logger.error(f"[Stream] query_layer failed: {exc}")
                    print(f"  ❌  Tool Error    : {exc}")
                    tool_results.append({
                        "type":        "tool_result",
                        "tool_use_id": block.id,
                        "content":     json.dumps({"error": str(exc), "hint": "Try a simpler WHERE clause or check field names."}),
                        "is_error":    True,
                    })
                    messages.append({"role": "user", "content": tool_results})
                    tool_results = []
                    continue

            elif tool_name == "get_field_info":
                print(f"  🛠️   Tool Called  : get_field_info  (schema + distinct values)")
                try:
                    tool_content = execute_get_field_info(_FIELD_CACHE)
                    ran_tools = True
                except Exception as exc:
                    logger.error(f"[Stream] get_field_info failed: {exc}")
                    print(f"  ❌  Tool Error    : {exc}")
                    tool_results.append({
                        "type":        "tool_result",
                        "tool_use_id": block.id,
                        "content":     json.dumps({"error": str(exc)}),
                        "is_error":    True,
                    })
                    messages.append({"role": "user", "content": tool_results})
                    tool_results = []
                    continue
            else:
                print(f"  ⚠️   Unknown tool : {tool_name}")
                tool_content = {"error": f"Unknown tool: {tool_name}"}

            tool_results.append({
                "type":        "tool_result",
                "tool_use_id": block.id,
                "content":     json.dumps(tool_content, default=str),
            })

        if should_break:
            break

        messages.append({"role": "user", "content": tool_results})

    # ── Phase 2: streaming final response with Sonnet ─────────────────────────
    # Only run if we actually called tools and need a natural-language reply.
    if ran_tools:
        response_model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")
        final_text = ""
        try:
            with client.messages.stream(
                model      = response_model,
                max_tokens = 2048,
                system     = system_param,
                messages   = messages,
            ) as stream:
                for chunk in stream.text_stream:
                    clean = _clean_chunk(chunk)
                    if clean:
                        final_text += clean
                        yield {"type": "text_delta", "text": clean}
        except Exception as exc:
            logger.error(f"[Stream] Sonnet streaming error: {exc}")
            if not final_text:
                # Fall back to a canned summary
                if all_attributes:
                    final_text = f"Found {len(all_attributes)} record(s)."
                elif all_stats:
                    final_text = "Statistics computed."
                else:
                    final_text = "Query completed."
                yield {"type": "text_delta", "text": final_text}
    elif final_text and not ran_tools:
        # Haiku went end_turn on the GIS path without a successful tool call.
        # Its text may reference data it never actually retrieved — don't trust it.
        # If it sounds like a data result ("found", "on the map"), replace with a safe fallback.
        clean = _clean_chunk(final_text).strip()
        _hallucination_phrases = ("on the map", "found", "displayed", "highlighted", "plotted")
        if any(p in clean.lower() for p in _hallucination_phrases):
            logger.warning("[Stream] Suppressing potential Haiku hallucination (no tool succeeded)")
            final_text = "I couldn't retrieve that data — the field name may not be available. Try asking 'show me the largest Masdar plots' for a fresh query."
        else:
            final_text = clean or "No results found for your query."
        yield {"type": "text_delta", "text": final_text}
    else:
        final_text = "No results found for your query."
        yield {"type": "text_delta", "text": final_text}

    # ── Final result event ────────────────────────────────────────────────────
    result_entry: Dict[str, Any] = {
        "description":   final_text,
        "message":       final_text,
        "attributes":    all_attributes,
        "tool_executed": ran_tools,
    }
    if all_stats:
        result_entry["stats"] = all_stats
    if all_distinct:
        result_entry["distinct_values"] = all_distinct

    yield {"type": "result", "data": {"results": [result_entry]}}


# ---------------------------------------------------------------------------
# MCP mode — tool execution via GeoAI MCP server subprocess
# ---------------------------------------------------------------------------

# Path to the GeoAI MCP server script
_GEOAI_SERVER = str(
    Path(__file__).parent.parent
    / "mcp-server-arcgis" / "src" / "mcp_arcgis" / "geoai_server.py"
)

# geoai_server.py uses only requests + python-dotenv (both already in the GeoAI
# venv). No mcp package needed — the server implements the protocol from scratch.
def _mcp_python() -> str:
    return sys.executable


# Module-level backend mode flag (set by /api/mode endpoint)
_BACKEND_MODE: str = "API"


def set_backend_mode(mode: str) -> None:
    """Switch between 'API' (direct) and 'MCP' (subprocess) tool execution."""
    global _BACKEND_MODE
    _BACKEND_MODE = mode.upper()
    logger.info("Backend mode set to: %s", _BACKEND_MODE)


def get_backend_mode() -> str:
    return _BACKEND_MODE


def _call_tool_mcp(tool_name: str, tool_input: dict) -> dict:
    """
    Call a tool on the GeoAI MCP server using JSON-RPC 2.0 over stdio.
    Uses Content-Length framing (same as LSP). No mcp library needed here.
    """
    import subprocess as _sp

    def _send(proc, msg: dict) -> None:
        body   = json.dumps(msg).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        proc.stdin.write(header + body)
        proc.stdin.flush()

    def _recv(proc) -> Optional[dict]:
        headers: dict = {}
        while True:
            raw = proc.stdout.readline()
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
        body = proc.stdout.read(length)
        return json.loads(body.decode("utf-8"))

    proc = _sp.Popen(
        [_mcp_python(), _GEOAI_SERVER],
        stdin=_sp.PIPE,
        stdout=_sp.PIPE,
        stderr=_sp.DEVNULL,
        env={**os.environ},
    )

    try:
        _send(proc, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities":    {},
                "clientInfo":      {"name": "geoai-flask", "version": "1.0"},
            },
        })
        _recv(proc)
        _send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        _send(proc, {
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": tool_name, "arguments": tool_input},
        })
        resp = _recv(proc)
        if resp and "result" in resp:
            content = resp["result"].get("content", [])
            if content and content[0].get("type") == "text":
                return json.loads(content[0]["text"])
        if resp and "error" in resp:
            return {"error": resp["error"].get("message", "MCP error")}
        return {"error": "No result from MCP server"}
    except Exception as exc:
        logger.error("MCP call error: %s", exc)
        return {"error": str(exc)}
    finally:
        try:
            proc.stdin.close()
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            pass


def run_agent_stream_mcp(
    user_message: str,
    chat_history: List[Dict],
    geometry_info: Optional[Dict] = None,
):
    """MCP-mode streaming generator. Same pipeline as run_agent_stream but
    tool execution goes through the GeoAI MCP server subprocess."""
    print("\n" + "#" * 60)
    print("  [MCP] Backend Mode : MCP  (JSON-RPC 2.0 subprocess)")
    print(f"  [Query] {user_message[:100]}")
    if geometry_info:
        print(f"  [Geom]  {geometry_info.get('type')} spatial filter")
    print("#" * 60 + "\n")

    if _check_injection(user_message):
        logger.warning("[Security] Prompt injection blocked (MCP mode): %s", user_message[:100])
        msg = "I can only help with geospatial queries about the property database."
        yield {"type": "text_delta", "text": msg}
        yield {"type": "result", "data": {"results": [{"description": msg, "message": msg, "attributes": []}]}}
        return

    client       = _get_client()
    skill_content = _detect_skill(user_message)
    full_system  = _STATIC_PROMPT + "\n\n---\n\n" + _get_field_context()
    system_param = [{"type": "text", "text": full_system, "cache_control": {"type": "ephemeral"}}]

    user_content = user_message
    messages     = _convert_history(chat_history[:-1])

    # Strip non-ASCII before Haiku tool call
    _non_ascii_re_mcp = re.compile(r'[^\x00-\x7F]+')
    _cleaned_mcp = _non_ascii_re_mcp.sub(' ', user_content).strip()
    _cleaned_mcp = ' '.join(_cleaned_mcp.split())
    if _cleaned_mcp and _cleaned_mcp != user_content.strip():
        logger.info("[MCP] Non-ASCII stripped: '%s' -> '%s'", user_message[:60], _cleaned_mcp[:60])
        messages.append({"role": "user", "content": _cleaned_mcp})
    else:
        messages.append({"role": "user", "content": user_content})

    if not geometry_info and not _is_gis_query(user_message, chat_history):
        logger.info("[MCP mode] Conversational fast path")
        yield from run_agent_stream(user_message, chat_history, geometry_info)
        return

    all_attributes: List[Any] = []
    all_stats:      List[Any] = []
    all_distinct:   List[Any] = []
    final_text      = ""
    user_low        = user_message.lower()
    is_count_intent = any(kw in user_low for kw in _COUNT_KEYWORDS)
    seen_calls: set = set()
    ran_tools       = False
    _spatial_first_done_mcp: bool = False

    yield {"type": "status", "text": "Routing via MCP server..."}

    for iteration in range(1, 5):
        tc = {"type": "any"} if iteration == 1 else {"type": "auto"}
        response = client.messages.create(
            model=_TOOL_MODEL, max_tokens=256, system=system_param,
            tools=TOOL_DEFINITIONS, tool_choice=tc, messages=messages,
        )
        logger.info("[MCP iter %d] stop=%s", iteration, response.stop_reason)

        for block in response.content:
            if hasattr(block, "text"):
                final_text = block.text.strip()

        if response.stop_reason == "end_turn":
            break
        if response.stop_reason != "tool_use":
            break

        messages.append({"role": "assistant", "content": response.content})
        tool_results = []
        should_break = False

        for block in response.content:
            if block.type != "tool_use":
                continue
            tool_name  = block.name
            tool_input = block.input or {}
            call_sig = f"{tool_name}:{json.dumps(tool_input, sort_keys=True, default=str)}"
            if call_sig in seen_calls:
                should_break = True
                break
            seen_calls.add(call_sig)

            if tool_name == "query_layer":
                yield {"type": "status", "text": "Querying via MCP server..."}
                has_stats = bool(
                    tool_input.get("out_statistics") or
                    tool_input.get("group_by_fields") or
                    tool_input.get("return_distinct_values")
                )
                if tool_input.get("return_count_only") and not (is_count_intent or has_stats):
                    tool_input["return_count_only"] = False
                if not (is_count_intent or has_stats or tool_input.get("return_count_only")):
                    tool_input["return_geometry"] = True
                if geometry_info:
                    tool_input["geometry"]      = geometry_info["geometry"]
                    tool_input["geometry_type"] = geometry_info["geometry_type"]
                    if geometry_info.get("type") == "Point":
                        dist = geometry_info.get("distance")
                        if dist:
                            tool_input["distance"] = dist
                print(f"  [Tool] query_layer  [via MCP subprocess]")
                print(f"  [Input] {json.dumps(tool_input, default=str)[:300]}")
                try:
                    result = _call_tool_mcp("query_layer", tool_input)
                    if "error" in result:
                        raise RuntimeError(result["error"])
                    print(f"  [Result] count={result.get('count', 0)}\n")
                    if not geometry_info or not _spatial_first_done_mcp:
                        all_attributes.extend(result.get("attributes", []))
                    else:
                        logger.info("[MCP] Spatial guard: ignoring secondary attributes")
                    if geometry_info:
                        _spatial_first_done_mcp = True
                    if result.get("stats"):
                        all_stats.extend(result["stats"])
                    if result.get("distinct_values"):
                        all_distinct.extend(result["distinct_values"])
                    ran_tools = True
                    tool_content = {
                        "count":            result.get("count", 0),
                        "summary":          result.get("summary", ""),
                        "stats":            result.get("stats"),
                        "distinct_values":  result.get("distinct_values"),
                        "sample_records":   result.get("attributes", [])[:2],
                        "group_count":      result.get("group_count"),
                        "total_from_stats": result.get("total_from_stats"),
                    }
                    tool_content = {k: v for k, v in tool_content.items() if v is not None}
                except Exception as exc:
                    logger.error("[MCP] query_layer failed: %s", exc)
                    tool_results.append({
                        "type": "tool_result", "tool_use_id": block.id,
                        "content": json.dumps({"error": str(exc), "hint": "Try a simpler WHERE clause."}),
                        "is_error": True,
                    })
                    messages.append({"role": "user", "content": tool_results})
                    tool_results = []
                    continue

            elif tool_name == "get_field_info":
                print("  [Tool] get_field_info  [via MCP subprocess]")
                try:
                    result = _call_tool_mcp("get_field_info", {})
                    if "error" in result:
                        raise RuntimeError(result["error"])
                    tool_content = result
                    ran_tools = True
                except Exception as exc:
                    logger.error("[MCP] get_field_info failed: %s", exc)
                    tool_results.append({
                        "type": "tool_result", "tool_use_id": block.id,
                        "content": json.dumps({"error": str(exc)}), "is_error": True,
                    })
                    messages.append({"role": "user", "content": tool_results})
                    tool_results = []
                    continue
            else:
                tool_content = {"error": f"Unknown tool: {tool_name}"}

            tool_results.append({
                "type": "tool_result", "tool_use_id": block.id,
                "content": json.dumps(tool_content, default=str),
            })

        if should_break:
            break
        messages.append({"role": "user", "content": tool_results})

    if ran_tools:
        response_model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")
        final_text = ""
        try:
            with client.messages.stream(
                model=response_model, max_tokens=2048,
                system=system_param, messages=messages,
            ) as stream:
                for chunk in stream.text_stream:
                    clean = _clean_chunk(chunk)
                    if clean:
                        final_text += clean
                        yield {"type": "text_delta", "text": clean}
        except Exception as exc:
            logger.error("[MCP] Sonnet error: %s", exc)
            final_text = f"Found {len(all_attributes)} record(s)." if all_attributes else "Query completed."
            yield {"type": "text_delta", "text": final_text}
    elif final_text and not ran_tools:
        clean = _clean_chunk(final_text).strip()
        _hallucination_phrases = ("on the map", "found", "displayed", "highlighted", "plotted")
        if any(p in clean.lower() for p in _hallucination_phrases):
            logger.warning("[MCP] Suppressing Haiku hallucination (no tool succeeded)")
            final_text = "I could not retrieve that data - try rephrasing as a fresh query."
        else:
            final_text = clean or "No results found for your query."
        yield {"type": "text_delta", "text": final_text}
    else:
        final_text = "No results found for your query."
        yield {"type": "text_delta", "text": final_text}

    result_entry: Dict[str, Any] = {
        "description":   final_text,
        "message":       final_text,
        "attributes":    all_attributes,
        "tool_executed": ran_tools,
        "via_mcp":       True,
    }
    if all_stats:
        result_entry["stats"] = all_stats
    if all_distinct:
        result_entry["distinct_values"] = all_distinct

    yield {"type": "result", "data": {"results": [result_entry]}}
