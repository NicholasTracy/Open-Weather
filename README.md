<p align="center">
  <img src="Media/img/openweather_logo.svg" alt="Open Weather" width="140" />
</p>

<h1 align="center">Open Weather</h1>

<p align="center">
  <strong>Your weather. Your station. Your computer.</strong><br />
  Free, open source, and built to work even when the internet does not.
</p>

<p align="center">
  <a href="https://github.com/NicholasTracy/Open-Weather/actions/workflows/ci.yml?query=branch%3Amaster"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/NicholasTracy/Open-Weather/ci.yml?branch=master&event=push&label=CI" /></a>
  &nbsp;
  <a href="https://github.com/NicholasTracy/Open-Weather/blob/master/software/package.json"><img alt="Version" src="https://img.shields.io/github/package-json/v/NicholasTracy/Open-Weather?filename=software/package.json&label=version" /></a>
  &nbsp;
  <a href="https://github.com/NicholasTracy/Open-Weather/releases"><img alt="Release" src="https://img.shields.io/github/v/release/NicholasTracy/Open-Weather?include_prereleases&sort=semver&label=release" /></a>
  <br /><br />
  <a href="https://github.com/NicholasTracy/Open-Weather/blob/master/LICENSE"><img alt="License" src="https://img.shields.io/github/license/NicholasTracy/Open-Weather" /></a>
  &nbsp;
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white" />
  &nbsp;
  <a href="https://github.com/NicholasTracy/Open-Weather/issues"><img alt="Issues" src="https://img.shields.io/github/issues/NicholasTracy/Open-Weather" /></a>
  <br /><br />
  <img alt="Windows" src="https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white" />
  &nbsp;
  <img alt="macOS" src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white" />
  &nbsp;
  <img alt="Linux" src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black" />
</p>

Open Weather is a DIY weather project. Build a station from parts you can buy and print, run the software on your own computer, and keep a live picture of the weather right where you are.

Nothing is stored in someone else’s cloud. There is no account to create and no subscription to pay. When the network is down, your station and the app still work. When the network is up, we fill in the wider view from public government and research sources.

## Why this exists

Most weather apps lock you into a service. Open Weather is the other path: **self-reliance**.

- **Build it yourself** — stations from common hardware, 3D-printed parts, and open firmware
- **Keep it local** — readings stay on your machine
- **Stay useful offline** — monitor and record hyper-local weather with no connection
- **Use the public record when you can** — radar, satellite, alerts, and a 10-day outlook from sources that are already free

## What you get today

The **Command Center** is the desktop app (Windows, macOS, and Linux).

- A dashboard for live conditions at your pin
- High-resolution weather radar from **NOAA** NEXRAD
- **GOES** satellite pictures from **NOAA**
- Weather alerts from the **National Weather Service (NWS)**
- A 10-day outlook that blends free public models through **Open-Meteo**, plus **NWS / NOAA** guidance
- Storm outlooks and surface analysis from **NOAA** when you want the bigger picture

Connect a home station when you have one. Until then, the map and outlook still work from those public sources.

## Local first. Internet optional.

| You have… | Open Weather can… |
| --- | --- |
| A station, no internet | Show live local readings and keep history on your computer |
| Internet, no station | Show radar, satellite, alerts, and the 10-day outlook |
| Both | Combine your backyard numbers with the national picture |

We do not upload your location history, station data, or personal information to an Open Weather server. There isn’t one.

## Build a station

The long-term goal is a station anyone can make:

- Parts that are easy to find
- 3D-printed housings and mounts
- Open firmware you can flash and change
- Software that talks to the station on your own network

Hardware and print files are still coming back into this repo. Outdoor print material notes are in [Issue #1](https://github.com/NicholasTracy/Open-Weather/issues/1) and the [filament spreadsheet](https://docs.google.com/spreadsheets/d/1O-heHT2M7XdvT4qFRkZZBCX_Tv8IUrr2iZ7YO4e-dkw/edit?usp=sharing).

## Sharing, later — still private

On the roadmap is a network of home stations that can fill gaps for neighbors and for the outlook.

Stations will be able to share readings over the internet, **LoRa** mesh, and similar links. Sharing is **anonymous**. No names, no accounts, no household data — only weather.

That network is not built yet. The app is designed so it never has to depend on it.

## Help

| Link | What it is |
| --- | --- |
| [Troubleshooting](TROUBLESHOOTING.md) | App, radar, and installer fixes |
| [Contributing](CONTRIBUTING.md) | How to send a change |
| [Wiki](https://github.com/NicholasTracy/Open-Weather/wiki) | Guides and design rules |
| [Releases](https://github.com/NicholasTracy/Open-Weather/releases) | Windows, macOS, and Linux builds |

## Try the Command Center

```bash
cd software
npm install
npm run dev
```

To package an installer:

```bash
cd software
npm run dist:win    # Windows NSIS
npm run dist:mac    # macOS disk image (unsigned / ad-hoc)
npm run dist:linux  # Debian package
```

## In this repository

| Folder | What it is |
| --- | --- |
| `software/` | Command Center desktop app |
| `Media/` | Logo and brand images |
| `3D Printed Parts/` | Station print files (coming) |
| `Boards/` | Open hardware designs (coming) |

## License

Open Weather is free software under the [GNU GPLv3](LICENSE). Use it, share it, and improve it.
