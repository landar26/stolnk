# Stolnk — worker and web sender

See the [top-level README](../README.md) for what this is and how to run it.

```
src/worker/          Hono API, Durable Object, D1 and R2 access
  limits.ts          Every tunable number, including the three cost constraints
  lib/site.ts        The address model: <name>.<host>/<path>, and nothing else knows it
  do/DeviceHub.ts    Signalling — must stay on the hibernation API
  routes/            devices · inboxes · resolve · transfers · delivery · releases
src/shared/          The envelope and the release manifest, shared with the client
src/react-app/       Send page, landing page, how-it-works, download
migrations/          D1 schema
scripts/             e2e suite, vector generation, headless Mac stand-in, publishing
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Local stack: worker, D1, R2, Durable Object |
| `npm run build` | Type-check and build client and worker |
| `npm run e2e` | End-to-end checks against a running dev server |
| `npm run vectors` | Regenerate `testdata/vectors.json` |
| `npm run release:mac -- <dmg>` | Publish a macOS build to R2 (see below) |

Regenerating vectors changes what the Swift tests assert against, so run
`swift test` in `stolnk_mac` afterwards.

`src/shared/site-origin.ts` is the apex origin and the only place the address
shape is configured — one constant, imported by both the Worker and the browser
bundle, so the two cannot disagree about what a link looks like. An inbox lives
one label below it, so locally that is
`http://ryan.localhost:5173/inbox` — `*.localhost` resolves to loopback with no
hosts file entry. Every link carries a path; the bare subdomain is not an
address. The dev port is pinned with `strictPort`, because a link that says
5173 while Vite drifted to 5174 is a dead link. After changing `wrangler.json`,
run `npm run cf-typegen`.

## Publishing the Mac app

The installer is served from R2 through the Worker, so `stolnk.com` is the whole
distribution channel (PRD 10.1) and a release needs no deploy.

```bash
cd ../stolnk_mac && make release
```

That builds universal, signs with the Developer ID certificate, notarises and
staples both the app and the dmg, verifies, and prints
`build/Stolnk-<version>-universal.dmg`. Then:

```bash
npm run release:mac -- ../stolnk_mac/build/Stolnk-1.0.0-universal.dmg
```

which uploads the dmg and writes `mac/latest.json`, in that order — the manifest
is what makes a version visible, so a crash between the two leaves the site on
the previous release rather than pointing at nothing. It refuses to overwrite a
published version, and cross-checks the filename against `stolnk_mac/VERSION`.

To bump a release, change `stolnk_mac/VERSION` and repeat. Nothing tells an
already-installed copy that a new version exists: there is no update mechanism
yet, and `/api/v1/release/mac` is the endpoint one would be built on.

For development there is nothing to build:

```bash
npm run release:mac -- --local --fake
```

seeds the local R2 with a few KB of random bytes and a matching manifest, which
is what makes `/download` and the download section of `npm run e2e` work without
an Apple account. Without it that section skips itself, as it does on a fresh
clone.
