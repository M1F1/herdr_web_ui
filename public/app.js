// Herdr Web — the phone client. Plain modules, no build step.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`herdr.${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`herdr.${k}`, JSON.stringify(v));
    } catch {}
  },
};

// ---------- API ----------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "X-Herdr": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("login needed");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), err ? 4000 : 2200);
}

// ---------- state ----------
let S = { spaces: [], terminals: {}, connected: false, machine: "" };
let mode = store.get("mode", "priority");
let current = null; // address shown in detail
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };

// The desktop's rules: error counts as blocked; a sub-agent is never "done" (its parent's done is the news).
const statusOf = (t) => {
  if (!t?.status) return null;
  const s = t.status === "error" ? "blocked" : t.status;
  return t.parent && s === "done" ? "idle" : s;
};

function since(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function placeOf(address) {
  for (const sp of S.spaces) {
    for (const tb of sp.tabs) if (tb.terminals.includes(address)) return { space: sp, tab: tb };
  }
  const t = S.terminals[address];
  if (t?.parent) return placeOf(t.parent);
  return { space: null, tab: null };
}

function childrenOf(address) {
  return Object.values(S.terminals)
    .filter((t) => t.parent === address && t.state === "live")
    .sort((a, b) => a.createdMs - b.createdMs);
}

function statusIcon(t) {
  if (!t) return "";
  if (t.state && t.state !== "live") return `<div class="st-finished" title="${esc(t.state)}"></div>`;
  const s = statusOf(t);
  if (!s) return `<div class="st-shell">&gt;_</div>`;
  if (s === "working") return `<div class="st-working"></div>`;
  if (s === "blocked") return `<div class="st-blocked">!</div>`;
  if (s === "done") return `<div class="st-done"></div>`;
  return `<div class="st-idle"></div>`;
}

function pill(t) {
  const s = statusOf(t);
  if (!s) return `<span class="pill shell">${esc(t?.state === "live" ? t?.program || "shell" : t?.state || "gone")}</span>`;
  const label = { blocked: t.kind === "permission" ? "Wants permission" : t.kind === "question" ? "Has a question" : "Needs you", done: "Done", working: "Working", idle: "Idle" }[s];
  return `<span class="pill ${s}">${s === "working" ? `<span class="st-working"></span>` : ""}${label}</span>`;
}

const chev = `<svg class="chev" viewBox="0 0 8 14"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function describe(t) {
  // Second line: what it's doing, in its own words.
  if (statusOf(t) === "blocked" && t.msg) return { text: t.msg, cls: "msg-blocked" };
  if (t.title && t.title !== t.program) return { text: t.title, cls: "" };
  if (t.msg) return { text: t.msg, cls: "" };
  return { text: t.program, cls: "" };
}

function agentRow(t, { full = true, sub = false } = {}) {
  const { space, tab } = placeOf(t.address);
  const s = statusOf(t);
  const d = describe(t);
  const multiTab = space && space.tabs.length > 1;
  let name, tabname = "";
  if (sub) name = t.name || t.title || t.program;
  else if (full) {
    name = space?.name || t.cwd || t.address;
    if (multiTab) tabname = tab?.name && /^\d+$/.test(tab.name) ? `tab ${tab.name}` : tab?.name || "";
  } else name = tab?.named ? tab.name : t.program === "shell" ? t.cwd : (t.app ? t.app.replace(/-/g, " ") : t.program);
  const l2 = sub ? (d.text !== name ? d.text : t.msg) : d.text;
  return `<a class="row ${s === "idle" ? "idle" : ""} ${sub ? "sub" : ""}" href="#/t/${encodeURIComponent(t.address)}">
    <div class="ico">${statusIcon(t)}</div>
    <div class="main">
      <div class="l1"><span class="name">${esc(name)}</span>${tabname ? `<span class="tabname">${esc(tabname)}</span>` : ""}</div>
      ${l2 ? `<div class="l2 ${d.cls}">${esc(l2)}</div>` : ""}
    </div>
    <div class="side">${s && s !== "idle" ? esc(since(t.statusMs)) : ""}${chev}</div>
  </a>`;
}

function withSubs(t, opts) {
  let html = agentRow(t, opts);
  for (const k of childrenOf(t.address)) if (k.status) html += agentRow(k, { sub: true });
  return html;
}

function renderSummary() {
  const counts = { blocked: 0, done: 0, working: 0, idle: 0 };
  for (const t of Object.values(S.terminals)) {
    const s = statusOf(t);
    if (s && t.state === "live" && !t.parent) counts[s]++;
  }
  const parts = [];
  if (counts.blocked) parts.push(`<span class="s-blocked"><b>${counts.blocked}</b> need${counts.blocked === 1 ? "s" : ""} you</span>`);
  if (counts.done) parts.push(`<span class="s-done"><b>${counts.done}</b> done</span>`);
  if (counts.working) parts.push(`<span class="s-working"><b>${counts.working}</b> working</span>`);
  if (counts.idle) parts.push(`<span><b>${counts.idle}</b> idle</span>`);
  $("#summary").innerHTML = parts.join("") || (S.connected ? "No agents running" : "");
  const conn = $("#conn");
  conn.className = "conn " + (S.connected ? "on" : "off");
  conn.textContent = S.connected ? S.machine || "herdr-core" : "Reconnecting…";
  // Home-screen badge: things waiting for you.
  const badge = counts.blocked + counts.done;
  try {
    if (navigator.setAppBadge) badge ? navigator.setAppBadge(badge) : navigator.clearAppBadge();
  } catch {}
  document.title = badge ? `(${badge}) Herdr` : "Herdr";
}

function renderHome() {
  renderSummary();
  document.querySelectorAll(".segmented button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const list = $("#home-list");
  let html = "";
  if (mode === "priority") {
    const top = Object.values(S.terminals).filter((t) => t.status && t.state === "live" && !t.parent);
    // A sub-agent that needs you surfaces on its own too.
    const blockedKids = Object.values(S.terminals).filter((t) => t.parent && t.state === "live" && statusOf(t) === "blocked");
    const groups = { 4: [], 3: [], 2: [], 1: [] };
    for (const t of top) groups[RANK[statusOf(t)] || 1].push(t);
    for (const k of blockedKids) groups[4].push(k);
    for (const r of [4, 3, 2, 1]) {
      const items = groups[r].sort((a, b) => (r === 1 ? (placeOf(a.address).space?.name || "").localeCompare(placeOf(b.address).space?.name || "") : b.statusMs - a.statusMs));
      if (!items.length) continue;
      html += `<div class="section-h ${r === 4 ? "blocked" : ""}">${SECTION[r]} <span class="count">${items.length}</span></div><div class="group">`;
      for (const t of items) html += t.parent ? agentRow(t, { full: true }) : withSubs(t, { full: true });
      html += `</div>`;
    }
    if (!html) html = emptyState();
  } else {
    for (const sp of S.spaces) {
      const agents = sp.tabs.flatMap((tb) => tb.terminals).map((a) => S.terminals[a]).filter(Boolean);
      const top = agents.map(statusOf).filter(Boolean).sort((a, b) => RANK[b] - RANK[a])[0];
      html += `<div class="space-h">
        <div class="ico">${top ? statusIcon({ status: top, state: "live" }) : ""}</div>
        <div class="space-meta"><span class="sp-name">${esc(sp.name)}</span>${sp.cwd ? `<span class="sp-cwd">${esc(sp.cwd)}</span>` : ""}</div>
        ${sp.id !== "_other" ? `<button class="add" data-action="new" data-space="${esc(sp.id)}" aria-label="New in ${esc(sp.name)}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>` : ""}
      </div><div class="group">`;
      for (const tb of sp.tabs) {
        for (const a of tb.terminals) {
          const t = S.terminals[a];
          if (t) html += withSubs(t, { full: false });
        }
      }
      html += `</div>`;
    }
    if (!S.spaces.length) html = emptyState();
  }
  list.innerHTML = html;
}

function emptyState() {
  if (!S.connected) return `<div class="empty"><div class="big">⌁</div>Can't reach herdr-core.<br>Is it running on the Mac?</div>`;
  return `<div class="empty"><div class="big">🐑</div>No agents right now.<br>Start one from the Spaces tab.</div>`;
}

// ---------- detail ----------
const KEYS = [
  { label: "esc", keys: ["esc"] },
  { label: "⇧⇥", keys: ["shift+tab"], title: "Shift+Tab (mode)" },
  { label: "↑", keys: ["up"] },
  { label: "↓", keys: ["down"] },
  { label: "⏎", keys: ["enter"] },
  { label: "1", keys: ["1"] },
  { label: "2", keys: ["2"] },
  { label: "3", keys: ["3"] },
  { label: "⇥", keys: ["tab"] },
  { label: "←", keys: ["left"] },
  { label: "→", keys: ["right"] },
  { label: "y", keys: ["y"] },
  { label: "n", keys: ["n"] },
  { label: "⌫", keys: ["backspace"] },
  { label: "^C", keys: ["ctrl+c"] },
  { label: "/clear", text: "/clear", cls: "wide" },
  { label: "/compact", text: "/compact", cls: "wide" },
];
$("#keys").innerHTML =
  `<button class="key stop" data-action="interrupt">Stop</button>` +
  KEYS.map((k, i) => `<button class="key ${k.cls || ""}" data-action="key" data-i="${i}" ${k.title ? `title="${esc(k.title)}"` : ""}>${esc(k.label)}</button>`).join("");

let screenText = "";
let screenReq = 0;
let pollTimer = null;
let lastSeen = null; // facts of the shown terminal at the last screen read
let follow = true;
let historyLines = 400;

function termSize() {
  return store.get("termSize", 11.5);
}
function applyTermSize() {
  document.documentElement.style.setProperty("--term-size", termSize() + "px");
  $("#screen").classList.toggle("nowrap", !store.get("wrap", true));
}
applyTermSize();

function renderDetailHeader() {
  const t = S.terminals[current];
  const { space, tab } = placeOf(current);
  $("#dt-name").textContent = space?.name || t?.cwd || current;
  const bits = [];
  if (t?.parent) bits.push(`sub-agent of ${t.parent}`);
  else if (tab && space?.tabs.length > 1) bits.push(/^\d+$/.test(tab.name) ? `tab ${tab.name}` : tab.name);
  if (t) bits.push(t.app || t.program);
  bits.push(current);
  $("#dt-sub").textContent = bits.join(" · ");
  const msg = t ? t.msg || t.title || "" : "This terminal is gone.";
  const prog = t?.progress != null && statusOf(t) === "working" ? `<span class="bar-progress"><i style="width:${Math.max(0, Math.min(100, t.progress))}%"></i></span>` : "";
  $("#dt-status").innerHTML = `${t ? pill(t) : `<span class="pill shell">gone</span>`}${prog}<span class="msg">${esc(msg)}</span>${t && statusOf(t) && statusOf(t) !== "idle" ? `<span>${esc(since(t.statusMs))}</span>` : ""}`;
  $("#input").placeholder = t ? `Message ${t.app ? t.app.replace(/-/g, " ") : t.program}` : "Message";
}

// Make a terminal's text readable on a phone: tidy blank runs, turn box
// rules into hairlines and colour the shapes Claude Code (and friends) use.
function formatScreen(text) {
  const lines = text.replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const out = [];
  let blank = 0;
  let inputLine = -1;
  // The last prompt line between two rules is the input box.
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 12; i--) {
    if (/^❯/.test(lines[i]) && /^[─━]{10,}$/.test(lines[i - 1] || "")) {
      inputLine = i;
      break;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) {
      if (++blank > 1) continue;
      out.push(`<div class="ln"></div>`);
      continue;
    }
    blank = 0;
    if (/^\s*[─━═]{12,}\s*$/.test(l)) {
      out.push(`<div class="rule"></div>`);
      continue;
    }
    // Box borders (╭──╮ │ ╰──╯): keep their text, drop the long dashes.
    let s = l.replace(/[─━]{12,}/g, "──");
    let cls = "";
    if (/^❯/.test(s)) cls = "prompt" + (i === inputLine ? " input-line" : "");
    else if (/^\s*[⏺●]/.test(s)) cls = "say";
    else if (/^\s+⎿/.test(s)) cls = "tool";
    else if (/^\s*[✻✶✢✳✽·*]\s+\S.*(…|\.\.\.|\(|esc to interrupt)/.test(s)) cls = "spin";
    else if (/^\s*(⏵⏵|⏸|ctx:|\? for shortcuts)/.test(s)) cls = "meta";
    else if (/^\s*(❯\s*)?\d+\.\s/.test(s) && i > lines.length - 25) cls = "opt";
    else if (/^\s*(✓|✔)/.test(s)) cls = "ok";
    else if (/^\s*(✗|✘|Error|error:)/.test(s)) cls = "err";
    else if (/^#{1,3}\s/.test(s.trim())) cls = "head";
    let h = esc(s);
    if (cls === "say") h = h.replace(/^(\s*)([⏺●])/, '$1<span class="dot">$2</span>');
    out.push(`<div class="ln ${cls}">${h}</div>`);
  }
  return out.join("");
}

// A numbered menu near the bottom (permission prompts, /model, questions):
// offer each option as a button that presses its number.
function findChoices(text) {
  const lines = text.replace(/\s+$/, "").split("\n").slice(-30);
  const opts = [];
  let question = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^[\s│]*(❯|›|>)?\s*(\d{1,2})[.)]\s+(.+?)[\s│]*$/);
    if (m) {
      opts.unshift({ n: m[2], text: m[3].trim(), sel: Boolean(m[1]) });
      continue;
    }
    if (opts.length && /\S/.test(lines[i]) && !/^[\s│╭╮╰╯─┌┐└┘]*$/.test(lines[i])) {
      // Indented continuation of an option, or the question above them.
      if (/^\s{4,}\S/.test(lines[i]) && !/[?:]\s*$/.test(lines[i])) continue;
      question = lines[i].replace(/[│╭╮╰╯]/g, "").trim();
      break;
    }
    if (opts.length && !/\S/.test(lines[i])) continue;
  }
  // Only a real menu: 1, 2, 3… in order, with a cursor on one of them
  // (a numbered list in the agent's prose has none).
  if (opts.length < 2 || opts.some((o, i) => Number(o.n) !== i + 1) || !opts.some((o) => o.sel)) return null;
  return { question, opts };
}

function renderChoices() {
  const t = S.terminals[current];
  const box = $("#choices");
  const s = statusOf(t);
  const c = s && s !== "working" ? findChoices(screenText) : null;
  if (!c) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML =
    (c.question ? `<div class="q">${esc(c.question)}</div>` : "") +
    c.opts.map((o) => `<button class="choice ${o.sel ? "sel" : ""}" data-action="choose" data-n="${esc(o.n)}"><span class="n">${esc(o.n)}</span><span class="t">${esc(o.text)}</span></button>`).join("");
  updateComposerHeight();
}

function updateComposerHeight() {
  const h = $(".composer-wrap").offsetHeight;
  document.documentElement.style.setProperty("--composer-h", h + "px");
}

// Screens seen this session, so going back to an agent shows it at once.
const screens = new Map(); // address -> { text, how }
let haveFull = false; // the shown screen includes history (not just the visible rows)

function showScreen(r) {
  if (r.text === screenText) return;
  const wrap = $("#screen-wrap");
  const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
  const prevTop = wrap.scrollTop;
  screenText = r.text || "";
  const moreBtn = r.how !== "screen" && historyLines < 3000 && screenText.split("\n").length >= historyLines ? `<button class="more" data-action="more">Load earlier</button>` : "";
  $("#screen").innerHTML = moreBtn + formatScreen(screenText);
  // Follow the bottom, or keep the reader's place while they scroll back.
  wrap.scrollTop = follow || atBottom ? wrap.scrollHeight : prevTop;
  renderChoices();
}

// Put the visible rows under the history they continue: find where the
// screen's first telling line last appears in the history and cut there.
function stitch(history, screen) {
  const H = history.split("\n");
  const S = screen.split("\n");
  for (let i = 0; i < Math.min(S.length, 12); i++) {
    const probe = S[i].trimEnd();
    if (probe.trim().length < 12 || /^[\s─━═]+$/.test(probe)) continue;
    for (let j = H.length - 1; j >= 0; j--) {
      if (H[j].trimEnd() === probe) return H.slice(0, Math.max(0, j - i)).concat(S).join("\n");
    }
    break; // the first telling line isn't in the history: they don't overlap
  }
  return screen;
}

// Just the visible rows: always instant, even when history takes a while.
async function loadVisible() {
  const addr = current;
  try {
    const r = await api(`/api/terminal/${encodeURIComponent(addr)}/screen?fast=1`);
    if (addr === current && !haveFull) showScreen(r);
  } catch {}
}

async function loadScreen() {
  if (!current) return;
  const addr = current;
  const req = ++screenReq;
  const t = S.terminals[addr];
  lastSeen = t ? `${t.status}|${t.turn}|${t.statusMs}|${t.title}|${t.msg}` : null;
  try {
    const r = await api(`/api/terminal/${encodeURIComponent(addr)}/screen?lines=${historyLines}`);
    if (req !== screenReq || addr !== current) return;
    // While it works (or asks), core gives only the visible rows of a
    // full-screen app: keep the history we already have above them.
    const prev = screens.get(addr);
    const shown = r.how === "screen" && r.why && prev && prev.how !== "screen" ? { ...r, text: stitch(prev.text, r.text), how: "stitched" } : r;
    haveFull = true;
    screens.set(addr, { text: shown.text, how: shown.how });
    showScreen(shown);
  } catch (err) {
    if (req !== screenReq) return;
    if (!screenText) $("#screen").innerHTML = `<div class="screen-loading">${esc(err.message)}</div>`;
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!current || document.hidden) return;
  const t = S.terminals[current];
  // Working: its screen changes all the time. Otherwise only events move it.
  const working = statusOf(t) === "working" || (t && !t.status && t.state === "live");
  pollTimer = setTimeout(
    async () => {
      await loadScreen({ quiet: true });
      schedulePoll();
    },
    working ? 1200 : 6000,
  );
}

function burst() {
  // After you press something, look a few times while it reacts.
  for (const d of [250, 900, 2000, 3500]) setTimeout(() => loadScreen({ quiet: true }), d);
}

function openDetail(address) {
  const changed = current !== address;
  current = address;
  $("#home").hidden = true;
  const d = $("#detail");
  if (d.hidden) {
    d.hidden = false;
    d.classList.remove("enter");
    void d.offsetWidth;
    d.classList.add("enter");
  }
  renderDetailHeader();
  if (changed) {
    screenText = "";
    follow = true;
    historyLines = 400;
    haveFull = false;
    $("#choices").hidden = true;
    const draft = store.get(`draft.${address}`, "");
    $("#input").value = draft;
    autosize();
    const seen = screens.get(address);
    if (seen) showScreen(seen);
    else {
      $("#screen").innerHTML = `<div class="screen-loading">Loading…</div>`;
      loadVisible();
    }
  }
  updateComposerHeight();
  loadScreen();
  schedulePoll();
}

function closeDetail() {
  current = null;
  clearTimeout(pollTimer);
  $("#detail").hidden = true;
  $("#home").hidden = false;
  $("#input").blur();
  renderHome();
}

// ---------- routing ----------
function route() {
  const m = location.hash.match(/^#\/t\/(.+)$/);
  if (m) openDetail(decodeURIComponent(m[1]));
  else if (current || !$("#detail").hidden) closeDetail();
  else renderHome();
}
window.addEventListener("hashchange", route);

// ---------- live updates ----------
let es = null;
function connect() {
  es?.close();
  es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    S = JSON.parse(e.data);
    onState();
  });
  es.onerror = () => {
    // 401 also lands here; check once.
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(async () => {
        try {
          await api("/api/me");
          connect();
        } catch {}
      }, 2000);
    }
    S = { ...S, connected: false };
    renderSummary();
  };
}

function onState() {
  if (current) {
    renderDetailHeader();
    const t = S.terminals[current];
    const facts = t ? `${t.status}|${t.turn}|${t.statusMs}|${t.title}|${t.msg}` : null;
    if (facts !== lastSeen) loadScreen({ quiet: true });
    schedulePoll();
  } else renderHome();
  renderSummary();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return clearTimeout(pollTimer);
  // iOS drops the stream in the background: come back fresh.
  if (!es || es.readyState !== EventSource.OPEN) connect();
  if (current) {
    loadScreen({ quiet: true });
    schedulePoll();
  }
});
setInterval(() => !current && !document.hidden && renderHome(), 30000);

// ---------- actions ----------
async function sendKeys(keys) {
  if (!current) return;
  try {
    await api(`/api/terminal/${encodeURIComponent(current)}/keys`, { method: "POST", body: { keys } });
    follow = true;
    burst();
  } catch (err) {
    toast(err.message, true);
  }
}

async function sendText(text) {
  const addr = current;
  const btn = $("#send");
  btn.disabled = true;
  try {
    follow = true;
    const p = api(`/api/terminal/${encodeURIComponent(addr)}/send`, { method: "POST", body: { text, force: true } });
    $("#input").value = "";
    store.set(`draft.${addr}`, "");
    autosize();
    burst();
    await p;
    burst();
  } catch (err) {
    toast(err.message, true);
    if (!$("#input").value) $("#input").value = text;
    autosize();
  }
}

function autosize() {
  const ta = $("#input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight + 2, 140) + "px";
  $("#send").disabled = !ta.value.trim();
  updateComposerHeight();
}

$("#input").addEventListener("input", () => {
  autosize();
  if (current) store.set(`draft.${current}`, $("#input").value);
});
$("#input").addEventListener("keydown", (e) => {
  // Hardware keyboard: Enter sends, Shift+Enter is a new line.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(hover: hover)").matches) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#input").value;
  if (text.trim() && current) sendText(text);
});

$("#screen-wrap").addEventListener(
  "scroll",
  () => {
    const w = $("#screen-wrap");
    const atBottom = w.scrollHeight - w.scrollTop - w.clientHeight < 40;
    follow = atBottom;
    $("#jump").hidden = atBottom;
  },
  { passive: true },
);

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  if (a === "back") {
    e.preventDefault();
    if (history.length > 1 && location.hash.startsWith("#/t/")) history.back();
    else location.hash = "#/";
  } else if (a === "mode") {
    mode = el.dataset.mode;
    store.set("mode", mode);
    renderHome();
  } else if (a === "key") {
    const k = KEYS[Number(el.dataset.i)];
    if (k.text) sendText(k.text);
    else sendKeys(k.keys);
  } else if (a === "choose") {
    sendKeys([el.dataset.n]);
  } else if (a === "interrupt") {
    try {
      const r = await api(`/api/terminal/${encodeURIComponent(current)}/interrupt`, { method: "POST" });
      toast(r.outcome === "stopped" ? "Stopped" : r.outcome === "still_working" ? "Still working…" : `Sent ${r.key}`);
      burst();
    } catch (err) {
      toast(err.message, true);
    }
  } else if (a === "jump") {
    follow = true;
    const w = $("#screen-wrap");
    w.scrollTo({ top: w.scrollHeight, behavior: "smooth" });
  } else if (a === "more") {
    historyLines = Math.min(historyLines * 3, 3000);
    follow = false;
    const w = $("#screen-wrap");
    const fromBottom = w.scrollHeight - w.scrollTop;
    screenText = "";
    await loadScreen();
    w.scrollTop = w.scrollHeight - fromBottom;
  } else if (a === "menu") openMenu();
  else if (a === "settings") openSettings();
  else if (a === "close-sheet") closeSheet();
  else if (a === "new") openNew(el.dataset.space);
  else if (a === "sheet") sheetAction(el.dataset.do, el);
});

// ---------- sheets ----------
function openSheet(html) {
  $("#sheet").innerHTML = `<div class="grab"></div>${html}`;
  $("#sheet").hidden = false;
  $("#backdrop").hidden = false;
}
function closeSheet() {
  $("#sheet").hidden = true;
  $("#backdrop").hidden = true;
}

function openMenu() {
  const wrap = store.get("wrap", true);
  openSheet(`
    <h2>${esc($("#dt-name").textContent)}</h2>
    <p>${esc($("#dt-sub").textContent)}</p>
    <h3>Screen</h3>
    <div class="group">
      <div class="row"><div class="main"><div class="name">Text size</div></div>
        <div class="stepper"><button data-action="sheet" data-do="smaller">A−</button><button data-action="sheet" data-do="bigger">A+</button></div></div>
      <button class="row" data-action="sheet" data-do="wrap"><div class="main"><div class="name">Wrap long lines</div></div><div class="switch ${wrap ? "on" : ""}"></div></button>
      <button class="row action" data-action="sheet" data-do="refresh"><div class="main"><div class="name">Refresh screen</div></div></button>
      <button class="row action" data-action="sheet" data-do="copy"><div class="main"><div class="name">Copy screen text</div></div></button>
    </div>
    <h3>Agent</h3>
    <div class="group">
      <button class="row action" data-action="sheet" data-do="esc"><div class="main"><div class="name">Press Esc</div></div></button>
      <button class="row danger" data-action="sheet" data-do="ctrlc"><div class="main"><div class="name">Press Ctrl+C</div></div></button>
    </div>`);
}

function openNew(spaceId) {
  const sp = S.spaces.find((s) => s.id === spaceId);
  if (!sp) return;
  openSheet(`
    <h2>New in ${esc(sp.name)}</h2>
    <p>Opens a new tab in this space, in <code>${esc(sp.cwd || sp.folder || "~")}</code>. It shows up on the Mac too.</p>
    <div class="group" style="margin-top:14px">
      <button class="row action" data-action="sheet" data-do="new-claude" data-space="${esc(sp.id)}"><div class="main"><div class="name">Claude Code</div></div></button>
      <button class="row action" data-action="sheet" data-do="new-shell" data-space="${esc(sp.id)}"><div class="main"><div class="name">Shell</div></div></button>
    </div>`);
}

async function openSettings() {
  const supported = "serviceWorker" in navigator && "PushManager" in window;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  let subscribed = false;
  if (supported) {
    try {
      const reg = await navigator.serviceWorker.ready;
      subscribed = Boolean(await reg.pushManager.getSubscription());
    } catch {}
  }
  let me = {};
  try {
    me = await api("/api/me");
  } catch {}
  const pushRow = !supported
    ? `<div class="row"><div class="main"><div class="name">Notifications</div><div class="l2">${standalone ? "Not supported here" : "Add Herdr to your Home Screen first"}</div></div></div>`
    : `<button class="row" data-action="sheet" data-do="push"><div class="main"><div class="name">Notify me</div><div class="l2">When an agent needs you or finishes</div></div><div class="switch ${subscribed ? "on" : ""}"></div></button>
       ${subscribed ? `<button class="row action" data-action="sheet" data-do="push-test"><div class="main"><div class="name">Send a test notification</div></div></button>` : ""}`;
  openSheet(`
    <h2>Herdr</h2>
    <p>${esc(me.machine || S.machine || "")}${me.login ? ` · ${esc(me.login)} via Tailscale` : ""}</p>
    <h3>Notifications</h3>
    <div class="group">${pushRow}</div>
    ${!standalone ? `<h3>Install</h3><p>In Safari tap <b>Share</b> → <b>Add to Home Screen</b>. Herdr then opens full screen and can notify you.</p>` : ""}
    <h3>Screen</h3>
    <div class="group">
      <div class="row"><div class="main"><div class="name">Terminal text size</div><div class="l2">${termSize()} px</div></div>
        <div class="stepper"><button data-action="sheet" data-do="smaller">A−</button><button data-action="sheet" data-do="bigger">A+</button></div></div>
    </div>
    <h3>About</h3>
    <p>Talks to herdr-core on your Mac (<code>hc connect</code>). Everything you see and do here also happens in the Herdr window.</p>
    <div class="group"><button class="row action" data-action="sheet" data-do="reload"><div class="main"><div class="name">Reload app</div></div></button></div>`);
}

async function sheetAction(what, el) {
  if (what === "smaller" || what === "bigger") {
    const v = Math.max(8, Math.min(18, termSize() + (what === "bigger" ? 1 : -1)));
    store.set("termSize", v);
    applyTermSize();
    const l2 = el.closest(".row")?.querySelector(".l2");
    if (l2) l2.textContent = `${v} px`;
  } else if (what === "wrap") {
    store.set("wrap", !store.get("wrap", true));
    applyTermSize();
    el.querySelector(".switch").classList.toggle("on");
  } else if (what === "refresh") {
    closeSheet();
    screenText = "";
    loadScreen();
  } else if (what === "copy") {
    try {
      await navigator.clipboard.writeText(screenText);
      toast("Copied");
    } catch {
      toast("Couldn't copy", true);
    }
    closeSheet();
  } else if (what === "esc" || what === "ctrlc") {
    closeSheet();
    sendKeys([what === "esc" ? "esc" : "ctrl+c"]);
  } else if (what === "new-claude" || what === "new-shell") {
    closeSheet();
    try {
      const r = await api(`/api/spaces/${encodeURIComponent(el.dataset.space)}/new`, { method: "POST", body: { program: what === "new-shell" ? "shell" : "claude" } });
      toast("Started");
      if (r.address) location.hash = `#/t/${encodeURIComponent(r.address)}`;
    } catch (err) {
      toast(err.message, true);
    }
  } else if (what === "push") {
    await togglePush(el);
  } else if (what === "push-test") {
    try {
      await api("/api/push/test", { method: "POST" });
      toast("Sent — lock your phone to see it");
    } catch (err) {
      toast(err.message, true);
    }
  } else if (what === "reload") {
    location.reload();
  }
}

// ---------- push ----------
async function togglePush(el) {
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: existing.endpoint } }).catch(() => {});
    await existing.unsubscribe();
    el.querySelector(".switch").classList.remove("on");
    toast("Notifications off");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return toast("Notifications are blocked in Settings", true);
  try {
    const { publicKey } = await api("/api/push/key");
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
    await api("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
    el.querySelector(".switch").classList.add("on");
    toast("Notifications on");
    openSettings();
  } catch (err) {
    toast(err.message, true);
  }
}
function b64uToBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

// ---------- login ----------
function showLogin() {
  es?.close();
  for (const p of document.querySelectorAll(".page")) p.hidden = p.id !== "login";
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const res = await fetch("/api/login", { method: "POST", headers: { "X-Herdr": "1", "Content-Type": "application/json" }, body: JSON.stringify({ token: $("#token").value.trim() }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Couldn't sign in");
    $("#login").hidden = true;
    start();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

// ---------- iOS keyboard: keep the composer above it ----------
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    document.documentElement.style.setProperty("--vvh", vv.height + "px");
    document.body.classList.toggle("kb", vv.height < window.innerHeight - 120);
    window.scrollTo(0, 0);
    if (follow && current) {
      const w = $("#screen-wrap");
      w.scrollTop = w.scrollHeight;
    }
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", () => window.scrollTo(0, 0));
  fit();
}

// ---------- start ----------
async function start() {
  try {
    await api("/api/me");
  } catch {
    return;
  }
  $("#home").hidden = false;
  connect();
  route();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open" && e.data.url) location.hash = new URL(e.data.url, location.origin).hash;
  });
}
start();
