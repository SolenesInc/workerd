// The oven fork's acceptance test, run against a built binary:
//
//   node oven/test.mjs <path to workerd>
//
// It serves oven/fixture the way oven runs a Worker service and checks what oven relies on: the
// object registry, the admin socket, SIGTERM, the environment, logs and outbound fetch. Each check
// prints one line; the exit code is the number that failed.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const bin = process.argv[2];
if (!bin) throw new Error("usage: node oven/test.mjs <workerd>");
const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), "oven-test-"));
const app = join(root, "app");
const objects = join(root, "objects");
cpSync(new URL("fixture", import.meta.url).pathname, app, { recursive: true });

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
}

// Starts the fork on ports it picks, reported on --control-fd.
async function start(env = {}) {
  const child = spawn(bin, [
    "serve", join(app, "wrangler.json"),
    "--oven-objects-dir", objects, "--oven-env", "--oven-admin-addr", "127.0.0.1:0",
    "--socket-addr", "http=127.0.0.1:0", "--control-fd", "3",
  ], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const ports = {};
  await new Promise((resolve, reject) => {
    let buffer = "";
    child.stdio[3].on("data", (d) => {
      buffer += d;
      for (const line of buffer.split("\n").slice(0, -1)) {
        const event = JSON.parse(line);
        if (event.event === "listen") ports[event.socket] = event.port;
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      if (ports.http && ports["oven-admin"]) resolve();
    });
    child.on("exit", (code) => reject(new Error(`workerd exited with ${code}:\n${output}`)));
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, ports, exited, output: () => output };
}

const registry = (cls = "Room") => {
  const db = new DatabaseSync(join(objects, cls, "metadata.sqlite"), { readOnly: true });
  try {
    return {
      objects: db.prepare("SELECT * FROM _oven_OBJECT ORDER BY created_at").all(),
      namespace: db.prepare("SELECT class_name FROM _oven_NAMESPACE").all(),
    };
  } finally {
    db.close();
  }
};
const until = async (what, f, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await f();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

const marker = `oven-test-${process.pid}`;
const server = await start({ OVEN_TEST_SECRET: marker, OVERRIDDEN: "from-env" });
const base = `http://127.0.0.1:${server.ports.http}`;
const admin = `http://127.0.0.1:${server.ports["oven-admin"]}`;
const get = async (path) => (await fetch(base + path)).json();
const sql = async (cls, id, query) => {
  const r = await fetch(`${admin}/objects/${cls}/${id}/sql`, { method: "POST", body: JSON.stringify({ query }) });
  return { status: r.status, body: await r.json() };
};

// --- Environment, logs, outbound fetch
const env = await get("/env");
check("a pod env var reaches env", env.OVEN_TEST_SECRET === marker);
check("every pod env var reaches env", Object.entries(process.env).every(([k, v]) => env[k] === v || k === "OVERRIDDEN"),
  Object.keys(process.env).filter((k) => env[k] !== process.env[k] && k !== "OVERRIDDEN").join(","));
check("an env var overrides vars", env.OVERRIDDEN === "from-env" && env.FROM_VARS === "vars-value");
await fetch(`${base}/log?m=${marker}`);
const thrown = await fetch(`${base}/throw?m=${marker}`);
await until("logs", () => server.output().includes(`fixture-uncaught-${marker}`) && server.output().includes(`fixture-log-line ${marker}`));
check("console.log and an uncaught exception reach the output", thrown.status === 500);
const outbound = await get(`/fetch?u=${encodeURIComponent("https://example.com/")}`);
check("fetch to the internet works", outbound.status === 200, JSON.stringify(outbound));

// --- Registry
const named = await get("/name/general?op=id");
const byName = await get("/byname/lobby?op=id");
const unique = await get("/unique/x?op=id");
await get(`/name/general?op=insert&t=hello`);
const rows = registry();
const row = (id) => rows.objects.find((o) => o.actor_id === id);
check("objects live in <dir>/<class>/<id>.sqlite", existsSync(join(objects, "Room", `${named.id}.sqlite`)),
  readdirSync(objects).join(","));
check("_oven_NAMESPACE names the class", rows.namespace.length === 1 && rows.namespace[0].class_name === "Room");
check("idFromName records the name", row(named.id)?.name === "general", JSON.stringify(row(named.id)));
check("getByName records the name", row(byName.id)?.name === "lobby", JSON.stringify(row(byName.id)));
check("an unnamed object is listed by id", row(unique.id) !== undefined && row(unique.id).name === null);
check("created_at is Unix milliseconds", Math.abs(row(named.id).created_at - Date.now()) < 60000);
// Reaching a named object by its id keeps the name.
await get(`/id/${named.id}?op=id`);
check("reaching an object by id keeps its name", registry().objects.find((o) => o.actor_id === named.id).name === "general");

// --- Alarms
await get("/name/alarm-ok?op=alarm&ms=50");
const alarmOk = (await get("/name/alarm-ok?op=id")).id;
const ok = await until("the alarm", () => registry().objects.find((o) => o.actor_id === alarmOk && o.last_alarm_at));
check("a successful alarm is recorded", ok.last_alarm_ok === 1 && ok.last_alarm_retries === 0, JSON.stringify(ok));
await get("/name/alarm-fail?op=alarm&ms=50&fail=1");
const alarmFail = (await get("/name/alarm-fail?op=id")).id;
const bad = await until("the failing alarm", () => registry().objects.find((o) => o.actor_id === alarmFail && o.last_alarm_at));
check("a failed alarm is recorded", bad.last_alarm_ok === 0 && bad.last_alarm_retries === 0, JSON.stringify(bad));

// --- Admin socket
const open = async (path) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.ports.http}${path}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.closed = new Promise((resolve) => (ws.onclose = (e) => resolve({ code: e.code, reason: e.reason })));
  ws.ask = (m) => new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); ws.send(m); });
  return ws;
};
const hib = await open("/name/general?op=ws-hib");
const plain = await open("/name/general?op=ws-plain");
const before = await hib.ask("count");
const write = await sql("Room", named.id, "INSERT INTO msgs (t) VALUES ('from-admin')");
check("an admin write into a live object with sockets succeeds", write.status === 200 && Array.isArray(write.body.rows), JSON.stringify(write));
const after = await hib.ask("count");
check("the object sees the admin write", before === "hib:count:1" && after === "hib:count:2", `${before} -> ${after}`);
const read = await sql("Room", named.id, "SELECT t FROM msgs ORDER BY id");
check("an admin read returns rows", JSON.stringify(read.body.rows) === JSON.stringify([{ t: "hello" }, { t: "from-admin" }]), JSON.stringify(read));
const objectRows = await get("/name/general?op=rows");
check("the object's own reads see the admin write", objectRows.some((r) => r.t === "from-admin"));
check("the plain socket still works", (await plain.ask("ping")) === "plain:ping");
const badSql = await sql("Room", named.id, "SELEC nonsense");
check("a bad statement is a 400 with an error", badSql.status === 400 && typeof badSql.body.error === "string", JSON.stringify(badSql));
const internal = await sql("Room", named.id, "SELECT * FROM _cf_METADATA");
check("the SQL API's restrictions apply", internal.status === 400, JSON.stringify(internal));
check("the object survives a bad statement", (await hib.ask("count")) === "hib:count:2");
const missing = "a".repeat(64);
const create = await sql("Room", missing, "CREATE TABLE t (x)");
check("the socket refuses to create an object", create.status === 404 && !existsSync(join(objects, "Room", `${missing}.sqlite`)), JSON.stringify(create));
const unknown = await sql("Nope", named.id, "SELECT 1");
check("an unknown class is a 404 naming the classes", unknown.status === 404 && unknown.body.error.includes("Room"), JSON.stringify(unknown));

// --- SIGTERM with an open plain socket, an open hibernatable one, and a hibernated one
const evicted = await open("/name/sleeper?op=ws-hib");
await evicted.ask("count");
// An object with no requests for about 10 s is evicted, and its WebSockets hibernate.
await new Promise((r) => setTimeout(r, 12000));
await hib.ask("count");
const t0 = Date.now();
server.child.kill("SIGTERM");
const closes = await Promise.all([hib.closed, plain.closed, evicted.closed]);
const exit = await Promise.race([server.exited, new Promise((r) => setTimeout(() => r(null), 30000))]);
check("SIGTERM closes every socket with 1012", closes.every((c) => c.code === 1012), JSON.stringify(closes));
check("SIGTERM exits", exit !== null && exit.code === 0, `${JSON.stringify(exit)} after ${Date.now() - t0} ms`);
if (exit === null) server.child.kill("SIGKILL");

console.log(failed === 0 ? "all checks passed" : `${failed} checks failed`);
process.exit(failed);
