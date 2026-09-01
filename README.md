# Stolnk — worker and web sender

See the [top-level README](../README.md) for what this is and how to run it.

```
src/worker/          Hono API, Durable Object, D1 and R2 access
  limits.ts          Every tunable number, including the three cost constraints
  lib/site.ts        The address model: <name>.<host>/<path>, and nothing else knows it
  do/DeviceHub.ts    Signalling — must stay on the hibernation API
  routes/            devices · inboxes · resolve · transfers · delivery
src/shared/          The envelope, shared by the browser and the test harness
src/react-app/       Send page, landing page, how-it-works
migrations/          D1 schema
scripts/             e2e suite, vector generation, headless Mac stand-in
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Local stack: worker, D1, R2, Durable Object |
| `npm run build` | Type-check and build client and worker |
| `npm run e2e` | End-to-end checks against a running dev server |
| `npm run vectors` | Regenerate `testdata/vectors.json` |

Regenerating vectors changes what the Swift tests assert against, so run
`swift test` in `stolnk_mac` afterwards.

`PUBLIC_SITE_ORIGIN` is the apex origin and the only place the address shape is
configured: `wrangler.json` holds the production value, `.dev.vars` the local one
(see `.dev.vars.example`). An inbox lives one label below it, so locally that is
`http://ryan.localhost:5173/inbox` — `*.localhost` resolves to loopback with no
hosts file entry. Every link carries a path; the bare subdomain is not an
address. The dev port is pinned with `strictPort`, because a link that says
5173 while Vite drifted to 5174 is a dead link. After changing `wrangler.json`,
run `npm run cf-typegen`.
