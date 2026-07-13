# Developing the glassray CLI

Contributor reference: running from a clone, layout, the self-contained rule, and publishing.
The user-facing docs live at [glassray.ai/docs/cli](https://glassray.ai/docs/cli/reference).

This package is **self-contained by design** — zero runtime dependencies (Node built-ins +
native `fetch` only) and **no `@helix/*` / `workspace:` imports** — so it is liftable into its
own public repo with no changes. Its only couplings are runtime boundaries: HTTPS to the
Glassray API, and shelling out to `npx @glassray/coach` for `glassray start`.

It lives as a git submodule at `packages/cli` inside the Glassray monorepo, but it is a
**standalone npm package** with its own `package-lock.json` and CI — deliberately kept **out**
of the monorepo's pnpm workspace (nothing in the monorepo depends on it), so develop it with
plain `npm` from this directory.

## Commands

From `packages/cli` (install once from the committed lockfile, then use the package scripts):

```sh
npm ci                 # reproducible install from package-lock.json (or `npm install`)

npm run dev            # tsx src/bin.ts — run straight from TypeScript
npm run build          # tsup → dist/bin.js (+ .map), shebang-marked executable
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .

node dist/bin.js --help           # run the built binary locally
node dist/bin.js setup --endpoint http://localhost:3000   # point at a local Glassray
```

`tsup` (see `tsup.config.ts`) bundles the single entry `src/bin.ts` into one ESM file targeting
Node 20. There is nothing to inline (no external deps), so the config carries no `noExternal`.
The bundled skill asset (`assets/skill/SKILL.md`) is resolved at runtime relative to
`import.meta.url` — it is **not** bundled; it ships alongside `dist/` via the `files` allowlist.

## Layout

- `src/bin.ts` — the entry point: finds the command word + global flags, builds the shared
  `Context`, and dispatches. stdout = data, stderr = status; exit `0` ok · `1` handled failure ·
  `2` unreachable.
- `src/commands/` — one file per command. Each parses its own args (global flags merged in via
  `parseCommand`), is idempotent, and speaks `--json`. `setup.ts` is just the orchestrator that
  sequences the standalone steps. `local/index.ts` holds `start` + the Coach data verbs.
- `src/lib/` — the shared machinery: `context.ts` (arg parsing + `Context`), `config.ts` (the
  `~/.config/glassray` credential store + endpoint resolution), `http.ts` (typed fetch wrappers
  for the REST API + the raw WorkOS device flow), `device-auth.ts` (RFC 8628 grant), `ui.ts`
  (the zero-dep branding kit + npm update check), `detect.ts`, `mcp-config.ts`, `env-file.ts`,
  `loopback.ts` (Coach data-verb fetchers over `127.0.0.1`), `poll.ts`, `telemetry.ts`,
  `errors.ts`, and `types.ts` (see below).
- `assets/skill/SKILL.md` — the agent skill `glassray init` installs (shipped in the package).

## The REST contract (`src/lib/types.ts`)

The Glassray public REST contract is vendored **locally** as plain TypeScript interfaces rather
than imported from `@helix/shared`, so the package stays dependency-free and extractable. The
canonical source is `docs/onboarding-wizard.md §4` in the monorepo; **`types.ts` is kept in sync
by hand.** When the API contract changes, update `types.ts` to match — there is no build-time
check that catches drift, because that coupling is exactly what we're avoiding. The runtime call
paths themselves live in `src/lib/http.ts`.

## How `start` delegates to Coach

`glassray start` is the one lazy-heavy path. It prefers a locally-installed `@glassray/coach`
(resolved via `createRequire`) and otherwise falls back to `npx --yes @glassray/coach start`,
passing `--port` through. Coach (its own published package) owns the local server, dashboard,
and embedded database; this CLI never bundles it.

## Environment variables

Everything has a working default. See the [README](./README.md#global-flags--environment) for
the full table — the key ones for local dev:

| Variable | Default | What it does |
| --- | --- | --- |
| `GLASSRAY_APP_URL` | `https://app.glassray.ai` | Glassray deployment to target (or `--endpoint`). `GLASSRAY_ENDPOINT` is a deprecated fallback — being reserved for the SDK's trace-ingest endpoint. |
| `GLASSRAY_TOKEN` | — | Org key for CI/headless (or `--api-key`). Distinct from the SDK's `GLASSRAY_API_KEY`. |
| `GLASSRAY_WORKOS_API` | `https://api.workos.com` | WorkOS device-auth base (override while the endpoint host is being confirmed). |
| `GLASSRAY_PORT` | `5899` | Local Coach port (or `--port`). |
| `GLASSRAY_NO_TELEMETRY` | — | Opt out of run telemetry (or `--no-telemetry`). |
| `GLASSRAY_NO_UPDATE_CHECK` | — | Disable the npm update check (also honors `NO_UPDATE_NOTIFIER`, `CI`). |
| `XDG_CONFIG_HOME` | `~/.config` | Relocates the credential + update-check directory. |

## Publishing

Published to npm as [`@glassray/cli`](https://www.npmjs.com/package/@glassray/cli) with a
`glassray` bin. `dist/` is a build artifact (gitignored), so the `prepack` script runs `tsup`
before packing — the published tarball always carries a fresh build. The `files` allowlist ships
`dist/bin.js` (the sourcemap is excluded — nothing loads it at runtime), `assets/`, `README.md`,
`DEVELOPMENT.md`, and `LICENSE`; verify with:

```sh
npm pack --dry-run
```

The release wiring is in place (mirroring the SDK / Coach approach):

- **`npm run release`** (`release-it`, see `.release-it.json`) — run locally by a maintainer:
  gate (`typecheck` + `lint`), bump the version, `npm run build`, commit `chore: release
  v<version>`, tag `v<version>`, push `--follow-tags`, and open a GitHub release. It does **not**
  publish to npm. Dry-run first with `npm run release:dry`.
- **`.github/workflows/release.yml`** — the pushed `v*` tag triggers it: re-run the gates, then
  `npm publish --provenance` via **npm trusted publishing (OIDC)** — no npm token anywhere.
- **`.github/workflows/ci.yml`** — build + lint + typecheck on Node 20/22/24 for every push/PR,
  from the committed `package-lock.json`.

One-time setup before the first publish: **claim the `@glassray/cli` npm name**, and
configure the package for **npm trusted publishing** pointing at this repo + `release.yml`
(until then, `release.yml` is inert scaffolding).

Smoke-test a release in a clean directory: `npx @glassray/cli@latest --help`.
