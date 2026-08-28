#!/usr/bin/env node
/*
 * cashir.cjs — the Cashir cashier.
 *
 * One business, run by one agent: make a certified-win market on the trustless
 * XNO<->XMR DEX and keep the books. Cashir is a thin, opinionated shell over the
 * NearInstant Hermes skill (vendor/NearInstant/integrations/hermes/scripts/xnoxmr.cjs).
 * It never re-implements pricing or certification — it drives the same code
 * the web app runs, and adds what a cashier adds:
 *
 *   - a ledger (state/journal.jsonl) of every cycle, action and certificate
 *   - a P&L / activity report over any period
 *   - fail-closed guards: a pause switch, an error breaker, a dedicated state dir
 *   - HANDOFF alerts to a human (via `hermes send`) when a certified take lands
 *   - a local read-only dashboard
 *   - a one-command Hermes cron installer
 *
 * Every command prints one JSON object (Hermes reads it). Non-zero exit = refused/failed.
 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor", "NearInstant");
const XNOXMR = path.join(VENDOR, "integrations", "hermes", "scripts", "xnoxmr.cjs");
const STATE_DIR = process.env.CASHIR_STATE_DIR || path.join(ROOT, "state");
const JOURNAL = path.join(STATE_DIR, "journal.jsonl");
const PAUSE_FILE = path.join(STATE_DIR, "PAUSED");
const ALERTS_FILE = path.join(STATE_DIR, "alerts.json");
const WATCH_PID = path.join(STATE_DIR, "watch.pid");
const WATCH_LOG = path.join(STATE_DIR, "watch.log");
const FEEDBACK = path.join(STATE_DIR, "feedback.jsonl");
const VERSION = require(path.join(ROOT, "package.json")).version;

// ---- config ----------------------------------------------------------------
function loadDotEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return {};
  const o = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#")) o[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return o;
}
const DOTENV = loadDotEnv();
const cfg = (k, d) => {
  const v = process.env[k] != null && process.env[k] !== "" ? process.env[k] : DOTENV[k];
  return v == null || v === "" ? d : String(v).trim();
};
const CONFIG = {
  side: cfg("CASHIR_SIDE", "1") === "0" ? 0 : 1,
  sizeXno: parseFloat(cfg("CASHIR_SIZE_XNO", "50")),
  interval: cfg("CASHIR_INTERVAL", "3m"),
  deliver: cfg("CASHIR_DELIVER", "local"),
  maxErrors: parseInt(cfg("CASHIR_MAX_CONSECUTIVE_ERRORS", "3"), 10),
  live: cfg("CASHIR_LIVE", "0") === "1",
  autosettle: cfg("XNOXMR_AUTOSETTLE", "0") === "1",
  pushUrl: cfg("CASHIR_PUSH_URL", ""),
  pushToken: cfg("CASHIR_PUSH_TOKEN", ""),
  spreadMult: Math.min(3, Math.max(0.75, parseFloat(cfg("CASHIR_SPREAD_MULT", "1")) || 1)),
};

// The child gets the maker seed and infra overrides from .env, and its state is
// pinned inside Cashir's own state dir so nothing leaks into the vendor checkout.
function childEnv() {
  const e = Object.assign({}, process.env);
  for (const k of Object.keys(DOTENV)) {   // every XNOXMR_* setting in .env reaches the skill (seed, nodes, RPC key, ws, tick timing…)
    if (k.startsWith("XNOXMR_") && !e[k] && DOTENV[k]) e[k] = DOTENV[k];
  }
  if (!e.XNOXMR_MAKER_SEED && DOTENV.WALLET_A_SEED) e.XNOXMR_MAKER_SEED = DOTENV.WALLET_A_SEED;
  if (!process.env.XNOXMR_STATE) e.XNOXMR_STATE = path.join(STATE_DIR, "agent.json");
  if (!process.env.XNOXMR_PRICEHIST) e.XNOXMR_PRICEHIST = path.join(STATE_DIR, "pricehist.json");
  if (!process.env.XNOXMR_STATE_DIR) e.XNOXMR_STATE_DIR = path.join(STATE_DIR, "wallet");
  if (!CONFIG.autosettle) e.XNOXMR_AUTOSETTLE = "0";   // off unless the operator turned it on deliberately
  return e;
}

// ---- output helpers --------------------------------------------------------
const out = (o) => console.log(JSON.stringify(o, null, 2));
const die = (msg, extra) => { out(Object.assign({ ok: false, error: msg }, extra || {})); process.exit(1); };
const ensureState = () => fs.mkdirSync(STATE_DIR, { recursive: true });
const nowIso = () => new Date().toISOString();

// ---- the skill CLI ---------------------------------------------------------
function requireVendor() {
  if (!fs.existsSync(XNOXMR)) die("NearInstant is not vendored; run `npm run setup`", { expected: XNOXMR });
  const pk = path.join(VENDOR, "swap-core", "wasm-bridge", "pkg-node", "wasm_bridge.js");
  if (!fs.existsSync(pk)) die("wasm engines not built; run `npm run setup`", { expected: pk });
}
// Run one xnoxmr command; return its parsed JSON plus exit code and duration.
function xnoxmr(args, opts) {
  requireVendor();
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [XNOXMR, ...args], {
    env: childEnv(), cwd: VENDOR, encoding: "utf8",
    timeout: (opts && opts.timeoutMs) || 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - t0;
  let json = null;
  const stdout = r.stdout || "";
  // The CLI prints exactly one JSON object; anything else on stdout is noise from a dependency.
  const start = stdout.indexOf("{");
  if (start >= 0) { try { json = JSON.parse(stdout.slice(start)); } catch (e) { json = null; } }
  return { code: r.status == null ? -1 : r.status, json, stdout, stderr: (r.stderr || "").slice(-4000),
           timedOut: !!(r.error && r.error.code === "ETIMEDOUT"), durationMs };
}

// ---- ledger ----------------------------------------------------------------
function journalAppend(entry) {
  ensureState();
  fs.appendFileSync(JOURNAL, JSON.stringify(Object.assign({ at: nowIso() }, entry)) + "\n");
}
function journalRead(sinceMs) {
  if (!fs.existsSync(JOURNAL)) return [];
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;
  const rows = [];
  for (const line of fs.readFileSync(JOURNAL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (!cutoff || Date.parse(e.at) >= cutoff) rows.push(e); } catch (e) {}
  }
  return rows;
}
function parsePeriod(s) {
  const m = String(s || "24h").match(/^(\d+)\s*(m|h|d|w)$/);
  if (!m) return 24 * 3600 * 1000;
  const n = parseInt(m[1], 10);
  return n * { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2]];
}

// ---- alerts (HANDOFF etc.) --------------------------------------------------
function alertsLoad() { try { return JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8")); } catch (e) { return { sent: {} }; } }
function alertsSave(a) { ensureState(); fs.writeFileSync(ALERTS_FILE, JSON.stringify(a, null, 1)); }
// Deliver through Hermes' own messaging (`hermes send`) when a target is
// configured; otherwise the alert lives in the cycle output Hermes reads anyway.
function notify(text) {
  const target = CONFIG.deliver;
  if (!target || target === "local" || target === "origin") return { delivered: false, via: "stdout" };
  try {
    execFileSync("hermes", ["send", "-t", target, "-q", text], { stdio: ["ignore", "ignore", "ignore"], timeout: 30000 });
    return { delivered: true, via: target };
  } catch (e) { return { delivered: false, via: target, error: String(e.message || e).slice(0, 120) }; }
}
function handoffText(h, live) {
  const d = h.deal || {}, c = h.certificate || {};
  return [
    "CASHIR: CERTIFIED TAKE - a human must settle now",
    `offer block ${String(h.block).slice(0, 16)}… slot ${h.slot}`,
    `deal: ${fmtXno(d.xnoRaw)} XNO for ${fmtXmr(d.xmrAtomic)} XMR @ ${Number(d.priceE9 || 0) / 1e9} XMR/XNO`,
    `certified net ${c.netBps} bps (${fmtXmr(c.netAtomic)} XMR after fee), mid ${c.mid}, ${c.sources} sources`,
    live ? "Open https://www.nearinstant.xyz, unlock the maker wallet, settle the swap. Cashir keeps the offer held until you do."
         : "(dry run — nothing is live)",
  ].join("\n");
}
const fmtXno = (raw) => raw == null ? "?" : (Number(BigInt(raw) / (10n ** 24n)) / 1e6).toFixed(6);
const fmtXmr = (atomic) => atomic == null ? "?" : (Number(BigInt(atomic)) / 1e12).toFixed(8);


// ---- developer feedback ----------------------------------------------------
// Everything odd that NearInstant (nodes, relay, PoW, oracle, wasm, the page,
// the skill docs) does is recorded here with enough context for its developers
// to reproduce it, then pushed to the push endpoint's feedback box. Never secrets.
function vendorInfo() {
  const info = {};
  try { info.vendor_commit = execFileSync("git", ["-C", VENDOR, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (e) {}
  try { info.vendor_package = require(path.join(VENDOR, "package.json")).version; } catch (e) {}
  return info;
}
function feedbackContext() {
  const os = require("os");
  const cycles = journalRead(24 * 3600e3).filter(e => e.cmd === "cycle");
  const last = cycles[cycles.length - 1] || null;
  const recentErrors = journalRead(24 * 3600e3).filter(e => e.ok === false).slice(-5)
    .map(e => ({ at: e.at, cmd: e.cmd, verdict: e.verdict, error: e.error || (e.result && e.result.error) || null }));
  return Object.assign({
    cashir_version: VERSION, node: process.version, platform: `${os.platform()} ${os.arch()}`,
    side: CONFIG.side, size_xno: CONFIG.sizeXno, live: CONFIG.live, autosettle: CONFIG.autosettle, interval: CONFIG.interval,
    work_url: cfg("XNOXMR_WORK_URL", "https://www.nearinstant.xyz (default)"),
    nano_nodes: cfg("XNOXMR_NANO_NODES", "(skill defaults)"), monero_nodes: cfg("XNOXMR_MONERO_NODES", "(skill defaults)"),
    cycles_24h: cycles.length, errors_24h: cycles.filter(c => c.ok === false).length,
    last_cycle: last && { at: last.at, cycle: last.cycle, verdict: last.verdict, error: last.error, actions: last.actions, durationMs: last.durationMs },
    recent_errors: recentErrors,
  }, vendorInfo());
}
function feedbackRead() {
  if (!fs.existsSync(FEEDBACK)) return [];
  return fs.readFileSync(FEEDBACK, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
const redact = (s) => { let t = String(s == null ? "" : s); const tok = (typeof CONFIG !== "undefined") && CONFIG.pushToken; if (tok) t = t.split(tok).join("<token redacted>"); return t.replace(/\b[0-9a-fA-F]{64}\b/g, "<64-hex redacted>").replace(/\/(?:opt|home|root|Users)\/[^\s"'`)]*/g, "<path>").replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"); };
// Strip machine identity from a stored feedback item before it leaves this box.
function scrubItem(f) {
  const c = JSON.parse(redact(JSON.stringify(f)));
  if (c.context) { delete c.context.host; delete c.context.vendor_path; if (c.context.platform) c.context.platform = c.context.platform.split(" ").filter((w, i, a) => i === 0 || i === a.length - 1).join(" "); }
  return c;
}
// Record one feedback item. Duplicates (same fingerprint within 6 h) are counted, not re-pushed.
async function recordFeedback(f) {
  ensureState();
  const crypto = require("crypto");
  const item = {
    id: crypto.randomBytes(6).toString("hex"), at: nowIso(),
    kind: f.kind || "bug", severity: f.severity || "medium", component: f.component || "other",
    title: redact(f.title || "").slice(0, 200), detail: redact(f.detail || "").slice(0, 8000),
    repro: redact(f.repro || "").slice(0, 4000), expected: redact(f.expected || "").slice(0, 2000),
    source: f.source || "hermes", auto: !!f.auto, evidence: f.evidence ? JSON.parse(redact(JSON.stringify(f.evidence)).slice(0, 20000)) : undefined,
    context: feedbackContext(),
  };
  item.fingerprint = crypto.createHash("sha1").update([item.kind, item.component, item.title].join("|")).digest("hex").slice(0, 12);
  const prev = feedbackRead().filter(x => x.fingerprint === item.fingerprint && Date.now() - Date.parse(x.at) < 6 * 3600e3);
  item.count = prev.reduce((n, x) => n + (x.count || 1), 0) + 1;
  fs.appendFileSync(FEEDBACK, JSON.stringify(item) + "\n");
  let push = { pushed: false, reason: prev.length ? "duplicate within 6h (counted, not re-pushed)" : "CASHIR_PUSH_URL/CASHIR_PUSH_TOKEN not set" };
  if (!prev.length && CONFIG.pushUrl && CONFIG.pushToken) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
    try {
      const r = await fetch(CONFIG.pushUrl.replace(/\/$/, "") + "/api/feedback", { method: "POST", signal: c.signal,
        headers: { "content-type": "application/json", authorization: "Bearer " + CONFIG.pushToken }, body: JSON.stringify(item) });
      const j = await r.json().catch(() => ({}));
      push = { pushed: r.ok, status: r.status, stored: j.stored };
    } catch (e) { push = { pushed: false, error: String(e.message || e).slice(0, 120) }; }
    finally { clearTimeout(t); }
  }
  journalAppend({ cmd: "feedback", ok: true, id: item.id, kind: item.kind, severity: item.severity, component: item.component, title: item.title, auto: item.auto, push });
  return Object.assign({ id: item.id, fingerprint: item.fingerprint, count: item.count }, push);
}
// Automatic capture: a skill command that failed, timed out, or answered without JSON is a bug report by itself.
function classify(r, j) {
  const txt = ((j && j.error) || "") + " " + (r.stderr || "");
  if (r.timedOut) return { component: "skill", severity: "high" };
  if (/quorum|nano|rpc|node|block|frontier/i.test(txt)) return { component: "nodes", severity: "high" };
  if (/monero|xmr|daemon/i.test(txt)) return { component: "monero-nodes", severity: "high" };
  if (/work|pow/i.test(txt)) return { component: "pow", severity: "medium" };
  if (/price|oracle|source|stale/i.test(txt)) return { component: "oracle", severity: "medium" };
  if (/relay|mailbox|beacon|ledger/i.test(txt)) return { component: "relay", severity: "high" };
  if (/wasm|panic|unreachable/i.test(txt)) return { component: "wasm", severity: "critical" };
  return { component: "skill", severity: "medium" };
}
async function autoFeedback(cmdName, argv, r) {
  const j = r.json;
  const cls = classify(r, j);
  // A REFUSE / WITHDRAW / HOLD / PAUSED verdict with a reason is the certify engine working, not a bug.
  if (j && /^(REFUSE|WITHDRAW|HOLD|PAUSED|UNCONFIGURED|WOULD_POST)/.test(String(j.verdict || "")) && (j.reason || j.error == null)) return null;
  const what = r.timedOut ? "timed out" : !j ? "returned no JSON" : (j.ok === false || r.code !== 0) ? "failed" : null;
  if (!what) return null;
  return recordFeedback({ auto: true, source: "cashir-auto", kind: "bug", component: cls.component, severity: cls.severity,
    title: `xnoxmr ${cmdName} ${what}: ${((j && j.error) || (r.stderr || "").trim().split("\n").pop() || "exit " + r.code).slice(0, 120)}`,
    detail: `Command: node xnoxmr.cjs ${argv.join(" ")}\nExit code: ${r.code}, duration ${r.durationMs} ms, timedOut ${r.timedOut}\n` +
            `Error: ${(j && j.error) || "-"}\nStderr (tail):\n${(r.stderr || "").slice(-1500) || "-"}\nStdout (tail):\n${(r.stdout || "").slice(-1500) || "-"}`,
    repro: `Run the same command against the same nodes/work URL (see context). Cashir runs it every ${CONFIG.interval} via Hermes cron.`,
    expected: "One JSON object with ok:true, or ok:false with a specific, actionable error.",
    evidence: { result: slim(j), actions: j && j.actions, verdict: j && j.verdict } });
}

// ---- settlement reconciler -------------------------------------------------
// The realtime watcher settles/recovers inside the skill process, which writes
// session files but not Cashir's ledger. Scan those files and book each terminal
// outcome (settled / recovered / abandoned) into the journal exactly once, so the
// report and dashboard reflect real swaps and realized P&L.
function reconcileSessions() {
  // scan the side-1 wallet dir plus any per-side dirs (state/s0/wallet, …)
  const dirs = [path.join(STATE_DIR, "wallet")];
  try { for (const d of fs.readdirSync(STATE_DIR)) if (/^s\d+$/.test(d)) dirs.push(path.join(STATE_DIR, d, "wallet")); } catch (e) {}
  let files = [];
  for (const dir of dirs) { try { for (const f of fs.readdirSync(dir)) if (/^sess_.*\.json$/.test(f)) files.push([dir, f]); } catch (e) {} }
  const seen = new Set(journalRead().filter(e => e.cmd === "swap").map(e => e.session));
  let booked = 0;
  for (const [dir, f] of files) {
    const sid = f.replace(/^sess_|\.json$/g, "").slice(0, 16);
    if (seen.has(sid)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { continue; }
    const res = j.done && j.done.result; if (!res) continue;   // not terminal yet
    const deal = (j.party && j.party.deal) || {};
    const entry = { cmd: "swap", session: sid, at: (j.done && j.done.at) ? new Date(j.done.at).toISOString() : nowIso() };
    if (res.realized) {
      const r = res.realized;
      const recvXno = r.receivedXnoRaw ? Number(BigInt(r.receivedXnoRaw) / (10n ** 24n)) / 1e6 : null;
      const paidXmr = r.paidXmrAtomic ? Number(BigInt(r.paidXmrAtomic)) / 1e12 : null;
      // Authoritative realized profit = the accept certificate's certified net (XMR after fee).
      const ac = j.acceptCert || {};
      const netXmr = ac.netAtomic != null ? +(Number(BigInt(ac.netAtomic)) / 1e12).toFixed(8) : null;
      Object.assign(entry, { outcome: "settled", ok: true, realized: { role: r.role, receivedXno: recvXno, paidXmr, netXmr, netBps: ac.netBps != null ? ac.netBps : null } });
      booked++;
    } else if (res.recovered) {
      Object.assign(entry, { outcome: "recovered", ok: true, note: "counterparty refunded; your locked XMR was swept back (no trade)" });
      booked++;
    } else if (res.refunded) {
      Object.assign(entry, { outcome: "refunded", ok: true, note: (res.reason || "claim co-sign unavailable") + "; your funds were refunded (no trade)" });
      booked++;
    } else if (res.abandoned) {
      Object.assign(entry, { outcome: "abandoned", ok: true, note: "setup only; nothing moved" });
      booked++;
    } else continue;
    journalAppend(entry);
    seen.add(sid);
  }
  return { booked };
}

// ---- wallet sync (auto-receive) -------------------------------------------
// Pocket receivable XNO and scan XMR before every tick, so new funds are usable
// and the books show what the wallet really holds. Never prints the seed.
function walletSync() {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "wallet_sync.cjs")], { env: childEnv(), cwd: VENDOR, encoding: "utf8", timeout: 170000, maxBuffer: 4 * 1024 * 1024 });
  let j = null; const so = r.stdout || ""; const i = so.lastIndexOf("\n{"); const cand = i >= 0 ? so.slice(i + 1) : so;
  try { j = JSON.parse(cand.trim() || so.slice(so.indexOf("{"))); } catch (e) { j = { ok: false, error: "wallet sync returned no JSON: " + (r.stderr || "").slice(-300) }; }
  j.durationMs = Date.now() - t0;
  journalAppend({ cmd: "wallet", ok: !!j.ok, nano: j.nano, xmr: j.xmr, error: j.error, durationMs: j.durationMs });
  return j;
}

// Funded size: what the wallet can really deliver for this side at the current ask.
function fundedSize(side, wantXno, w) {
  const q = xnoxmr(["quote", "--side", String(side)]).json || {};
  const minXno = Number(q.min_take_xno || 0);
  const ask = Number(q.ask_xmr_per_xno || q.market_mid || 0);
  const FEE_XMR = 0.0002, RESERVE_XNO = 0.01;
  let available, maxXno;
  if (side === 0) { available = Number(w && w.nano && w.nano.balance_xno || 0); maxXno = Math.max(0, available - RESERVE_XNO); }
  else { available = Number(w && w.xmr && w.xmr.spendable || 0); maxXno = ask > 0 ? Math.max(0, (available - FEE_XMR) / ask) : 0; }
  const sizeX = Math.min(wantXno, Math.floor(maxXno * 1e6) / 1e6);
  const base = { side, asset: side === 0 ? "XNO" : "XMR (unlocked)", available, ask, mid: Number(q.market_mid || 0) || null, wanted_xno: wantXno, funded_xno: sizeX, min_certifiable_xno: minXno,
    unlocking_xmr: w && w.xmr && w.xmr.unlocking ? +(Number(w.xmr.total || 0) - available).toFixed(8) : 0 };
  if (!w || !w.ok || (side === 1 && (!w.xmr || w.xmr.spendable == null))) return Object.assign(base, { ok: false, reason: "wallet balance not verifiable this cycle (" + ((w && (w.error || (w.xmr && w.xmr.note))) || "no wallet data") + ")" });
  if (!ask || !minXno) return Object.assign(base, { ok: false, reason: "no quote (" + (q.error || "quote failed") + ")" });
  if (sizeX < minXno) return Object.assign(base, { ok: false, reason: `funded size ${sizeX} XNO is below the certifiable minimum ${minXno.toFixed(2)} XNO — ${side === 1 ? `deposit ≈${((minXno * ask + FEE_XMR) - available).toFixed(4)} XMR more${base.unlocking_xmr ? ` (${base.unlocking_xmr} XMR still unlocking)` : ""}` : `deposit ≈${(minXno - maxXno).toFixed(2)} XNO more`}` });
  return Object.assign(base, { ok: true, size: sizeX, capped: sizeX < wantXno });
}

// realtime watcher (xnoxmr watch) — is one running?
function watcherAlive(side) {
  const files = side == null ? [WATCH_PID, path.join(STATE_DIR, "watch-s0.pid"), path.join(STATE_DIR, "watch-s1.pid")] : [path.join(STATE_DIR, `watch-s${side}.pid`)];
  for (const f of files) { try { const pid = parseInt(fs.readFileSync(f, "utf8"), 10); if (pid) { process.kill(pid, 0); return pid; } } catch (e) {} }
  return false;
}

// ---- commands --------------------------------------------------------------
const CMDS = {};

CMDS.config = async () => out({ ok: true, version: VERSION, config: Object.assign({}, CONFIG, { pushToken: CONFIG.pushToken ? "***redacted***" : "" }), paths: { root: ROOT, vendor: VENDOR, state: STATE_DIR, journal: JOURNAL },
  maker_seed_configured: !!(childEnv().XNOXMR_MAKER_SEED), paused: fs.existsSync(PAUSE_FILE), spread_mult: CONFIG.spreadMult });

// Pass-through read-only commands, each journaled.
for (const c of ["health", "quote", "book", "status", "peek", "verify"]) {
  CMDS[c] = async (args) => {
    const a = [c];
    if (["quote", "book", "verify"].includes(c) && args.side == null) a.push("--side", String(CONFIG.side));
    for (const [k, v] of Object.entries(args)) if (k !== "_") a.push("--" + k, ...(v === true ? [] : [String(v)]));
    const r = xnoxmr(a);
    journalAppend({ cmd: c, ok: !!(r.json && r.json.ok), code: r.code, durationMs: r.durationMs, result: slim(r.json) });
    const fb = await autoFeedback(c, a, r);
    if (!r.json) return die("skill returned no JSON", { code: r.code, stderr: r.stderr, auto_feedback: fb });
    out(fb ? Object.assign({}, r.json, { auto_feedback: fb }) : r.json); process.exit(r.code);
  };
}

// Emergency stop: withdraw anything resting and refuse to run cycles until resumed.
CMDS.pause = async (args) => {
  ensureState();
  fs.writeFileSync(PAUSE_FILE, JSON.stringify({ at: nowIso(), reason: args.reason || "operator pause" }));
  let withdrew = null;
  const st = agentState();
  if (st.offer && CONFIG.live) {
    const r = xnoxmr(["offer", "withdraw", "--side", String(st.offer.side), "--live"]);
    withdrew = r.json;
  }
  journalAppend({ cmd: "pause", ok: true, reason: args.reason || null, withdrew });
  out({ ok: true, paused: true, withdrew, note: "cycles will refuse until `cashir resume`" });
};
CMDS.resume = async () => {
  try { fs.unlinkSync(PAUSE_FILE); } catch (e) {}
  journalAppend({ cmd: "resume", ok: true });
  out({ ok: true, paused: false });
};
// A --live VALUE is honoured strictly: bare --live or --live 1/true/yes/on means
// live; --live 0/false/no (and any other value) does NOT. Without this, parseArgs
// turns "--live 0" into the string "0", which is truthy — silently enabling live
// trading when the operator meant to disable it. CASHIR_LIVE stays string-exact ("1").
const liveFlag = (v) => v === true || ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
CMDS.withdraw = async (args) => {
  if (!liveFlag(args.live) && !CONFIG.live) return die("refusing to touch the ledger without --live (or CASHIR_LIVE=1)");
  const st = agentState();
  const r = xnoxmr(["offer", "withdraw", "--side", String(st.offer ? st.offer.side : CONFIG.side), "--live"]);
  journalAppend({ cmd: "withdraw", ok: !!(r.json && r.json.ok), result: r.json });
  out(r.json || { ok: false, stderr: r.stderr }); process.exit(r.code);
};
function agentState() { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, "agent.json"), "utf8")) || {}; } catch (e) { return {}; } }

// cycle: ONE cashier cycle = the skill's tick + the books + the guards.
// This is what Hermes runs on cron. Safe to run every 2–5 minutes.
let rep_wallet = null;
CMDS.cycle = async (args) => {
  ensureState();
  const live = liveFlag(args.live) || CONFIG.live;
  const side = args.side != null ? (String(args.side) === "0" ? 0 : 1) : CONFIG.side;
  const size = args.size != null ? String(args.size) : String(CONFIG.sizeXno);
  const seq = journalRead().filter(e => e.cmd === "cycle").length + 1;

  // Guard 0: no wallet is not a failure, it is "not set up yet" — say so without tripping the breaker.
  if (!childEnv().XNOXMR_MAKER_SEED) {
    const rep = { ok: true, cycle: seq, verdict: "UNCONFIGURED", live, error: "no maker wallet: set XNOXMR_MAKER_SEED in .env (64 hex). Nothing was done." };
    journalAppend(Object.assign({ cmd: "cycle" }, rep));
    return out(rep);
  }
  // Guard 1: pause switch
  if (fs.existsSync(PAUSE_FILE)) {
    let pause = {}; try { pause = JSON.parse(fs.readFileSync(PAUSE_FILE, "utf8")); } catch (e) {}
    const st = agentState();
    let withdrew = null;
    if (st.offer && live) { withdrew = xnoxmr(["offer", "withdraw", "--side", String(st.offer.side), "--live"]).json; }
    const rep = { ok: true, cycle: seq, verdict: "PAUSED", live, paused_since: pause.at, reason: pause.reason, withdrew };
    journalAppend(Object.assign({ cmd: "cycle" }, rep));
    return out(rep);
  }
  // Guard 2: error breaker — N consecutive failed cycles => withdraw + pause
  const recent = journalRead(6 * 3600e3).filter(e => e.cmd === "cycle");
  let streak = 0;
  for (let i = recent.length - 1; i >= 0; i--) { if (recent[i].ok === false) streak++; else break; }
  if (streak >= CONFIG.maxErrors) {
    fs.writeFileSync(PAUSE_FILE, JSON.stringify({ at: nowIso(), reason: `${streak} consecutive failed cycles (breaker)` }));
    const st = agentState();
    const withdrew = st.offer && live ? xnoxmr(["offer", "withdraw", "--side", String(st.offer.side), "--live"]).json : null;
    const rep = { ok: false, cycle: seq, verdict: "BREAKER", live, error: `${streak} consecutive failed cycles; withdrew and paused. Fix, then \`cashir resume\`.`, withdrew };
    journalAppend(Object.assign({ cmd: "cycle" }, rep));
    notify("CASHIR: breaker tripped — " + rep.error);
    out(rep); process.exit(1);
  }

  rep_wallet = walletSync();
  reconcileSessions();
  // Rule 2: never advertise liquidity the wallet cannot fund. Cap the size to the
  // verifiable balance (pocketed XNO for side 0, UNLOCKED XMR for side 1); if that
  // is below the certifiable minimum, refuse (UNFUNDED) and withdraw anything resting.
  const funding = fundedSize(side, parseFloat(size), rep_wallet);
  if (!funding.ok) {
    const st = agentState();
    const withdrew = st.offer && live ? xnoxmr(["offer", "withdraw", "--side", String(st.offer.side), "--live"]).json : null;
    const rep = { ok: true, cycle: seq, verdict: "UNFUNDED", live, side, size_xno: parseFloat(size), funding, withdrew,
      actions: [`NOT posting: ${funding.reason}`, ...(withdrew ? ["withdrew resting offer (unfunded)"] : [])], offer: null, handoff: null, settled: null,
      wallet: rep_wallet && { xno: rep_wallet.nano && rep_wallet.nano.balance_xno, xmr_spendable: rep_wallet.xmr && rep_wallet.xmr.spendable, xmr_total: rep_wallet.xmr && rep_wallet.xmr.total } };
    journalAppend(Object.assign({ cmd: "cycle" }, rep));
    rep.push = await pushSnapshot({ last_cycle: slimCycle(rep) });
    return out(rep);
  }
  // Side 1: declare to the skill exactly the XMR we verified as unlocked (its --xmr honesty guard caps to it).
  const wpid = watcherAlive();
  const tickArgs = wpid ? ["status"] : ["tick", "--side", String(side), "--size", String(funding.size), ...(side === 1 ? ["--xmr", String(funding.available)] : []), ...(live ? ["--live"] : [])];
  const r = xnoxmr(tickArgs);
  if (wpid && r.json) {   // the realtime watcher owns the market loop; this cycle just reads its state for the books
    const st = r.json;
    r.json = { ok: st.ok !== false, verdict: st.hasOffer ? "WATCHING" : "WATCHING_NO_OFFER", actions: [st.hasOffer ? `watcher pid ${wpid}: resting ${st.sizeXno} XNO @ ${Number(st.ask).toFixed(9)} · ${st.verdict || "?"}${st.reason ? " (" + st.reason + ")" : ""} · age ${st.ageSeconds}s` : `watcher pid ${wpid}: no offer resting${st.reason ? " (" + st.reason + ")" : ""}`],
      offer: st.hasOffer ? { block: st.block, ask: st.ask, sizeXno: st.sizeXno, ageSeconds: st.ageSeconds } : null, handoff: st.handoff || null, settled: null, watcher: { pid: wpid, log: WATCH_LOG } };
  }
  const j = r.json;
  const okTick = !!(j && j.ok);
  const rep = {
    ok: okTick, cycle: seq, live, side, size_xno: parseFloat(size),
    verdict: j ? j.verdict : (r.timedOut ? "TIMEOUT" : "ERROR"),
    actions: j ? j.actions : null,
    offer: j ? j.offer : null,
    handoff: j ? j.handoff : null,
    settled: j ? j.settled : null,
    autosettle: CONFIG.autosettle,
    funding,
    wallet: rep_wallet && { ok: rep_wallet.ok, xno: rep_wallet.nano && rep_wallet.nano.balance_xno, pocketed_xno: rep_wallet.nano && rep_wallet.nano.pocketed_xno,
      xmr_total: rep_wallet.xmr && rep_wallet.xmr.total, xmr_spendable: rep_wallet.xmr && rep_wallet.xmr.spendable, xmr_caught_up: rep_wallet.xmr && rep_wallet.xmr.caught_up, error: rep_wallet.error || (rep_wallet.nano && rep_wallet.nano.error) || (rep_wallet.xmr && rep_wallet.xmr.error) },
    durationMs: r.durationMs,
    error: okTick ? undefined : (j && j.error) || (r.timedOut ? "tick timed out" : ("tick exit " + r.code + " " + r.stderr.slice(-300))),
  };
  journalAppend(Object.assign({ cmd: "cycle" }, rep));
  rep.auto_feedback = await autoFeedback("tick", tickArgs, r);
  if (!rep.auto_feedback) delete rep.auto_feedback;

  // A certified take: the one event that needs a human. Alert once per (block, slot).
  if (rep.handoff) {
    const key = rep.handoff.block + ":" + rep.handoff.slot;
    const a = alertsLoad();
    if (!a.sent[key]) {
      a.sent[key] = { at: nowIso(), deal: rep.handoff.deal };
      alertsSave(a);
      rep.alert = notify(handoffText(rep.handoff, live));
      journalAppend({ cmd: "handoff", ok: true, key, deal: rep.handoff.deal, certificate: slim(rep.handoff.certificate), alert: rep.alert });
    } else rep.alert = { delivered: false, via: "already alerted at " + a.sent[key].at };
    rep.human_action_required = handoffText(rep.handoff, live);
  }
  if (rep.settled) {
    journalAppend({ cmd: "settled", ok: true, realized: rep.settled.realized, handoff: rep.handoff && { block: rep.handoff.block, slot: rep.handoff.slot } });
    notify("CASHIR: swap SETTLED autonomously. realized: " + JSON.stringify(rep.settled.realized));
  }
  rep.push = await pushSnapshot({ last_cycle: slimCycle(rep) });
  out(rep);
  if (!okTick) process.exit(1);
};
function slimCycle(rep) {
  const c = Object.assign({}, rep); delete c.push;
  if (c.handoff) c.handoff = Object.assign({}, c.handoff, { certificate: c.handoff.certificate && { netBps: c.handoff.certificate.netBps, mid: c.handoff.certificate.mid, sources: c.handoff.certificate.sources } });
  return c;
}

// USD prices (CoinGecko, no key), cached 5 min in state/usd.json. Best effort; balances work without it.
const USD_FILE = path.join(STATE_DIR, "usd.json");
function usdRead() { try { const j = JSON.parse(fs.readFileSync(USD_FILE, "utf8")); return j; } catch (e) { return null; } }
async function usdRefresh() {
  const cur = usdRead();
  if (cur && Date.now() - Date.parse(cur.at) < 5 * 60e3) return cur;
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=monero,nano&vs_currencies=usd", { signal: c.signal, headers: { accept: "application/json" } });
    const j = await r.json();
    if (j && j.monero && j.nano) { const o = { at: nowIso(), xmr_usd: j.monero.usd, xno_usd: j.nano.usd, source: "coingecko" }; ensureState(); fs.writeFileSync(USD_FILE, JSON.stringify(o)); return o; }
  } catch (e) {} finally { clearTimeout(t); }
  return cur;
}

// balances: wallet + liquidity committed on the book + grand total at the last known mid.
function balances(w, offer, cycles) {
  const xno = w && w.nano ? Number(w.nano.balance_xno || 0) : null;
  const xmrTotal = w && w.xmr && w.xmr.total != null ? Number(w.xmr.total) : null;
  const xmrSpendable = w && w.xmr && w.xmr.spendable != null ? Number(w.xmr.spendable) : null;
  let mid = null;
  for (let i = cycles.length - 1; i >= 0 && !mid; i--) { const f = cycles[i].funding; if (f && f.mid) mid = f.mid; }
  if (!mid && offer && offer.ask) mid = Number(offer.ask);
  const liqXno = offer && offer.side === 0 ? Number(offer.sizeXno || 0) : 0;
  const liqXmr = offer && offer.side === 1 ? +(Number(offer.sizeXno || 0) * Number(offer.ask || 0)).toFixed(8) : 0;
  const liqXmrAsXno = offer && offer.side === 1 ? Number(offer.sizeXno || 0) : 0;
  const totalXmr = xno != null && xmrTotal != null && mid ? +(xmrTotal + xno * mid).toFixed(8) : null;
  return { xno, xmr_total: xmrTotal, xmr_spendable: xmrSpendable, xmr_unlocking: xmrTotal != null && xmrSpendable != null ? +(xmrTotal - xmrSpendable).toFixed(8) : null,
    liquidity_xno: liqXno, liquidity_xmr: liqXmr, liquidity_xmr_in_xno: liqXmrAsXno,
    free_xno: xno != null ? +(xno - liqXno).toFixed(6) : null, free_xmr: xmrSpendable != null ? +(xmrSpendable - liqXmr).toFixed(8) : null,
    mid_xmr_per_xno: mid, total_in_xmr: totalXmr, total_in_xno: totalXmr != null && mid ? +(totalXmr / mid).toFixed(6) : null,
    usd: usdBlock(xno, xmrTotal, liqXno, liqXmr),
    as_of: w ? w.at : null };
}
function usdBlock(xno, xmr, liqXno, liqXmr) {
  const p = usdRead(); if (!p) return null;
  const xnoUsd = xno != null ? +(xno * p.xno_usd).toFixed(2) : null, xmrUsd = xmr != null ? +(xmr * p.xmr_usd).toFixed(2) : null;
  return { xno_price: p.xno_usd, xmr_price: p.xmr_usd, xno_value: xnoUsd, xmr_value: xmrUsd,
    liquidity_xno_value: +(liqXno * p.xno_usd).toFixed(2), liquidity_xmr_value: +(liqXmr * p.xmr_usd).toFixed(2),
    total: xnoUsd != null && xmrUsd != null ? +(xnoUsd + xmrUsd).toFixed(2) : null, prices_at: p.at, source: p.source };
}

// report: the cashier's books over a period.
function buildReport(period) {
  try { reconcileSessions(); } catch (e) {}
  const ms = parsePeriod(period);
  const rows = journalRead(ms);
  const cycles = rows.filter(e => e.cmd === "cycle");
  const verdicts = {};
  const counts = { posted: 0, withdrew: 0, repriced: 0, declined: 0, held: 0, handoffs: 0, settled: 0, errors: 0, paused: 0, dry_would_post: 0 };
  let netBpsSum = 0, netBpsN = 0, totalMs = 0;
  for (const c of cycles) {
    verdicts[c.verdict || "?"] = (verdicts[c.verdict || "?"] || 0) + 1;
    totalMs += c.durationMs || 0;
    if (c.ok === false) counts.errors++;
    if (c.verdict === "PAUSED") counts.paused++;
    if (c.verdict === "REPRICE" || c.verdict === "REPOST") counts.repriced++;
    if (c.verdict === "HOLD") counts.held++;
    for (const a of c.actions || []) {
      if (/^posted /.test(a)) { counts.posted++; const m = a.match(/net (-?\d+) bps/); if (m) { netBpsSum += +m[1]; netBpsN++; } }
      if (/^withdrew /.test(a)) counts.withdrew++;
      if (/^declining /.test(a)) counts.declined++;
      if (/^DRY: would post/.test(a)) counts.dry_would_post++;
    }
  }
  const handoffs = rows.filter(e => e.cmd === "handoff");
  const swaps = rows.filter(e => e.cmd === "swap");
  const settled = rows.filter(e => e.cmd === "settled").concat(swaps.filter(e => e.outcome === "settled"));
  const recovered = swaps.filter(e => e.outcome === "recovered" || e.outcome === "refunded");
  counts.handoffs = handoffs.length; counts.settled = settled.length;
  let realizedXmr = 0;
  for (const s of settled) { const r = s.realized; if (r && r.netAtomic != null) realizedXmr += Number(BigInt(r.netAtomic)) / 1e12; else if (r && typeof r.netXmr === "number") realizedXmr += r.netXmr; }
  const last = cycles[cycles.length - 1] || null;
  const lastWallet = rows.filter(e => e.cmd === "wallet" && e.ok).pop() || null;
  const st = agentState();
  const offer = st.offer ? { block: st.offer.block, side: st.offer.side, sizeXno: st.offer.sizeXno, ask: st.offer.ask, spread_bps: st.offer.bps,
    certified_net_bps: st.offer.cert && st.offer.cert.netBps, ageSeconds: Math.round((Date.now() - st.offer.at) / 1000), ttlSeconds: 600 } : null;
  const alerts = alertsLoad();
  const pending = Object.entries(alerts.sent || {}).filter(([k]) => !settled.some(s => s.handoff && (s.handoff.block + ":" + s.handoff.slot) === k))
    .map(([k, v]) => ({ key: k, at: v.at, deal: v.deal }));
  return {
    ok: true, period, generated_at: nowIso(), version: VERSION, live: CONFIG.live, side: CONFIG.side, paused: fs.existsSync(PAUSE_FILE),
    cycles: { total: cycles.length, ok: cycles.filter(c => c.ok).length, errors: counts.errors, uptime_pct: cycles.length ? +((100 * (cycles.length - counts.errors)) / cycles.length).toFixed(1) : null,
              avg_seconds: cycles.length ? +(totalMs / cycles.length / 1000).toFixed(1) : null, verdicts },
    activity: counts,
    pricing: { avg_certified_net_bps_at_post: netBpsN ? +(netBpsSum / netBpsN).toFixed(1) : null, offer_size_xno: CONFIG.sizeXno },
    resting_offer: offer,
    wallet: lastWallet && { at: lastWallet.at, xno: lastWallet.nano && lastWallet.nano.balance_xno, xmr_total: lastWallet.xmr && lastWallet.xmr.total, xmr_spendable: lastWallet.xmr && lastWallet.xmr.spendable,
      xmr_caught_up: lastWallet.xmr && lastWallet.xmr.caught_up, pocketed_xno_24h: +rows.filter(e => e.cmd === "wallet" && e.nano && e.nano.pocketed_xno).reduce((n, e) => n + e.nano.pocketed_xno, 0).toFixed(6), xmr_behind: lastWallet.xmr && lastWallet.xmr.blocks_behind },
    balances: balances(lastWallet, st.offer, cycles),
    handoffs_pending_human: pending,
    realized: { settled_swaps: settled.length, net_xmr: +realizedXmr.toFixed(8), net_usd: (function(){ const u = usdRead(); return u && u.xmr_usd ? +(realizedXmr * u.xmr_usd).toFixed(2) : null; })(), recovered_swaps: recovered.length,
                note: settled.length ? undefined : (recovered.length ? recovered.length + " swap(s) locked but unwound to a safe refund/recovery — none completed" : "no completed swaps in period") },
    last_cycle: last && { at: last.at, verdict: last.verdict, actions: last.actions, error: last.error },
  };
}
// loopStatus: which maker loops are up, and each side's resting offer.
function svcActive(u) { try { return execFileSync("systemctl", ["is-active", u], { encoding: "utf8" }).trim(); } catch (e) { return ((e.stdout || "") + "").trim() || "inactive"; } }
function sideOffer(stateFile) { try { const st = JSON.parse(fs.readFileSync(stateFile, "utf8")); if (!st.offer) return null; return { block: String(st.offer.block || "").slice(0, 12), sizeXno: st.offer.sizeXno, ask: st.offer.ask, ageSeconds: Math.round((Date.now() - st.offer.at) / 1000) }; } catch (e) { return null; } }
function loopStatus() {
  return {
    checked_at: nowIso(),
    side1: { unit: "cashir-watch", label: "sell XMR → XNO", active: svcActive("cashir-watch"), offer: sideOffer(path.join(STATE_DIR, "agent.json")) },
    side0: { unit: "cashir-watch0", label: "sell XNO → XMR", active: svcActive("cashir-watch0"), offer: sideOffer(path.join(STATE_DIR, "s0", "agent.json")) },
  };
}

// push: send the books (never secrets) to an HTTPS endpoint you own. Outbound only —
// the cashier opens no inbound port; the world sees only what it chose to publish.
// Wallet freshness: the books are built from the last journaled wallet sync. The
// watcher only syncs on (re)start, so a push would otherwise show balances up to an
// hour old. Re-sync (pocketing any new receivable XNO) if the last one is stale.
function walletFresh(maxAgeMs) {
  const rows = journalRead(24 * 3600e3).filter(e => e.cmd === "wallet" && e.ok);
  const last = rows[rows.length - 1];
  const age = last ? Date.now() - Date.parse(last.at) : Infinity;
  if (age < maxAgeMs) return { synced: false, age_s: Math.round(age / 1000) };
  const j = walletSync();
  return { synced: true, ok: !!j.ok, error: j.error, pocketed_xno: j.nano && j.nano.pocketed_xno };
}
async function pushSnapshot(extra) {
  if (!CONFIG.pushUrl || !CONFIG.pushToken) return { pushed: false, reason: "CASHIR_PUSH_URL/CASHIR_PUSH_TOKEN not set" };
  if (!/^https:\/\//i.test(CONFIG.pushUrl)) return { pushed: false, reason: "CASHIR_PUSH_URL must be https (refusing to send the token over cleartext)" };
  const wallet_refresh = walletFresh(parseInt(cfg("CASHIR_PUSH_WALLET_MAX_AGE_MS", "60000"), 10));
  await usdRefresh();
  const snap = Object.assign({
    version: VERSION, pushed_at: nowIso(),
    config: { side: CONFIG.side, sizeXno: CONFIG.sizeXno, interval: CONFIG.interval, live: CONFIG.live, autosettle: CONFIG.autosettle },
    report_24h: buildReport("24h"), report_7d: buildReport("7d"),
    ledger_tail: journalRead(24 * 3600e3).slice(-60),
    loops: loopStatus(),
    rate: { spread_mult: CONFIG.spreadMult, spread_pct: +((CONFIG.spreadMult - 1) * 100).toFixed(0) },
    code: (function(){ let commit = null; try { commit = fs.readFileSync(path.join(ROOT, "COMMIT"), "utf8").trim().slice(0, 40) || null; } catch (e) {} return { repo: "dhyabi2/AtomicSwapCashier", branch: "main", commit }; })(),
    feedback_tail: feedbackRead().slice(-20).map(f => ({ id: f.id, at: f.at, kind: f.kind, severity: f.severity, component: f.component, title: f.title, count: f.count, auto: f.auto })),
    wallet_refresh,
  }, extra || {});
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
  try {
    const r = await fetch(CONFIG.pushUrl.replace(/\/$/, "") + "/api/push", { method: "POST", signal: c.signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + CONFIG.pushToken }, body: redact(JSON.stringify(snap)) });
    const j = await r.json().catch(() => ({}));
    return { pushed: r.ok, status: r.status, stored: j.stored };
  } catch (e) { return { pushed: false, error: String(e.message || e).slice(0, 120) }; }
  finally { clearTimeout(t); }
}
CMDS.push = async (args) => {
  const r = await pushSnapshot(args.note ? { note: args.note } : null);
  journalAppend({ cmd: "push", ok: !!r.pushed, result: r });
  out(Object.assign({ ok: !!r.pushed }, r)); if (!r.pushed) process.exit(1);
};

// feedback: file a bug / observation about NearInstant for its developers.
CMDS.feedback = async (args) => {
  if (args.clear) {   // local box only; the app has its own Clear button (archive kept server-side)
    const n = feedbackRead().length; ensureState();
    if (n) fs.renameSync(FEEDBACK, FEEDBACK + "." + nowIso().replace(/[:.]/g, "-") + ".bak");
    return out({ ok: true, cleared: n });
  }
  if (args.resend) {   // re-push every local item (server keys by id, so this is idempotent)
    const res = [];
    const all = feedbackRead().map(scrubItem);
    fs.writeFileSync(FEEDBACK, all.map(x => JSON.stringify(x)).join("\n") + (all.length ? "\n" : ""));
    for (const f of all) {
      if (!CONFIG.pushUrl || !CONFIG.pushToken) return die("CASHIR_PUSH_URL/CASHIR_PUSH_TOKEN not set");
      try { const r = await fetch(CONFIG.pushUrl.replace(/\/$/, "") + "/api/feedback", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + CONFIG.pushToken }, body: JSON.stringify(f) });
        res.push({ id: f.id, status: r.status }); } catch (e) { res.push({ id: f.id, error: String(e.message || e).slice(0, 80) }); }
    }
    return out({ ok: true, resent: res });
  }
  if (args.list) return out({ ok: true, count: feedbackRead().length, items: feedbackRead().slice(-parseInt(args.list === true ? "50" : args.list, 10)).map(f => Object.assign({}, f, { context: undefined })) });
  if (!args.title) return die("feedback needs --title \"one line\" (and ideally --detail, --repro, --expected, --kind bug|ux|docs|idea|question, --severity low|medium|high|critical, --component nodes|monero-nodes|pow|oracle|relay|wasm|web|skill|docs|other)");
  const r = await recordFeedback({ source: args.source || "hermes", kind: args.kind, severity: args.severity, component: args.component,
    title: args.title, detail: args.detail, repro: args.repro, expected: args.expected });
  out(Object.assign({ ok: true }, r));
};

// watch: the realtime maker (skill `watch` = tick + Nano websocket). Persistent; restart-loop
// re-checks funding on every (re)start so --xmr always reflects verified unlocked XMR.
CMDS.watch = async (args) => {
  ensureState();
  if (!CONFIG.live && !liveFlag(args.live)) return die("watch is live-only: set CASHIR_LIVE=1 (or --live)");
  const side = args.side != null ? (String(args.side) === "0" ? 0 : 1) : CONFIG.side;
  const pidFile = path.join(STATE_DIR, `watch-s${side}.pid`);
  const logFile = path.join(STATE_DIR, `watch-s${side}.log`);
  if (watcherAlive(side)) return die("a side-" + side + " watcher is already running", { pid: watcherAlive(side) });
  const { spawn } = require("child_process");
  const logf = fs.openSync(logFile, "a");
  const wlog = (m) => fs.writeSync(logf, `[cashir ${nowIso()}] ${m}\n`);
  fs.writeFileSync(pidFile, String(process.pid));
  process.on("SIGTERM", () => { wlog("SIGTERM: stopping"); try { if (child) child.kill("SIGTERM"); } catch (e) {} try { fs.unlinkSync(pidFile); } catch (e) {} process.exit(0); });
  let child = null;
  for (;;) {
    if (fs.existsSync(PAUSE_FILE)) { wlog("paused — not running the watcher; retry in 60s"); await new Promise(r => setTimeout(r, 60000)); continue; }
    const w = walletSync();
    const funding = fundedSize(side, CONFIG.sizeXno, w);
    journalAppend({ cmd: "watch", ok: !!funding.ok, funding, watcher: "start" });
    if (!funding.ok) { wlog("UNFUNDED: " + funding.reason + " — retry in 120s"); await new Promise(r => setTimeout(r, 120000)); continue; }
    let sigmaArg = [];
    if (CONFIG.spreadMult !== 1) {   // widen/tighten the volatility spread by the operator's rate multiplier
      try { const q = xnoxmr(["quote", "--side", String(side)]).json; const sd = q && Number(q.sigma_daily); if (sd > 0) sigmaArg = ["--sigma", (sd * CONFIG.spreadMult).toFixed(4)]; } catch (e) {}
    }
    const a = ["watch", "--side", String(side), "--size", String(funding.size), ...(side === 1 ? ["--xmr", String(funding.available)] : []), ...sigmaArg, "--live"];
    wlog("starting xnoxmr " + a.join(" "));
    child = spawn(process.execPath, [XNOXMR, ...a], { env: childEnv(), cwd: VENDOR, stdio: ["ignore", logf, logf] });
    const maxRunMs = parseInt(cfg("CASHIR_WATCH_MAX_RUN_MS", String(60 * 60e3)), 10);   // periodic restart => funding re-check
    const code = await new Promise(res => { const t = setTimeout(() => { wlog("hourly restart to refresh funding"); child.kill("SIGTERM"); }, maxRunMs); child.on("exit", c => { clearTimeout(t); res(c); }); });
    wlog("watcher exited with " + code + "; restarting in 5s");
    journalAppend({ cmd: "watch", ok: code === 0, watcher: "exit", code });
    await new Promise(r => setTimeout(r, 5000));
  }
};

CMDS.reconcile = async () => out(Object.assign({ ok: true }, reconcileSessions()));
CMDS.wallet = async () => { const j = walletSync(); out(j); if (!j.ok) process.exit(1); };
CMDS.report = async (args) => out(buildReport(args.period || "24h"));
CMDS.ledger = async (args) => {
  const n = parseInt(args.tail || "50", 10);
  const rows = journalRead(args.period ? parsePeriod(args.period) : 0);
  out({ ok: true, count: rows.length, entries: rows.slice(-n) });
};

// A compact, human-readable line for chat delivery (Hermes/Telegram).
CMDS.brief = async (args) => {
  const r = buildReport(args.period || "24h");
  const o = r.resting_offer;
  const lines = [
    `Cashir ${r.live ? "LIVE" : "DRY"} side ${r.side} · ${r.period}: ${r.cycles.total} cycles, ${r.cycles.uptime_pct == null ? "-" : r.cycles.uptime_pct + "%"} ok${r.paused ? " · PAUSED" : ""}`,
    `posted ${r.activity.posted} · repriced ${r.activity.repriced} · withdrew ${r.activity.withdrew} · declined ${r.activity.declined} · handoffs ${r.activity.handoffs} · settled ${r.activity.settled}`,
    o ? `resting: ${o.sizeXno} XNO @ ${Number(o.ask).toFixed(9)} (${o.spread_bps} bps, net ${o.certified_net_bps} bps, age ${o.ageSeconds}s)` : "resting: none",
    `realized: ${r.realized.net_xmr} XMR over ${r.realized.settled_swaps} swaps`,
  ];
  if (r.handoffs_pending_human.length) lines.push(`!! ${r.handoffs_pending_human.length} certified take(s) waiting for a human to settle`);
  if (r.last_cycle) lines.push(`last: ${r.last_cycle.verdict}${r.last_cycle.error ? " — " + r.last_cycle.error : ""}`);
  console.log(lines.join("\n"));
};

// Install the Hermes cron job that runs this cashier.
CMDS["install-cron"] = async (args) => {
  const scriptsDir = path.join(process.env.HOME || "~", ".hermes", "scripts");
  const skillsDir = path.join(process.env.HOME || "~", ".hermes", "skills", "trading", "cashir");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  // 1. the script cron runs each tick (its stdout is injected into the agent prompt)
  const script = path.join(scriptsDir, "cashir_cycle.sh");
  fs.writeFileSync(script, fs.readFileSync(path.join(ROOT, "hermes", "scripts", "cashir_cycle.sh"), "utf8").replace(/__CASHIR_ROOT__/g, ROOT));
  fs.chmodSync(script, 0o755);
  // 2. the skill (so Hermes knows the rules and the vocabulary)
  for (const f of ["SKILL.md"]) fs.copyFileSync(path.join(ROOT, "hermes", f), path.join(skillsDir, f));
  fs.mkdirSync(path.join(skillsDir, "references"), { recursive: true });
  const certRef = path.join(VENDOR, "integrations", "hermes", "references", "certify-profit.md");
  if (fs.existsSync(certRef)) fs.copyFileSync(certRef, path.join(skillsDir, "references", "certify-profit.md"));
  // 3. the cron job
  const prompt = fs.readFileSync(path.join(ROOT, "hermes", "cron_prompt.md"), "utf8").trim();
  const cronArgs = ["cron", "create", "--name", "cashir-cycle", "--deliver", CONFIG.deliver, "--skill", "cashir",
                    "--script", "cashir_cycle.sh", "--workdir", ROOT, (/^\d+\s*[mh]$/.test(CONFIG.interval) ? "every " + CONFIG.interval : CONFIG.interval), prompt];
  const remove = spawnSync("hermes", ["cron", "list"], { encoding: "utf8" });
  const existing = (remove.stdout || "").match(/([0-9a-f]{12})\s+\[\w+\]\s*\n\s*Name:\s+cashir-cycle/);
  if (existing && !args.keep) spawnSync("hermes", ["cron", "remove", existing[1]], { encoding: "utf8" });
  if (args["dry-run"]) return out({ ok: true, dry_run: true, would_run: ["hermes", ...cronArgs], script, skill: skillsDir });
  const r = spawnSync("hermes", cronArgs, { encoding: "utf8" });
  journalAppend({ cmd: "install-cron", ok: r.status === 0, interval: CONFIG.interval, deliver: CONFIG.deliver });
  out({ ok: r.status === 0, installed: { script, skill: skillsDir, interval: CONFIG.interval, deliver: CONFIG.deliver, workdir: ROOT },
        hermes: (r.stdout || "") + (r.stderr || ""), next: "hermes cron list · hermes cron run <id> · hermes cron status" });
  if (r.status !== 0) process.exit(1);
};

// Local, read-only dashboard over the ledger. Binds to 127.0.0.1 only.
CMDS.dashboard = async (args) => {
  const http = require("http");
  const port = parseInt(args.port || "8787", 10);
  const html = fs.readFileSync(path.join(ROOT, "dashboard", "index.html"), "utf8");
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/report") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(buildReport(u.searchParams.get("period") || "24h"))); }
    if (u.pathname === "/api/ledger") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(journalRead(parsePeriod(u.searchParams.get("period") || "24h")).slice(-300))); }
    if (u.pathname === "/api/config") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ version: VERSION, config: CONFIG, paused: fs.existsSync(PAUSE_FILE) })); }
    res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html);
  });
  srv.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ ok: true, dashboard: `http://127.0.0.1:${port}` })));
};

CMDS.help = async () => out({
  ok: true, version: VERSION,
  commands: {
    cycle: "[--live] [--side 0|1] [--size xno]   ONE cashier cycle: guards -> skill tick -> ledger -> HANDOFF alert. Cron this.",
    report: "[--period 24h|7d|...]   the books: cycles, actions, resting offer, handoffs pending, realized",
    brief: "[--period]   the report as a few chat lines",
    ledger: "[--tail n] [--period]   raw journal entries",
    health: "preflight (nodes, oracles, PoW, wallet)",
    watch: "[--side 0|1]   REALTIME maker (skill watch: tick + Nano websocket, takes accepted in seconds); persistent, funding-guarded, restart loop. Run under systemd.",
    wallet: "pocket receivable XNO and scan the XMR balance (runs automatically at the start of every cycle)",
    quote: "[--side]   the volatility-adaptive quote and minimum viable fill",
    book: "[--side]   the live order book",
    status: "my resting offer re-certified now",
    peek: "read-only: takes on my offer, certified",
    verify: "--xno n [--price_e9 p]   is this deal a certified win now?",
    withdraw: "--live   withdraw my resting offer",
    pause: "[--reason text]   emergency stop (withdraws if live); resume: `cashir resume`",
    "install-cron": "[--dry-run]   install the Hermes skill, script and cron job",
    dashboard: "[--port 8787]   local read-only dashboard",
    push: "[--note text]   push the books to your endpoint (CASHIR_PUSH_URL + CASHIR_PUSH_TOKEN)",
    feedback: "--title t [--detail d] [--repro r] [--expected e] [--kind bug|ux|docs|idea|question] [--severity low|medium|high|critical] [--component nodes|monero-nodes|pow|oracle|relay|wasm|web|skill|docs|other] | --list [n]   file a NearInstant bug/observation for its developers (pushed to the results app feedback box)",
    config: "effective configuration",
  },
});

function slim(o) { if (!o) return o; const c = Object.assign({}, o); delete c.certificate; return c; }
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) { const k = t.slice(2); if (argv[i + 1] && !argv[i + 1].startsWith("--")) a[k] = argv[++i]; else a[k] = true; }
    else a._.push(t);
  }
  return a;
}
if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0] || "help";
    const fn = CMDS[cmd];
    if (!fn) return die("unknown command: " + cmd, { try: Object.keys(CMDS) });
    try { await fn(args); } catch (e) { die(String((e && e.message) || e), { command: cmd }); }
  })();
}
module.exports = { buildReport, parsePeriod, journalRead, journalAppend, handoffText, CONFIG, STATE_DIR };
