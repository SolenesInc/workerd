# The oven fork of workerd

This branch, `oven`, is `workerd` as oven runs it for Worker services. It starts from upstream's
`v1.20261106.1` (commit `9b90145c9b38e5ac907bd66b9bbb9591aeeb6700`) and does not follow upstream.
Worker code sees only the Cloudflare API: local development stays `wrangler dev`, and no app
depends on this fork.

## What it adds

- `--oven-objects-dir <dir>`: a wrangler config's Durable Objects are stored under `<dir>`, one
  directory per class, named by the class's storage key (its name, unless it was renamed). Each
  directory holds `<64-hex id>.sqlite` (with `-wal` and `-shm`) and `metadata.sqlite`.
- `--oven-env`: each environment variable of the process becomes a text binding, over `vars`. A
  variable named like a Durable Object binding is an error.
- A registry in each class's `metadata.sqlite`:

  ```sql
  CREATE TABLE _oven_OBJECT (
    actor_id TEXT PRIMARY KEY,  -- the 64-hex id
    name TEXT,                  -- from idFromName()/getByName(); NULL for an unnamed object
    created_at INTEGER,         -- Unix ms, when first recorded
    last_alarm_at INTEGER,      -- Unix ms
    last_alarm_ok INTEGER,      -- 0 or 1
    last_alarm_retries INTEGER);-- retries before that run
  CREATE TABLE _oven_NAMESPACE (class_name TEXT PRIMARY KEY);  -- the class, one row
  ```

  An object gets its row when its storage is opened; one created before the registry existed
  gets it the next time it runs.
- `--oven-admin-addr <addr>`: `POST /objects/<class>/<id>/sql` with `{"query": "..."}` runs the
  statement inside the live object, through its `ctx.storage.sql`, and answers `{"rows": [...]}`
  once the write is durable. An object with no file is a 404 (a write never creates one), a
  refused statement a 400, and every error body is `{"error": "..."}`. It has no
  authentication: only oven's data pod may reach it.
- SIGTERM closes every WebSocket with 1012 (service restart) and exits once the clients answer.
  Stock `workerd` waits for clients to close on their own.

## Build, test, release

```sh
bazel build --config=release_linux //src/workerd/server:workerd
node oven/test.mjs bazel-bin/src/workerd/server/workerd
```

`oven/test.mjs` is the acceptance test: it serves `oven/fixture` the way oven does and checks
each promise above, plus env, logs and outbound fetch.

A tag `v<npm version>-oven.<n>` runs `.github/workflows/oven-release.yml`, which builds, tests
and publishes `ghcr.io/solenesinc/oven-workerd:<tag>` from `oven/Dockerfile`. Pin the image by
digest.
