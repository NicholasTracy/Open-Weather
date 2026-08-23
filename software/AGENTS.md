# Agent notes — Open Weather Command Center

## Fast visual iteration loop

1. User runs `npm run dev` in `software/` (agent bridge on `http://127.0.0.1:17832`, CDP `9222`).
2. Prefer **open-weather-agent MCP** (`ow_screenshot`, `ow_command`, `ow_get_state`) or raw HTTP against the bridge. See `docs/AGENT_BRIDGE.md`.
3. After UI code changes, reload is automatic via Vite HMR; if not, `ow_command` with `{ "type": "reload" }`.
4. Capture `ow_screenshot` with `page: "Dashboard"` or `"Radar"`, then **Read** the returned PNG path to verify layout/colors/controls.
5. Drive the map without clicking: `set_location`, `set_basemap`, `set_overlays`, `set_radar_playing` / `set_radar_frame`.

## Do not

- Do not assume detached Radar controls exist on Dashboard until the map is mounted (dashboard embeds the same map component).
- Do not open remote ports or disable localhost-only checks.
