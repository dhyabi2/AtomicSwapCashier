# Cashir — agent rules for this directory

This directory is one business: the Cashir cashier, a certified-win XNO⇄XMR market maker.
- Use only `node bin/cashir.cjs <command>` (see hermes/SKILL.md). Never call vendor scripts directly with --live.
- Never settle a swap. A `HANDOFF` is for a human at https://www.nearinstant.xyz.
- Never bypass a REFUSE, raise a threshold, edit `.env`, print or ask for the seed.
- Never set `XNOXMR_AUTOSETTLE`; the operator decides that.
- Do not add other businesses, tokens, exchanges, or side projects here.
