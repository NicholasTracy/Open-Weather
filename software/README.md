# Open Weather Command Center

Electron + React + TypeScript desktop app for monitoring and managing Open Weather stations.

## Develop

```bash
npm install
npm run dev
```

In development the **agent bridge** is on by default (`http://127.0.0.1:17832`) so Cursor can screenshot windows and drive the UI. Details: [docs/AGENT_BRIDGE.md](./docs/AGENT_BRIDGE.md). Set `OW_AGENT_BRIDGE=0` to disable.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Electron + Vite (agent bridge + CDP on in dev) |
| `npm run build` | Compile main / preload / renderer |
| `npm run dist` | Package installers via electron-builder |
| `npm run typecheck` | TypeScript checks |
| `npm run agent:mcp` | Stdio MCP server for Cursor (needs running app) |

## Multi-window

Borrowed from Captivate 2:

- One **main** Dashboard window
- Detached page windows (Radar, Sensors, History, Stations, Settings) — single instance per page
- Window bounds persisted under Electron `userData`
- Optional `displayId` when opening a detached window

## Live radar

Uses [RainViewer](https://www.rainviewer.com/api.html) for a worldwide mosaic (past ~2 hours) and **NOAA NEXRAD Level II** (nearest WSR-88D, super-res reflectivity) on the Radar map. Level II is decoded in the desktop process from the public Unidata S3 archive and drawn with WebGL. Pin location is stored in `localStorage`. RainViewer discontinued free nowcast tiles in January 2026.

## Forecast blend

The dashboard 10-day outlook blends ECMWF **AIFS** (Euro AI), ECMWF IFS, NOAA GFS, and DWD ICON, and compares that blend to Open-Meteo’s public best-match 10-day. Use Blend / Open-Meteo / Compare on the panel. A lower-confidence monthly strip uses ECMWF EC46 weekly + SEAS5 monthly anomalies. When a local station is linked later, day-0 highs/lows can be nudged toward live observations.

Overlay toggles:

- **Pressure** — isobars with high/low centers from a dense viewport grid (up to ~450 Open-Meteo samples)
- **Fronts** — cold (blue triangles) / warm (red scallops) / stationary fronts extrapolated from temperature gradient + wind
- **Cities** — current temp plus daily high/low for major cities in view
