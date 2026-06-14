# GeoAI — Conversational GIS Platform

https://claudegeoai.onrender.com/

GeoAI lets you explore land and property data through plain English. Instead of navigating GIS software or writing queries, you type a question — *"Show me vacant Seha plots in Abu Dhabi"* — and the map updates, the table fills, and you get a written summary, all within a few seconds.

Built on Anthropic Claude, ESRI ArcGIS, React, and Flask.

---

## Background 

Working with geospatial data usually requires GIS expertise — you need to know the right tools, the right field names, and how to construct spatial filters. GeoAI removes that barrier. Anyone on the team can ask a question and get an answer directly from the live data.

---

## What You Can Do

**Ask questions in plain English**
Type queries like "Show me operational properties in Al Ain" and get live results on the map with a written summary.

**Click or draw on the map**
Click a point or draw a polygon boundary on the map — GeoAI automatically detects the geometry and finds all features within that area.

**Upload files**
Attach an image or PDF — a scanned site plan, hand-drawn sketch, GPS export, or survey document. GeoAI reads the file, extracts any location information using AI vision, and pins those locations on the map.

**Switch execution modes**
A toggle in the header lets you switch between two backend modes:
- **API** — direct in-process tool execution, fastest path
- **MCP** — queries route through a separate Model Context Protocol server over JSON-RPC 2.0, demonstrating how AI agents communicate with external tools using open standards

---

## How It Works

When you send a message, the backend runs a two-phase process:

**Phase 1 — Tool decision (Claude Haiku)**
A lightweight model looks at your question and decides what ArcGIS query to build. It uses tool-use with `tool_choice: any` to guarantee a structured call rather than a prose reply. This takes about 1 second.

**Phase 2 — Response generation (Claude Sonnet)**
Once the ArcGIS data comes back, a more capable model turns the raw results into a natural language response, streamed back to the browser word by word via Server-Sent Events.

The system prompt also handles follow-up logic — if you say "just the vacant ones" after a Seha query, GeoAI knows to stack that filter rather than start fresh.

---

## Agents

Three agents are implemented in this project:

**GIS Agent** (`claude_agent.py → run_agent_stream`) — the main query agent. Haiku decides which ArcGIS tool to call and with what parameters, the tool executes, then Sonnet streams a natural language response back to the browser.

**File Agent** (`file_agent.py → run_file_agent_stream`) — a single-turn subagent. Takes an uploaded image or PDF, sends it to Claude Vision to extract coordinates and geometries, and returns them to the map. No tool loop — one call, one result.

**MCP Agent** (`claude_agent.py → run_agent_stream_mcp`) — identical logic to the GIS Agent but tool execution routes through the `geoai_server.py` subprocess over JSON-RPC 2.0 instead of running in-process.

---

## MCP Implementation

The MCP server (`geoai_server.py`) is built from scratch using only the Python standard library and `requests` — no MCP SDK required.

**Protocol:** JSON-RPC 2.0 over stdio with Content-Length framing, the same transport used by the Language Server Protocol (LSP).

**Tools exposed:**
- `query_layer` — queries the ArcGIS Feature Service with WHERE clause, spatial filters, statistics, and distinct values
- `get_field_info` — returns field names, aliases, and types for the layer

This demonstrates how AI agents can communicate with external tool servers using an open standard — the same pattern used in production agentic systems.

---

## Tool Error Recovery

When a tool call fails (network error, bad WHERE clause, ArcGIS timeout), the error is returned to Claude as a `tool_result` block with `is_error: true` and a hint. The agent loop continues so Claude can see what went wrong and reattempt with corrected parameters rather than silently failing.

---

## Prompt Injection Guard

User input is screened before it reaches the agent loop. A regex-based guard detects common injection patterns — `"ignore previous instructions"`, `"you are now"`, `"act as"`, `"jailbreak"`, `"override system prompt"` and others. Flagged messages are blocked immediately and never reach the LLM. The warning is logged server-side for audit.

---

## Conversation History Trimming

To prevent context window bloat over long sessions, only the last 8 messages (4 exchanges) from chat history are sent to the model on each request. Location result messages are excluded — only actual user/assistant turns are counted. This keeps token usage bounded without losing meaningful conversational context.


---

## Architecture

```
Browser (React + Leaflet)
        │  SSE stream
        ▼
Flask  /api/chat
        │
        ├── Routing heuristic (_is_gis_query)
        │       ├── Greeting / UI command → fast conversational path
        │       └── GIS intent → agentic tool loop
        │
        ├── Claude Haiku  (tool_choice=any)
        │       └── Calls query_layer or get_field_info
        │
        ├── ArcGIS REST API  (5-min in-memory cache)
        │
        └── Claude Sonnet  → streams prose response via SSE
```

**MCP mode** replaces the direct ArcGIS call with a subprocess:

```
Flask → _call_tool_mcp() → geoai_server.py (subprocess)
              JSON-RPC 2.0 over stdio
              Content-Length framing (same as LSP protocol)
```

---

## Project Structure

```
GeoAI/
├── api/
│   ├── App.py              # Flask routes — /api/chat, /api/fields, /api/mode, /api/upload
│   ├── claude_agent.py     # Agentic loop, routing heuristic, streaming, MCP path
│   ├── mcp_tools.py        # ArcGIS tool definitions, query execution, cache
│   └── file_agent.py       # Claude Vision geometry extractor for uploaded files
├── mcp-server-arcgis/
│   └── src/mcp_arcgis/
│       └── geoai_server.py # Standalone MCP server — JSON-RPC 2.0 over stdio
├── prompts/
│   ├── system.md           # System prompt — role, response rules, query intelligence
│   └── query_rules.md      # Follow-up stacking logic (Cases 1–4)
├── src/
│   ├── App.tsx             # Root layout — resizable panels, mobile tab bar
│   └── components/
│       ├── ChatBot.tsx     # SSE consumer, file upload button, message list
│       ├── Map.tsx         # Leaflet map, polygon draw, click handler, popups
│       ├── ResultsTable.tsx# Paginated attribute table with export
│       └── Header.tsx      # API/MCP toggle, dark mode
├── config.py
└── requirements.txt
```

---

## Running Locally

```bash
# Backend
pip install -r requirements.txt
cd api && flask run           # http://localhost:5000

# Frontend (separate terminal)
npm install && npm run dev    # http://localhost:5173
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic Claude API key |
| `VITE_MAP_SERVICE_URL` | Yes | ArcGIS FeatureServer base URL |
| `VITE_API_URL` | Yes | Flask backend URL (`http://localhost:5000` for dev) |
| `CLAUDE_MODEL` | No | Sonnet model override (default: `claude-sonnet-4-6`) |

---

## Key Design Decisions

**Two-model pipeline**
Haiku handles tool decisions — it's fast and cheap, and `tool_choice: any` forces a structured tool call rather than a prose guess. Sonnet only runs for the final response where quality matters. This cut first-token latency from ~13s to ~1-2s.

**Routing heuristic before any LLM call**
A four-rule function (`_is_gis_query`) classifies the message in microseconds. Greetings and UI commands skip the tool loop entirely and go straight to a lightweight conversational path.

**Prompt caching**
The system prompt (~800 tokens) is sent with `cache_control: ephemeral`. Anthropic caches it server-side, avoiding re-tokenisation on every request.

**In-memory ArcGIS query cache**
Query results are cached by MD5 hash of the request parameters with a 5-minute TTL. A repeated query returns in under 50ms.

**MCP server from scratch**
`geoai_server.py` implements the Model Context Protocol over stdio using only the Python standard library and `requests` — no MCP SDK required. It handles the full JSON-RPC 2.0 handshake, tools/list, and tools/call.

**Query intelligence**
The system prompt defines four cases for how follow-up questions interact with previous filters. "Show me vacant ones" after a portfolio query stacks the filter; "Show me ADNOC plots" starts fresh. This logic lives in the prompt, not in code.
