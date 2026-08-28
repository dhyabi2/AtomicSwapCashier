# Cashir — the autonomous XNO⇄XMR cashier

> **Status: LIVE (production).** Cashir runs unattended as a
> realtime, two-sided market maker (systemd loops for both sides), accepts takes in
> seconds over the Nano websocket, and has settled real XNO⇄XMR swaps end-to-end on
> mainnet. Autonomous settlement and crash-recovery are proven; a live dashboard
> publishes the books. See **Running it yourself** below.

Cashir is a **cashier that runs one business and nothing else**: it makes a
certified-win market on the trustless Nano⇄Monero DEX
([NearInstant](https://github.com/dhyabi2/NearInstant)) and is operated 100 %
by the [Hermes agent](https://github.com/NousResearch/hermes-agent) on a cron.

It reads the live order book, prices offers with the DEX's volatility-adaptive
spread, posts / reprices / withdraws them every few minutes, certifies every
take at the live market after fees, declines the losers, keeps the books, and
hands each **certified win** to a human to settle. No browser, no babysitting.

Cashir does not re-implement any pricing or protocol code. It vendors
NearInstant and drives its Hermes skill (`xnoxmr.cjs`) — the *same*
`certify()` / `gate()` the web app runs — and adds what a cashier adds:

| Cashir adds | Where |
|---|---|
| A ledger of every cycle, action and certificate | `state/journal.jsonl` |
| P&L / activity reports over any period | `cashir report`, `cashir brief` |
| Fail-closed guards: pause switch, error breaker, unconfigured detection | `cashir cycle` |
| HANDOFF alerts to a human via Hermes messaging (Telegram/Discord/Slack/Signal) | `CASHIR_DELIVER` |
| A local read-only dashboard | `cashir dashboard` |
| One-command Hermes skill + cron install | `cashir install-cron` |
| Unit tests + the vendor's 36-assertion certified-win regression | `npm test` |

## The one rule: certified win, or no action

Before every offer, every accepted take, and every irreversible step, a
certificate is built from the live market and the action is **refused** unless
it is a strictly positive net after the Monero fee. It fails closed on: fewer
than 2 agreeing price sources · a price older than 60 s · a market in motion
(stress ≥ 2) · net below 30 bps (post/accept) · unrealised loss > 50 bps.
The exact contract: [`vendor/NearInstant/docs/CERTIFY-PROFIT.md`](https://github.com/dhyabi2/NearInstant/blob/main/docs/CERTIFY-PROFIT.md).

Hermes is instructed (skill + AGENTS.md + cron prompt) never to route around a
refusal, raise a threshold, touch the seed, or settle. Cashir forces
`XNOXMR_AUTOSETTLE=0` unless you set it yourself.

## Settlement

Cashir settles two ways, and both are proven on mainnet:

- **Autonomous (default in the live deployment).** With `XNOXMR_AUTOSETTLE=1` and
  the realtime watcher running, an accepted take is settled end-to-end by the
  agent — joint-account ceremony, XMR lock, the 10-confirmation wait, and the
  claim — with automatic crash-recovery: if a leg cannot complete, the swap
  unwinds to a refund and any locked XMR is swept back. No funds are stranded.
- **Hand-off (conservative).** With autosettle off, a `HANDOFF` verdict means a
  take certified as a win; Cashir holds the offer and you settle from
  <https://www.nearinstant.xyz>. Use this if you want a human in the loop.

Every irreversible step is still gated by the same `certify()` — settlement
never routes around a refusal. Start on a wallet you can treat as at-risk while
you watch the first live swaps.

## Install

Requirements: Node 20+, git, Rust + `wasm-pack` (to build the wasm engines
once), Hermes agent.

```bash
git clone <this repo> cashir && cd cashir
npm run setup            # vendors NearInstant, builds wasm (few min), runs all tests, writes .env
```

Then edit `.env`:

```
XNOXMR_MAKER_SEED=<64 hex>   # the wallet that holds your XMR (side 1) or XNO (side 0)
CASHIR_SIDE=1                # 1 = sell XMR for XNO (role B)   0 = sell XNO for XMR (role A)
CASHIR_SIZE_XNO=50           # ≥ the fee-driven minimum (~25 XNO today; `cashir quote` prints it)
CASHIR_DELIVER=telegram      # where HANDOFF alerts + cycle reports go (needs Hermes gateway set up)
CASHIR_LIVE=0                # keep 0 (dry run) until health is green and the wallet is funded
```

Fund the maker wallet (`cashir health` prints its Nano address; the XMR side
lives in the same seed's Monero account — open the seed on nearinstant.xyz to
see both), then:

```bash
node bin/cashir.cjs health       # nodes, oracles, PoW, balance — all must be ok
node bin/cashir.cjs quote        # today's spread and minimum fill
node bin/cashir.cjs cycle        # one dry-run cycle: "WOULD_POST 50 XNO at … (net +75 bps)"
```

## Hand it to Hermes

```bash
node bin/cashir.cjs install-cron            # installs skill, script and a `cashir-cycle` job every CASHIR_INTERVAL
hermes cron list                            # see it
hermes cron run <id>                        # force a run now
```

Every run: Hermes executes `cashir cycle`, reads the JSON, and replies with one
line — or, on `HANDOFF`, delivers the full "a human must settle now" message
immediately. Flip `CASHIR_LIVE=1` in `.env` when you are ready for real offers;
no reinstall needed.

## Commands

| Command | Does |
|---|---|
| `cycle [--live] [--side] [--size]` | one cashier cycle: guards → tick → ledger → alert. Idempotent; cron this |
| `report [--period 24h]` · `brief` | the books |
| `ledger [--tail 50]` | raw journal |
| `health` · `quote` · `book` · `status` · `peek` · `verify --xno n` | read-only market / offer views |
| `pause [--reason]` · `resume` | emergency stop (withdraws the resting offer when live) |
| `withdraw --live` | withdraw by hand |
| `dashboard [--port 8787]` | http://127.0.0.1:8787 |
| `install-cron [--dry-run]` | Hermes integration |
| `config` | effective settings |

Cycle verdicts: `HOLD` `POSTED` `REPRICE` `REPOST` `WITHDRAW` `WOULD_POST` (dry)
`HANDOFF` (human!) `PAUSED` `UNCONFIGURED` `BREAKER` `ERROR` `TIMEOUT`
`SETTLING`/`SETTLED` (autosettle only).

## Guards

- **Pause switch** — `state/PAUSED`: cycles withdraw and refuse until `resume`.
- **Breaker** — `CASHIR_MAX_CONSECUTIVE_ERRORS` (3) failed cycles ⇒ withdraw,
  pause, alert. A human resumes.
- **Lock** — the vendor tick holds a lock file; overlapping crons are refused.
- **Isolation** — all state (`agent.json`, `pricehist.json`, wallet cache) is
  under `state/` (mode 700), never in the vendor checkout; `.env` is 600.
- **Seed hygiene** — read by the CLI, passed by env to the child, never printed.

## Economics, honestly

With no counterparty a maker earns nothing. The book today holds 0–3 offers.
At a 30–120 bps spread on a 50 XNO fill you earn cents per swap. Certification
makes each fill *safe*; it does not create demand. Watch `handoffs` in the
report — each one is a certified win waiting for you to settle.

## Running it yourself

Cashir is plain Node: `npm run setup` fetches and builds the DEX, `cashir cycle`
runs one tick, `cashir watch` runs the realtime maker loop, and `cashir dashboard`
serves a local dashboard on `127.0.0.1` only. Run the loops under whatever process
supervisor you already use (systemd, pm2, a container) on a machine with **no inbound
application ports** — the cashier never listens for connections.

Optionally, `cashir push` (or `CASHIR_PUSH_URL` + `CASHIR_PUSH_TOKEN`) POSTs the
books — never secrets — to any HTTPS endpoint you own, so you can publish them
wherever you like. Nothing is ever pulled from that endpoint; the wire is
outbound-only. How you host that endpoint is up to you and is out of scope here.

## Layout

```
bin/cashir.cjs          the cashier CLI (ledger, report, guards, alerts, cron installer, dashboard, push)
hermes/SKILL.md         the Hermes skill (rules + verdict table)
hermes/cron_prompt.md   what Hermes is told each run
hermes/scripts/cashir_cycle.sh
dashboard/index.html
test/cashir_test.cjs
scripts/setup.sh
vendor/NearInstant/     the DEX (git-ignored; `npm run setup` fetches and builds it)
state/                  ledger + agent state (git-ignored)
AGENTS.md               "this directory is one business" — injected into Hermes' context
```

MIT.
