#!/usr/bin/env node
// Herdr Web: a phone-sized window onto herdr-core. Lists spaces, tabs and
// agents live, shows an agent's screen, and lets you answer it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { HcClient } from "./lib/hc.js";
import { generateVapidKeys, sendPush } from "./lib/push.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const HC_BIN = process.env.HC_BIN || findHc();
const HOME_DIR = process.env.HERDR_WEB_HOME || path.join(os.homedir(), ".config", "herdr-web");
const ALLOWED_LOGINS = (process.env.HERDR_WEB_ALLOWED_LOGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

function findHc() {
  for (const p of [path.join(os.homedir(), ".local/bin/hc"), "/opt/homebrew/bin/hc", "/usr/local/bin/hc"]) {
    if (fs.existsSync(p)) return p;
  }
  return "hc";
}

// ---------- persistent config ----------
fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
const CONFIG_FILE = path.join(HOME_DIR, "config.json");
const SUBS_FILE = path.join(HOME_DIR, "push-subscriptions.json");
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};
const writeJson = (f, v) => {
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
};
const config = readJson(CONFIG_FILE, {});
if (!config.token) config.token = crypto.randomBytes(15).toString("base64url");
if (!config.vapid) config.vapid = generateVapidKeys();
if (!config.cookieSecret) config.cookieSecret = crypto.randomBytes(32).toString("base64url");
writeJson(CONFIG_FILE, config);
let subscriptions = readJson(SUBS_FILE, []);

// ---------- herdr-core ----------
// A few connections: sends wait for quiet (~3 s) and reads of full-screen
// apps scroll them, so one slow call shouldn't hold up the rest.
const pool = Array.from({ length: 3 }, (_, i) => new HcClient({ bin: HC_BIN, name: `rpc${i}` }));
const rpc = (method, params, opts) => {
  const c = pool.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
  return c.request(method, params, opts);
};
const events = new HcClient({ bin: HC_BIN, name: "events" });

let state = { machine: os.hostname(), spaces: [], terminals: {}, updated: 0, connected: false };
let layoutDoc = null;
let firstSnapshot = true;
const lastStatus = new Map(); // address -> status word, for notifications

function short(p) {
  if (!p) return "";
  const home = os.homedir();
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

function terminalsInTree(node, out = []) {
  if (!node) return out;
  if (node.content?.terminal) out.push(node.content.terminal);
  for (const c of node.children || []) terminalsInTree(c, out);
  return out;
}

function programOf(t) {
  const argv = t.foreground?.argv || t.argv || [];
  const bin = path.basename(argv[0] || "");
  return t.status?.app || bin || "shell";
}

function view(t) {
  const st = t.status || {};
  return {
    address: t.address,
    name: t.name,
    state: t.state, // live | finished | ...
    status: t.reported ? st.state || "idle" : null,
    kind: st.kind || null,
    msg: st.msg || "",
    progress: st.progress ?? null,
    app: st.app || null,
    program: programOf(t),
    title: (t.title || "").trim(),
    cwd: short(t.foreground?.cwd || t.cwd),
    parent: t.parent || null,
    where: t.labels?.where || "",
    space: t.labels?.["herdr.space"] || null,
    tab: t.labels?.["herdr.tab"] || null,
    turn: t.turn ?? 0,
    statusMs: t.status_ms || t.created_ms || 0,
    createdMs: t.created_ms || 0,
    cols: t.cols,
    rows: t.rows,
  };
}

function buildState(list, doc) {
  const terminals = {};
  for (const t of list) terminals[t.address] = view(t);
  const spaces = [];
  const placed = new Set();
  for (const sp of doc?.spaces || []) {
    const tabs = (sp.tabs || []).map((tb, i) => {
      const addrs = terminalsInTree(tb.root).filter((a) => terminals[a]);
      addrs.forEach((a) => placed.add(a));
      const first = terminals[addrs[0]];
      const whereTab = first?.where.split(" / ")[1];
      return { id: tb.id, name: tb.name || whereTab || String(i + 1), named: Boolean(tb.name), settled: Boolean(tb.settled), terminals: addrs };
    });
    // Terminals labelled for this space whose pane we didn't find (just started).
    for (const t of Object.values(terminals)) {
      if (t.space === sp.id && !placed.has(t.address)) {
        let tab = tabs.find((x) => x.id === t.tab);
        if (!tab) tabs.push((tab = { id: t.tab, name: t.where.split(" / ")[1] || String(tabs.length + 1), named: false, terminals: [] }));
        tab.terminals.push(t.address);
        placed.add(t.address);
      }
    }
    const firstT = tabs.flatMap((x) => x.terminals).map((a) => terminals[a])[0];
    const name = sp.name || firstT?.where.split(" / ")[0] || path.basename(firstT?.cwd || sp.folder || "") || "~";
    spaces.push({ id: sp.id, name, named: Boolean(sp.name), folder: short(sp.folder), cwd: firstT?.cwd || short(sp.folder), tabs });
  }
  // Sub-agents belong to their parent; anything else left over goes to "Other".
  const other = [];
  for (const t of Object.values(terminals)) {
    if (placed.has(t.address) || t.parent) continue;
    if (t.state !== "live") continue;
    other.push(t.address);
  }
  if (other.length) spaces.push({ id: "_other", name: "Other terminals", named: true, folder: "", cwd: "", tabs: [{ id: "_other", name: "", terminals: other }] });
  return { machine: events.hello?.core?.name || os.hostname(), spaces, terminals, updated: Date.now(), connected: true };
}

let refreshTimer = null;
let refreshing = false;
let refreshAgain = false;
let docDirty = true;
function scheduleRefresh(delay = 120) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    if (refreshing) return void (refreshAgain = true);
    refreshing = true;
    try {
      await refresh();
    } catch (err) {
      console.error("refresh failed:", err.message);
    } finally {
      refreshing = false;
      if (refreshAgain) {
        refreshAgain = false;
        scheduleRefresh();
      }
    }
  }, delay);
}

async function refresh() {
  const [list, doc] = await Promise.all([
    rpc("terminal.list", {}),
    docDirty || !layoutDoc ? rpc("doc.get", { name: "herdr-app" }).then((d) => d.value) : Promise.resolve(layoutDoc),
  ]);
  docDirty = false;
  layoutDoc = doc;
  state = buildState(list.terminals || [], doc);
  noticeChanges();
  broadcast("state", state);
}

events.on("open", async () => {
  try {
    await events.request("events.subscribe", {});
    docDirty = true;
    scheduleRefresh(0);
  } catch (err) {
    console.error("events.subscribe failed:", err.message);
  }
});
events.on("notification", (method, params) => {
  if (method === "heartbeat") return;
  if (method === "event" && params?.kind === "doc") docDirty = true;
  if (method === "missed") docDirty = true;
  // Event payloads aren't worth mirroring field by field: re-list (debounced).
  if (method === "event" && !params?.kind) docDirty = true;
  scheduleRefresh();
});
events.on("close", () => {
  state = { ...state, connected: false };
  broadcast("state", state);
});
events.start().catch((err) => console.error("herdr-core not reachable yet:", err.message));
// Belt and braces: a slow periodic refresh, in case an event is ever missed.
setInterval(() => {
  docDirty = true;
  scheduleRefresh();
}, 30000);

// ---------- screens ----------
// Reading an idle full-screen app's history means core scrolls it (~2.5 s).
// Keep the last read per agent until something about it changes.
const screenCache = new Map(); // address -> { key, lines, result }
const factsKey = (t) => (t ? `${t.status}|${t.turn}|${t.statusMs}|${t.title}|${t.msg}` : null);
const inflight = new Map();

async function readScreen(addr, lines = 400) {
  const t = state.terminals[addr];
  const key = factsKey(t);
  // Only agents between turns hold still; a working agent or a plain shell changes without telling.
  const cacheable = t?.status && t.status !== "working";
  const hit = screenCache.get(addr);
  if (cacheable && hit && hit.key === key && hit.lines >= lines) return hit.result;
  const flightKey = `${addr}|${lines}`;
  if (inflight.has(flightKey)) return inflight.get(flightKey);
  const p = rpc("terminal.read", { terminal: addr, lines }, { timeoutMs: 20000 })
    .then((r) => {
      const result = { ...r, at: Date.now() };
      if (cacheable && factsKey(state.terminals[addr]) === key) screenCache.set(addr, { key, lines, result });
      return result;
    })
    .finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, p);
  return p;
}

// When an agent finishes while you're away ("done"), read it ahead of time,
// one at a time, so opening it on the phone is instant. Done means nobody
// was looking at it on the Mac, so scrolling it to read bothers no one.
const prefetchQueue = new Set();
let prefetching = false;
function prefetch(addr) {
  prefetchQueue.add(addr);
  if (prefetching) return;
  prefetching = true;
  setTimeout(async () => {
    while (prefetchQueue.size) {
      const a = prefetchQueue.values().next().value;
      prefetchQueue.delete(a);
      const t = state.terminals[a];
      if (t?.status !== "done" || screenCache.get(a)?.key === factsKey(t)) continue;
      await readScreen(a, 400).catch(() => {});
    }
    prefetching = false;
  }, 1000);
}

// ---------- notifications ----------
const pendingNotes = new Map();
function noticeChanges() {
  for (const t of Object.values(state.terminals)) {
    if (!t.status) continue;
    const prev = lastStatus.get(t.address);
    lastStatus.set(t.address, t.status);
    if (t.status === "done" && screenCache.get(t.address)?.key !== factsKey(t)) prefetch(t.address);
    if (firstSnapshot || prev === t.status) continue;
    const wanted = t.status === "blocked" || t.status === "error" || (t.status === "done" && !t.parent);
    if (!wanted || !subscriptions.length) continue;
    // Wait a moment: a status that flips straight back isn't news.
    clearTimeout(pendingNotes.get(t.address));
    pendingNotes.set(
      t.address,
      setTimeout(() => {
        pendingNotes.delete(t.address);
        const now = state.terminals[t.address];
        if (now?.status === t.status) notify(now);
      }, 3000),
    );
  }
  firstSnapshot = false;
}

function spaceNameOf(t) {
  for (const s of state.spaces) if (s.tabs.some((tb) => tb.terminals.includes(t.address))) return s.name;
  const p = t.parent && state.terminals[t.parent];
  return p ? spaceNameOf(p) : t.cwd;
}

async function notify(t) {
  const space = spaceNameOf(t);
  const blocked = t.status === "blocked" || t.status === "error";
  const what = blocked ? (t.kind === "permission" ? "wants permission" : t.kind === "question" ? "has a question" : "needs you") : "finished";
  const payload = {
    title: `${space} ${blocked ? "· needs you" : "· done"}`,
    body: [t.title || t.program, t.msg || what].filter(Boolean).join(" — "),
    tag: `herdr-${t.address}`,
    url: `/#/t/${encodeURIComponent(t.address)}`,
    address: t.address,
  };
  await pushAll(payload);
}

async function pushAll(payload) {
  // Push services want a contact for the sender: this server's own tailnet URL.
  const subject = process.env.HERDR_WEB_PUSH_SUBJECT || config.pushSubject || "mailto:herdr-web@example.com";
  const dead = new Set();
  await Promise.all(
    subscriptions.map(async (s) => {
      try {
        const r = await sendPush(s, payload, { keys: config.vapid, subject });
        if (r.gone) dead.add(s.endpoint);
        else if (!r.ok) console.error(`push ${r.status}: ${r.text}`);
      } catch (err) {
        console.error("push failed:", err.message);
      }
    }),
  );
  if (dead.size) {
    subscriptions = subscriptions.filter((s) => !dead.has(s.endpoint));
    writeJson(SUBS_FILE, subscriptions);
  }
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => {
  for (const res of clients) res.write(`: ping\n\n`);
}, 20000);

// ---------- auth ----------
function sign(v) {
  return crypto.createHmac("sha256", config.cookieSecret).update(v).digest("base64url");
}
function sessionCookie() {
  const v = `v1.${Date.now()}`;
  return `${v}.${sign(v)}`;
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function validCookie(c) {
  if (!c) return false;
  const i = c.lastIndexOf(".");
  if (i < 0) return false;
  const v = c.slice(0, i);
  const sig = Buffer.from(c.slice(i + 1));
  const want = Buffer.from(sign(v));
  return sig.length === want.length && crypto.timingSafeEqual(sig, want);
}
function tailscaleLogin(req) {
  // tailscale serve sets these for tailnet users and strips any a client sends.
  // A forged one could only come from this machine, so also require the
  // tailnet's own host name (DNS rebinding would carry another Host).
  const login = req.headers["tailscale-user-login"];
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  if (!login || !/\.ts\.net(:\d+)?$/i.test(host)) return null;
  if (ALLOWED_LOGINS.length && !ALLOWED_LOGINS.includes(login)) return null;
  return login;
}
function authed(req) {
  return Boolean(tailscaleLogin(req)) || validCookie(cookies(req).hw_session);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- HTTP ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function send(res, code, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json" : "text/plain",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

async function readBody(req, limit = 1 << 20) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

function serveStatic(req, res, urlPath) {
  let p = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC)) return send(res, 404, "not found");
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      if (!path.extname(p)) return serveStatic(req, res, "/");
      return send(res, 404, "not found");
    }
    const ext = path.extname(file);
    const long = ext === ".png";
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": long ? "public, max-age=86400" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...(ext === ".html" ? { "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" } : {}),
    });
    res.end(data);
  });
}

const term = (s) => decodeURIComponent(s);

const routes = [
  ["GET", /^\/api\/me$/, async (req) => ({ login: tailscaleLogin(req), machine: state.machine })],
  ["GET", /^\/api\/state$/, async () => state],
  [
    "GET",
    /^\/api\/terminal\/([^/]+)\/screen$/,
    async (req, m, url) => {
      const addr = term(m[1]);
      if (url.searchParams.get("fast") === "1") return { ...(await rpc("terminal.read", { terminal: addr, lines: 0 })), at: Date.now() };
      const lines = Math.min(Number(url.searchParams.get("lines") || 400), 3000);
      return readScreen(addr, lines);
    },
  ],
  [
    "POST",
    /^\/api\/terminal\/([^/]+)\/send$/,
    async (req, m, url, body) => {
      const text = String(body.text ?? "");
      if (!text.trim()) throw Object.assign(new Error("empty message"), { status: 400 });
      return rpc("terminal.send", { terminal: term(m[1]), text, force: Boolean(body.force) }, { timeoutMs: 60000 });
    },
  ],
  [
    "POST",
    /^\/api\/terminal\/([^/]+)\/keys$/,
    async (req, m, url, body) => {
      const keys = (Array.isArray(body.keys) ? body.keys : []).map(String).filter((k) => /^[\w+\-.,/;:'"`~!@#$%^&*()=[\]{}\\|<>? ]{1,24}$/.test(k));
      if (!keys.length) throw Object.assign(new Error("no keys"), { status: 400 });
      return rpc("terminal.keys", { terminal: term(m[1]), keys }, { timeoutMs: 30000 });
    },
  ],
  ["POST", /^\/api\/terminal\/([^/]+)\/interrupt$/, async (req, m) => rpc("terminal.interrupt", { terminal: term(m[1]), timeout: 5 }, { timeoutMs: 15000 })],
  [
    "POST",
    /^\/api\/spaces\/([^/]+)\/new$/,
    async (req, m, url, body) => {
      const sp = state.spaces.find((s) => s.id === term(m[1]));
      if (!sp || sp.id === "_other") throw Object.assign(new Error("no such space"), { status: 404 });
      const cwdShort = sp.cwd || sp.folder || "~";
      const cwd = cwdShort.startsWith("~") ? os.homedir() + cwdShort.slice(1) : cwdShort;
      const tabId = "tb" + crypto.randomBytes(16).toString("hex");
      const shell = process.env.SHELL || "/bin/zsh";
      const program = body.program === "shell" ? null : "claude";
      const argv = program ? [shell, "-l", "-i", "-c", program] : [shell, "-l"];
      const r = await rpc(
        "terminal.run",
        {
          argv,
          cwd,
          keep: true,
          no_parent: true,
          labels: { "herdr.space": sp.id, "herdr.tab": tabId },
          env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
        },
        { timeoutMs: 30000 },
      );
      scheduleRefresh(300);
      return { address: r.address };
    },
  ],
  ["GET", /^\/api\/push\/key$/, async () => ({ publicKey: config.vapid.publicKey })],
  [
    "POST",
    /^\/api\/push\/subscribe$/,
    async (req, m, url, body) => {
      const s = body.subscription;
      if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) throw Object.assign(new Error("bad subscription"), { status: 400 });
      if (!/^https:\/\//.test(s.endpoint)) throw Object.assign(new Error("bad endpoint"), { status: 400 });
      const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
      if (/\.ts\.net(:\d+)?$/i.test(host) && config.pushSubject !== `https://${host}`) {
        config.pushSubject = `https://${host}`;
        writeJson(CONFIG_FILE, config);
      }
      subscriptions = subscriptions.filter((x) => x.endpoint !== s.endpoint);
      subscriptions.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, added: Date.now(), ua: String(req.headers["user-agent"] || "").slice(0, 200) });
      writeJson(SUBS_FILE, subscriptions);
      return { ok: true, count: subscriptions.length };
    },
  ],
  [
    "POST",
    /^\/api\/push\/unsubscribe$/,
    async (req, m, url, body) => {
      subscriptions = subscriptions.filter((x) => x.endpoint !== body.endpoint);
      writeJson(SUBS_FILE, subscriptions);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/api\/push\/test$/,
    async () => {
      await pushAll({ title: "Herdr", body: "Notifications work. You'll hear when an agent needs you or finishes.", tag: "herdr-test", url: "/" });
      return { ok: true, count: subscriptions.length };
    },
  ],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  res.setHeader("Referrer-Policy", "no-referrer");

  if (p === "/api/login" && req.method === "POST") {
    if (req.headers["x-herdr"] !== "1") return send(res, 403, { error: "forbidden" });
    try {
      const body = await readBody(req, 4096);
      if (!safeEqual(body.token || "", config.token)) return send(res, 401, { error: "wrong token" });
      return send(res, 200, { ok: true }, { "Set-Cookie": `hw_session=${sessionCookie()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
    } catch {
      return send(res, 400, { error: "bad request" });
    }
  }

  if (p.startsWith("/api/")) {
    if (!authed(req)) return send(res, 401, { error: "login needed" });
    // Every API call carries a custom header: a cross-site page can't add it
    // without a CORS preflight, which this server never approves.
    if (req.headers["x-herdr"] !== "1" && p !== "/api/events") return send(res, 403, { error: "forbidden" });

    if (p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    for (const [method, re, fn] of routes) {
      const m = p.match(re);
      if (!m || req.method !== method) continue;
      try {
        const body = method === "POST" ? await readBody(req) : {};
        const out = await fn(req, m, url, body);
        return send(res, 200, out ?? { ok: true });
      } catch (err) {
        const status = err.status || (err.kind === "not_found" || err.kind === "no_such_terminal" ? 404 : 502);
        return send(res, status, { error: err.message, kind: err.kind || null });
      }
    }
    return send(res, 404, { error: "no such api" });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
  serveStatic(req, res, p);
});

server.listen(PORT, HOST, () => {
  console.log(`Herdr Web on http://${HOST}:${PORT}  (hc: ${HC_BIN})`);
  console.log(`Login token (only needed outside Tailscale): ${config.token}`);
  console.log(`Config: ${HOME_DIR}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    events.stop();
    pool.forEach((c) => c.stop());
    server.close();
    process.exit(0);
  });
}
