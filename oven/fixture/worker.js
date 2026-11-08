import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY, t TEXT)");
  }
  async fetch(request) {
    const url = new URL(request.url);
    const op = url.searchParams.get("op");
    if (op === "ws-hib" || op === "ws-plain") {
      const [client, server] = Object.values(new WebSocketPair());
      if (op === "ws-hib") this.ctx.acceptWebSocket(server);
      else {
        server.accept();
        server.addEventListener("message", (e) => server.send(`plain:${e.data}`));
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (op === "insert") {
      this.ctx.storage.sql.exec("INSERT INTO msgs (t) VALUES (?)", url.searchParams.get("t"));
      return Response.json({ ok: true });
    }
    if (op === "rows") {
      return Response.json(this.ctx.storage.sql.exec("SELECT * FROM msgs ORDER BY id").toArray());
    }
    if (op === "alarm") {
      const fail = url.searchParams.get("fail") === "1";
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)");
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO cfg VALUES ('fail', ?)", fail ? "1" : "0");
      await this.ctx.storage.setAlarm(Date.now() + Number(url.searchParams.get("ms") ?? 100));
      return Response.json({ ok: true });
    }
    if (op === "id") return Response.json({ id: this.ctx.id.toString(), name: this.ctx.id.name ?? null });
    return new Response("unknown op", { status: 400 });
  }
  async alarm() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)");
    const row = this.ctx.storage.sql.exec("SELECT v FROM cfg WHERE k = 'fail'").toArray()[0];
    this.ctx.storage.sql.exec("INSERT INTO msgs (t) VALUES ('alarm')");
    if (row?.v === "1") throw new Error("alarm failed on purpose");
  }
  webSocketMessage(ws, message) {
    ws.send(`hib:${message}:${this.ctx.storage.sql.exec("SELECT count(*) AS n FROM msgs").one().n}`);
  }
  webSocketClose(ws, code, reason) {}
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, kind, key] = url.pathname.split("/");
    if (kind === "env") return Response.json(env);
    if (kind === "log") { console.log("fixture-log-line", url.searchParams.get("m")); return new Response("logged"); }
    if (kind === "throw") throw new Error("fixture-uncaught-" + url.searchParams.get("m"));
    if (kind === "fetch") {
      const r = await fetch(url.searchParams.get("u"));
      return Response.json({ status: r.status });
    }
    let stub;
    if (kind === "name") stub = env.ROOM.get(env.ROOM.idFromName(key));
    else if (kind === "byname") stub = env.ROOM.getByName(key);
    else if (kind === "unique") stub = env.ROOM.get(env.ROOM.newUniqueId());
    else if (kind === "id") stub = env.ROOM.get(env.ROOM.idFromString(key));
    else return new Response("not found", { status: 404 });
    return stub.fetch(request);
  }
};
