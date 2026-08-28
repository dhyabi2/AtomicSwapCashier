#!/usr/bin/env node
// Wallet sync: pocket any receivable XNO and scan the XMR balance with the
// skill's own headless wallet (vendor/NearInstant/web/headless_wallet.js).
// Run by `cashir cycle` (every cron tick) and `cashir wallet`. Prints one JSON.
"use strict";
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "vendor", "NearInstant");
const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const seed = env("XNOXMR_MAKER_SEED", env("WALLET_A_SEED", ""));
const out = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
if (!/^[0-9a-fA-F]{64}$/.test(seed)) out({ ok: false, error: "no maker seed" });
const wasm = require(path.join(ROOT, "swap-core/wasm-bridge/pkg-node/wasm_bridge.js"));
const XMR = require(path.join(ROOT, "swap-core/wasm-monero/pkg-node/wasm_monero.js"));
const B = require(path.join(ROOT, "web/beacon.js"));
const HW = require(path.join(ROOT, "web/headless_wallet.js"));
const urls = env("XNOXMR_NANO_NODES", "https://rpc.nano-gpt.com,https://rainstorm.city/api,https://node.somenano.com/proxy").split(",");
const moneroNodes = env("XNOXMR_MONERO_NODES", "https://xmr.hexide.com:443,https://node.sethforprivacy.com:443,https://xmr-node.cakewallet.com:18081").split(",").map((s) => s.trim()).filter(Boolean);
const beacon = B.makeBeacon(wasm, { workUrl: env("XNOXMR_WORK_URL", "https://www.nearinstant.xyz") });
const w = HW.makeHeadlessWallet({ wasm, xmr: XMR, beacon, urls, moneroNodes, seedHex: seed, stateDir: env("XNOXMR_STATE_DIR", path.join(ROOT, ".xnoxmr-wallet")), network: "mainnet" });
const fmtXno = (raw) => Number(BigInt(String(raw)) / (10n ** 24n)) / 1e6;
const budget = parseInt(env("CASHIR_WALLET_TIMEOUT_MS", "60000"), 10);
const partial = { ok: true, at: new Date().toISOString(), nano: {}, xmr: {}, log: [] };
const timer = setTimeout(() => out(Object.assign({}, partial, { xmr: Object.assign({ scanning: true, note: "XMR scan still catching up; continues next cycle" }, partial.xmr), log: partial.log.slice(-3) })), budget);
(async () => {
  const r = partial; const log = partial.log;
  try {
    const rc = await w.receive((m) => log.push(m));
    const pocketedXno = fmtXno(rc.pocketed || 0);
    r.nano = { address: w.address(), balance_xno: fmtXno(rc.balance), pocketed_xno: pocketedXno, pocketed_count: pocketedXno > 0 ? 1 : 0 };
  } catch (e) { r.ok = false; r.nano.error = String(e.message || e).slice(0, 200); }
  try {
    const b = await w.xmrRefresh((m) => log.push(m), { maxChunks: parseInt(env("CASHIR_XMR_CHUNKS", "25"), 10) });
    r.xmr = { address: await w.xmrAddress(), total: b.total, spendable: b.spendable, unlocking: !!b.pending, tip: b.tip, scanned_to: b.state && b.state.scannedTo, caught_up: b.caughtUp, blocks_behind: b.behind, outputs: b.state ? b.state.outputs.length : 0 };
  } catch (e) { r.ok = false; r.xmr.error = String(e.message || e).slice(0, 200); }
  r.log = log.slice(-6);
  clearTimeout(timer); out(r);
})().catch((e) => { clearTimeout(timer); out({ ok: false, error: String(e.message || e) }); });
