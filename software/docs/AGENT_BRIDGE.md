# Agent tooling (Cursor ↔ Command Center)

The Command Center exposes a **localhost-only agent bridge** so Cursor can screenshot windows, read structured UI state, and drive map/page controls while iterating UI fixes.

## Enable

Default in development (`npm run dev`):

| Variable | Default (dev) | Meaning |
|----------|---------------|---------|
| `OW_AGENT_BRIDGE` | on (`0` to disable) | HTTP control API |
| `OW_AGENT_PORT` | `17832` | Bridge port |
| `OW_CDP_PORT` | `9222` | Chromium remote debugging |

Production builds keep the bridge **off** unless `OW_AGENT_BRIDGE=1`.

```bash
npm run dev
# optional explicitly:
# set OW_AGENT_BRIDGE=1 && set OW_CDP_PORT=9222 && npm run dev
```

## HTTP API (`http://127.0.0.1:17832`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness + window count |
| GET | `/windows` | Open windows (id, page, bounds) |
| GET | `/state?page=Radar` | Map / radar / page state from renderer |
| POST | `/screenshot` | `{ "page": "Dashboard" }` → PNG path under Electron `userData/agent-captures` |
| POST | `/command` | `{ "page": "Radar", "command": { ... } }` |

### Command examples

```json
{ "command": { "type": "open_page", "page": "Radar" } }
{ "command": { "type": "focus_main" } }
{ "page": "Radar", "command": { "type": "set_basemap", "basemap": "satellite" } }
{ "page": "Radar", "command": {
  "type": "set_location",
  "location": { "lat": 33.75, "lon": -84.39, "label": "Atlanta", "zoom": 8 }
}}
{ "page": "Radar", "command": { "type": "set_overlays", "pressure": true, "wind": false } }
{ "page": "Radar", "command": { "type": "set_layer_preset", "preset": "analysis" } }
{ "page": "Radar", "command": { "type": "set_radar_playing", "playing": false } }
{ "page": "Radar", "command": { "type": "set_radar_frame", "frameIndex": 4 } }
{ "page": "Dashboard", "command": { "type": "navigate_hash", "page": "Settings" } }
{ "command": { "type": "reload" } }
```

Shell quick test (PowerShell):

```powershell
Invoke-RestMethod http://127.0.0.1:17832/health
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:17832/screenshot -ContentType 'application/json' -Body '{"page":"Dashboard"}'
```

## Cursor MCP

Registered in both:

- Project: [`.cursor/mcp.json`](../.cursor/mcp.json)
- User global: `~/.cursor/mcp.json` as **open-weather-agent**

Server: `software/agent/mcp-server.mjs` using **@modelcontextprotocol/sdk** (newline-delimited JSON-RPC on stdio — required by Cursor MCP V2).

> Note: older Content-Length (LSP-style) framing will make Cursor time out on initialize.

### Enable / refresh in Cursor

1. Keep the app running (`npm run dev` in `software/`).
2. Open **Cursor Settings → MCP**.
3. Confirm **open-weather-agent** is listed and enabled (green).
4. Toggle off/on or restart Cursor after MCP server changes.
5. Tools: `ow_health`, `ow_list_windows`, `ow_get_state`, `ow_screenshot`, `ow_command`.

If logs show `Request timed out` after “started” but never list tools, the process is up but handshake failed — ensure the SDK-based `mcp-server.mjs` is running (not a Content-Length-only server).



## Chrome DevTools Protocol

With CDP on port `9222`, Cursor / Puppeteer / chrome://inspect can attach for DOM inspection. Prefer the agent bridge for screenshots and product-level commands so multi-window Electron stays predictable.

## Security

- Bind is **127.0.0.1 only**
- Non-local sockets get `403`
- Bridge defaults **off** in packaged builds
- Do not expose the port over the network
