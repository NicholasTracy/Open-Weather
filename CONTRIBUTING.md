# Contributing

Thanks for helping Open Weather stay free, local, and useful.

## Before you start

1. Read the [README](README.md) so the local-first goals stay clear.
2. Search [issues](https://github.com/NicholasTracy/Open-Weather/issues) and the [wiki](https://github.com/NicholasTracy/Open-Weather/wiki).
3. Open an issue with a template if you are reporting a bug or proposing a larger change.

## How to send a change

1. Fork the repo and branch from `master`.
2. Keep the change focused. Software, hardware, and docs can be separate pull requests.
3. In `software/`:

   ```bash
   npm install
   npm run typecheck
   npm run dev
   ```

4. Open a pull request. The template asks for a short “why” and how you checked the work.

CI typechecks on every pull request, then packages the Command Center and installs it on Ubuntu, Windows, and macOS runners. Each install is launched with a `--smoke-test` flag so the window must load. macOS is ad-hoc signed on the runner (no Apple Developer certificate).

If CI goes red, a triage job reads the failed logs and posts a likely cause plus first steps. Pull requests get one triage comment, updated on later failures. Pushes to `master` or `development` open a sticky **CI is failing on** issue for that branch, which closes when CI is green again.

## Project guidelines

- Keep weather data on the user’s machine. Do not add cloud accounts, telemetry, or required subscriptions.
- Public internet sources (NOAA, NWS, Open-Meteo) are optional fill-in, not a lock-in.
- Prefer plain language in user-facing text.
- Do not commit `node_modules/`, `software/release/`, `.env` files, or local Cursor config.
- Hardware and print files belong in `3D Printed Parts/` and `Boards/` when they are ready.

## Dependabot

Dependabot opens monthly update PRs. Automation then:

1. Waits until CI is green
2. Runs an AI / safety review (manifest files only; majors of Electron, TypeScript, Vite, and Actions stay with a human)
3. Approves and squash-merges if that review says the update is safe
4. Runs typecheck again on `master`
5. Reverts the merge and opens a **needs-human-review** issue if that second check fails

To review one open Dependabot PR by hand-trigger: **Actions → Dependabot automation → Run workflow**.

## Releases

Maintainers cut a version by tagging `master`:

```bash
git tag v0.1.1
git push origin v0.1.1
```

GitHub Actions builds the Windows installer and publishes a [release](https://github.com/NicholasTracy/Open-Weather/releases). You can also run the **Release** workflow by hand.

## Where to ask

- [Troubleshooting](TROUBLESHOOTING.md)
- [Wiki](https://github.com/NicholasTracy/Open-Weather/wiki)
- [Design rules](https://github.com/NicholasTracy/Open-Weather/wiki/Design-Rules---Standards-for-Contribution)
