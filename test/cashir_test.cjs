// Cashir unit tests: ledger, report and guard logic against synthetic tick
// outputs. No network, no wallet. The pricing/certification itself is tested
// by vendor/NearInstant/web/profit_gates.cjs (35 assertions).
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const { spawnSync } = require("child_process");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cashir-test-"));
process.env.CASHIR_STATE_DIR = tmp;
const C = require("../bin/cashir.cjs");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("  PASS " + m)) : (fail++, console.log("  FAIL " + m)); };

console.log("1. period parsing");
ok(C.parsePeriod("24h") === 86400e3, "24h");
ok(C.parsePeriod("7d") === 7 * 86400e3, "7d");
ok(C.parsePeriod("garbage") === 86400e3, "invalid falls back to 24h");

console.log("2. ledger + report over synthetic cycles");
const cyc = (o) => C.journalAppend(Object.assign({ cmd: "cycle", ok: true, live: true, durationMs: 4000 }, o));
cyc({ verdict: "POSTED", actions: ["no offer resting", "posted 50 XNO at 0.000912000 (88 bps, net 61 bps) abc1234567"] });
cyc({ verdict: "HOLD", actions: ["HOLD: certified, net 60 bps"] });
cyc({ verdict: "REPRICE", actions: ["REPRICE: mid drifted 0.30%", "withdrew abc1234567", "posted 50 XNO at 0.000915000 (90 bps, net 63 bps) def1234567"] });
cyc({ verdict: "HANDOFF", actions: ["CERTIFIED TAKE on slot 2: net 70 bps - HAND OFF (autosettle off)", "declining slot 3: below threshold", "holding the offer for the human settling the certified take"],
      handoff: { block: "def1234567", slot: 2, deal: { xnoRaw: (50n * 10n ** 30n).toString(), xmrAtomic: "45750000000", priceE9: 915000 }, certificate: { netBps: 70, netAtomic: "32000000", mid: 0.00092, sources: 2 } } });
C.journalAppend({ cmd: "handoff", ok: true, key: "def1234567:2", deal: {} });
cyc({ ok: false, verdict: "ERROR", error: "tick exit 1" });
const r = C.buildReport("1h");
ok(r.cycles.total === 5, "5 cycles counted");
ok(r.cycles.errors === 1 && r.cycles.uptime_pct === 80, "1 error -> 80% uptime");
ok(r.activity.posted === 2, "2 posts parsed from actions");
ok(r.activity.withdrew === 1, "1 withdraw parsed");
ok(r.activity.declined === 1, "1 decline parsed");
ok(r.activity.repriced === 1, "1 reprice");
ok(r.activity.handoffs === 1, "1 handoff journaled");
ok(r.pricing.avg_certified_net_bps_at_post === 62, "avg net bps at post = (61+63)/2");
ok(r.realized.settled_swaps === 0 && r.realized.net_xmr === 0, "nothing realized until a swap settles");
ok(r.last_cycle.verdict === "ERROR", "last cycle surfaced");

console.log("3. handoff text is complete and honest");
const t = C.handoffText({ block: "def1234567", slot: 2, deal: { xnoRaw: (50n * 10n ** 30n).toString(), xmrAtomic: "45750000000", priceE9: 915000 },
  certificate: { netBps: 70, netAtomic: "32000000", mid: 0.00092, sources: 2 } }, true);
ok(/slot 2/.test(t) && /50\.000000 XNO/.test(t) && /0\.04575000 XMR/.test(t) && /70 bps/.test(t) && /nearinstant\.xyz/.test(t), "block, slot, amounts, net, where to settle");

console.log("4. guards: pause switch refuses a cycle without touching the skill");
fs.writeFileSync(path.join(tmp, "PAUSED"), JSON.stringify({ at: new Date().toISOString(), reason: "test" }));
const p = spawnSync(process.execPath, [path.join(__dirname, "../bin/cashir.cjs"), "cycle"], { env: Object.assign({}, process.env, { CASHIR_STATE_DIR: tmp, CASHIR_LIVE: "0", XNOXMR_MAKER_SEED: "ab".repeat(32) }), encoding: "utf8" });
const pj = JSON.parse(p.stdout);
ok(pj.verdict === "PAUSED" && pj.reason === "test", "PAUSED verdict with reason");
fs.unlinkSync(path.join(tmp, "PAUSED"));

console.log("5. guards: breaker trips after N consecutive failures (no live withdraw in dry mode)");
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "cashir-test-"));
for (let i = 0; i < 3; i++) fs.appendFileSync(path.join(tmp2, "journal.jsonl"), JSON.stringify({ at: new Date().toISOString(), cmd: "cycle", ok: false, verdict: "ERROR" }) + "\n");
const b = spawnSync(process.execPath, [path.join(__dirname, "../bin/cashir.cjs"), "cycle"], { env: Object.assign({}, process.env, { CASHIR_STATE_DIR: tmp2, CASHIR_LIVE: "0", XNOXMR_MAKER_SEED: "ab".repeat(32), CASHIR_MAX_CONSECUTIVE_ERRORS: "3", CASHIR_DELIVER: "local" }), encoding: "utf8" });
const bj = JSON.parse(b.stdout);
ok(bj.verdict === "BREAKER" && b.status === 1 && fs.existsSync(path.join(tmp2, "PAUSED")), "BREAKER verdict, exit 1, PAUSED written");

console.log("6. autosettle is forced off unless the operator set it");
ok(C.CONFIG.autosettle === false, "default autosettle=false");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
