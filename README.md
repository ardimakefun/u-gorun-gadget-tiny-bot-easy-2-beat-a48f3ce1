[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/ardimakefun/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/ardimakefun/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

# Tiny Trend Bot — Beat Buy-and-Hold on Solana

A tiny long-only trend-following bot for the make.fun competition
`u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1` (bars-replay/v1, hourly bars,
$10,000 USDC, 7 Solana assets: FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF).

Bounty: https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1

## Strategy

EMA crossover with trend confirmation, stop-loss, take-profit, a 24-bar
time exit and level re-entry — one position per asset, fixed fractional sizing:

- **Indicators:** per symbol, EMA(8) and EMA(21) of hourly closes, seeded as
  the mean of the first `span` closes, then the standard `2/(span+1)` recursion.
- **Buy (cross):** EMA(8) crosses above EMA(21) **and** the close is above EMA(21)
  (price confirms the uptrend). One buy per cross, no re-buy while holding.
- **Buy (level entry, no cross needed):** when flat, EMA(8) is already above
  EMA(21) and the close is above EMA(21), the bot buys if the symbol has never
  traded in this run, or its last exit was the time exit. This is the guardrail
  fix: a window that opens mid-trend (or a trend that built during warm-up)
  never shows a cross inside the window, so a cross-only bot can make 0 trades
  there; the level entry buys the trend that is already there. A stop-loss,
  take-profit, or cross-down exit does NOT re-enter — only the time exit does.
  (If EMA(8) falls back below EMA(21), the re-entry permission is cleared.)
- **Sell (whole position):** EMA(8) crosses back below EMA(21) — the signal is
  held while EMA(8) stays below EMA(21), so a refused sell is retried on the
  next bar — or the position is worth ≤ 90% of its cost (stop-loss −10%) or
  ≥ 130% of its cost (take-profit +30%) at the close — or the position has been
  held 24 bars (time exit, counted from the bar the buy was decided on).
  The time exit forces turnover so a clean one-way window still produces sells,
  and the level re-entry then re-buys the trend while it lasts. A refused
  time-exit sell is retried on the next bar.
- **Sizing:** 15% of current equity per new position (under the 25% weight
  cap), limited by cash on hand. Sells are sent before buys in each reply;
  a sell's proceeds land at the next open and never fund a buy in the same reply.
- **Guards:** zero-volume bars signal nothing; a bar with no volume recorded
  (v null) is not held back; orders cap slippage at 300 bps (3%) past the
  decided close; no orders while warming up.
- **Deterministic:** no clock, no randomness, no network, no environment;
  iteration follows the hello symbol order and bar order only.

## Why this shape

The prize bar is beating buy-and-hold over a 3-day final window. Buy-and-hold
eats every down-leg in full; a trend filter sits in cash through downtrends
and rides uptrends. The 8/21 spans are the standard short trend-following
pair, fast enough to keep generating trades inside a 72-bar final window —
the 8-trade guardrail is the binding constraint, and V-B makes 34 trades on
the 136-bar dev window (worst 72-bar slice: 14 trades).

The two V-A additions exist for the guardrail, not for dev PnL: the time exit
(24 bars) guarantees sells — and therefore turnover — even in a clean one-way
window where no cross-down ever fires, and the level re-entry guarantees buys
in a window that opens mid-trend, where no cross-up ever fires. Without them,
a 72-bar slice can produce 0 trades; with them, the worst 72-bar window on dev
still makes 14 trades, above the 8-trade guardrail.

The V-B slippage change (100 → 300 bps) exists for the opposite regime: the
harness rejects a fill whose price moved past the cap from the decision close,
so a 1% cap rejects every buy in a market rising faster than ~1%/hour —
exactly the clean one-way tail case the time exit is built for. Dev hourly
open-vs-close moves max out at 129 bps (p99 67 bps), so 300 bps keeps a real
cap while letting fills through in up to ~3%/hour trends. The cap only decides
acceptance, never the price. Parameters are round standard values, chosen for
robustness across windows, not tuned to the dev data.

## Backtest (dev window, 136 hourly bars, official grader)

Command: `node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process`
(Docker is not available on this machine, so the `process` driver was used;
the grader runs the bot twice internally and requires byte-identical logs.)

| Entry | Net PnL (USDC) | Return | Max DD | Trades |
|---|---|---|---|---|
| **This bot — V-B (EMA 8/21, confirm, SL −10%, TP +30%, time-exit 24, level re-entry, slip 300 bps, 15%)** | **−181.45** | −1.81% | 2.63% | **34** |
| Baseline 3f95197a (EMA 8/21, confirm, SL −10%, TP +30%, slip 100 bps, 15%) | −183.32 | −1.83% | 2.64% | 28 |
| Buy-and-hold baseline | −869.34 | −8.69% | — | — |

The dev window is a falling market (all 7 assets down), so every trend
follower loses a little while buy-and-hold loses a lot. This bot beats
buy-and-hold by **+687.89 USDC** on dev, passes both guardrails
(34 ≥ 8 trades, 2.63% ≤ 25% max drawdown), and is deterministic: two
independent `grade-local` runs give byte-identical action logs.

Trade-count robustness: the worst 72-bar window on dev still makes
**14 trades**, above the 8-trade guardrail — the level re-entry is what
keeps mid-trend windows trading.

## Sensitivity (same dev window, same grader)

| Variant | Net PnL (USDC) | Trades | Max DD | Note |
|---|---|---|---|---|
| Baseline 3f95197a: EMA 8/21, confirm, SL −10%, TP +30%, slip 100 bps | −183.32 | 28 | 2.64% | Cross-only; a mid-trend window can make 0 trades |
| V-A d5ab370: baseline + time-exit 24 + level re-entry | — | — | — | Guardrail fix; dev numbers not recorded separately — V-B is the measured successor |
| **V-B 0cee876 (chosen): V-A + slippage cap 100 → 300 bps** | **−181.45** | **34** | **2.63%** | Fixes rejected fills in fast-rising markets; worst 72-bar window 14 trades |

V-B improves on the baseline by +1.87 USDC and +6 trades with a slightly lower
drawdown. The spread is small because the dev window is one falling regime;
the choice of V-B rests on the structural argument (trade frequency vs the
8-trade guardrail, and fills that actually go through in fast-rising markets),
not on chasing the best dev number.

## Layout

- `main.ts` — the bot (Node 22 TypeScript, stdlib + vendored SDK only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's `sdk/makefun-bars.ts`.
- `LICENSE` — MIT. `README.md` — this file.

## Run locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
