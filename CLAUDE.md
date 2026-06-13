# GeoAI — Codebase Guide for Claude

GeoAI is a full-stack GIS chatbot that answers natural-language queries against an
ESRI ArcGIS Feature Service using the Anthropic Claude API.
React + Leaflet frontend, Flask backend, SSE streaming.

---

## Architecture Overview

```
src/ (React + TypeScript + Vite)          api/ (Flask + Python)
├── App.tsx          ← root layout         ├── App.py          ← routes only
├── components/                            ├── claude_agent.py ← agentic loop
│   ├── ChatBot.tsx  ← SSE consumer        ├── mcp_tools.py    ← ArcGIS tools
│   ├── Map.tsx      ← Leaflet map         prompts/
│   ├── ResultsTable.tsx                   └── system.md       ← system prompt
│   └── Header.tsx
└── services/
    ├── api.ts       ← fetch + SSE client
    └── gisfunctions.ts ← Leaflet helpers
```

**Single ArcGIS FeatureServer layer** — all queries hit `/0/query` on the URL in `.env`.

---

## Key Design Decisions

### Two-model pipeline
- **Haiku** (`claude-haiku-4-5-20251001`) — tool-call decision only (`tool_choice: any`)
- **Sonnet** (`claude-sonnet-4-6`) — final streamed prose response

Keeping these separate reduces first-token latency from ~13 s to ~1–2 s.

### Routing heuristic (`_is_gis_query` in `claude_agent.py`)
No LLM call is made to decide routing. A 4-rule heuristic runs in microseconds:
1. Greeting → conversational path
2. UI verb at start (clear, pan, zoom, reset…) → conversational path
3. GIS keyword (plot, property, portfolio…) → GIS tool loop
4. Known field value (portfolio name, city, status from `_FIELD_CACHE`) → GIS tool loop

### Prompt caching
System prompt has `cache_control: ephemeral` — avoids re-tokenising ~800 tokens
on every request. Critical for latency on repeated calls.

### In-memory ArcGIS query cache
`mcp_tools.py` caches query results by MD5(params) with a 5-minute TTL.
Second identical query returns in <50 ms instead of ~2 s.

### Query Intelligence (system prompt)
Four cases defined in `prompts/system.md`:
- **Case 1** — New portfolio name → fresh WHERE clause (never inherit previous filters)
- **Case 2** — Qualifier-only follow-up → stack with previous WHERE clause
- **Case 3** — Explicit continuation ("also", "within those") → always stack
- **Case 4** — Full independent query → fresh

---

## File Reference

| File | Purpose |
|---|---|
| `api/App.py` | Flask routes: `/api/chat` (SSE), `/api/fields`, `/api/support/email` |
| `api/claude_agent.py` | `_is_gis_query()`, `run_agent_stream()`, tool-use loop, streaming |
| `api/mcp_tools.py` | `TOOL_DEFINITIONS`, `execute_query_layer()`, in-memory cache |
| `prompts/system.md` | System prompt — role, response rules, query intelligence |
| `config.py` | Reads `.env` — exposes `MAP_SERVICE_URL` |
| `src/App.tsx` | Root: resizable panels (drag dividers), mobile tab bar, no login |
| `src/components/ChatBot.tsx` | SSE consumer, message state, geometry auto-send |
| `src/components/Map.tsx` | Leaflet map, polygon draw, feature zoom, click handler |
| `src/components/ResultsTable.tsx` | Paginated attribute table, export |
| `src/services/api.ts` | `sendChatMessageStream()` — SSE fetch + event parsing |
| `src/services/gisfunctions.ts` | `gisService`: Leaflet layer add/clear/zoom |

---

## Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-...          # Required
VITE_MAP_SERVICE_URL=https://...      # ArcGIS FeatureServer base URL
VITE_API_URL=http://localhost:5000    # Flask backend (dev)
CLAUDE_MODEL=claude-sonnet-4-6        # Sonnet model override
```

Copy `.env.example` → `.env` before running.

---

## Running Locally

```bash
# Backend
pip install -r requirements.txt
cd api && flask run          # http://localhost:5000

# Frontend (separate terminal)
npm install && npm run dev   # http://localhost:5173
```

---

## Common Tasks

**Add a new ArcGIS tool** — edit `api/mcp_tools.py`:
1. Add tool definition to `TOOL_DEFINITIONS` list
2. Add handler to `execute_query_layer()` or create a new `execute_*` function
3. Register it in the dispatch block in `claude_agent.py`

**Change the system prompt** — edit `prompts/system.md`.
No restart needed in dev if Flask reloads on file change.

**Add a UI panel** — all panels live in `src/App.tsx`.
Resizable state is `leftWidth` (horizontal split %) and `chatHeight` (vertical split %).

**Change models** — set `CLAUDE_MODEL` in `.env` for Sonnet.
Haiku is hardcoded in `claude_agent.py` as `_TOOL_MODEL` — change there if needed.

---

## What NOT to Do

- **Do not add FAISS** — field info is fetched directly from ArcGIS at startup (`App.py → _fetch_layer_fields()`). FAISS is not needed.
- **Do not set `result_record_count`** unless the user asks for top-N — the system applies the 2000-record ArcGIS cap automatically.
- **Do not strip whitespace from individual SSE stream chunks** — spaces between chunks preserve word boundaries. Only strip complete Haiku end_turn responses.
- **Do not add `"map"` to `_GIS_KEYWORDS`** — it catches UI commands like "pan map to left".
