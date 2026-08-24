# Troubleshooting

Start here if the Command Center will not run, radar is empty, or a Windows install is blocked.

## The app will not start

From `software/`:

```bash
npm install
npm run dev
```

If that fails:

- Use Node.js 20 or newer.
- Delete `software/node_modules` and run `npm install` again.
- On Windows, close any already-running Open Weather window and try once more.

## Radar or satellite looks empty

- Confirm you have internet. Radar, GOES pictures, and alerts come from NOAA / NWS when you are online.
- Check the pin location. The map follows the pin, not a cloud account.
- Hydrometeor view hides ground clutter and bugs. Switch the radar product to reflectivity if you are looking for raw echoes.
- Clear-air days over dry ground can look empty. That can be correct.

## Alerts or the 10-day outlook are missing

- Those need a network connection.
- Outlooks come from Open-Meteo and NWS / NOAA. A short outage on those services will leave the panel blank until they return.

## Windows says the installer is unknown

The current Windows build is not code-signed. SmartScreen may warn.

Choose **More info**, then **Run anyway**, if you built or downloaded the installer from this project.

Rebuild it yourself with:

```bash
cd software
npm run dist:win
```

The file lands in `software/release/`.

## macOS says the app is damaged or cannot be opened

Release builds are not signed with an Apple Developer certificate. After you copy the app out of the disk image:

```bash
xattr -cr "/Applications/Open Weather Command Center.app"
codesign --force --deep --sign - "/Applications/Open Weather Command Center.app"
```

Then open it from Finder (right-click, Open) the first time.

Rebuild it yourself with:

```bash
cd software
npm run dist:mac
```

## `npm run dist:win` fails with a file lock

Close the running app, then delete `software/release` and build again. On a busy folder (editor indexing, antivirus) the first unpack can fail. A second run usually works.

## A home station does not show up

Station pairing is not finished yet. The dashboard can still show public weather at your pin. Hardware and firmware files are coming back into `3D Printed Parts/` and `Boards/`.

## Something else

1. Check [open issues](https://github.com/NicholasTracy/Open-Weather/issues).
2. Open a **Bug report** with the app version, your operating system, and the steps you took.
