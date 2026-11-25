# Tiny Trend Bot — Beat Buy-and-Hold on Solana

A tiny long-only trend-following bot for the make.fun competition
`u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1` (bars-replay/v1, hourly bars,
$10,000 USDC, 7 Solana assets: FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF).

## Strategy

EMA crossover with trend confirmation, stop-loss and take-profit — one
position per asset, fixed fractional sizing:

- **Indicators:** per symbol, EMA(8) and EMA(21) of hourly closes, seeded as
  the mean of the first `span` closes, then the standard `2/(span+1)` recursion.
- **Buy:** EMA(8) crosses above EMA(21) **and** the close is above EMA(21)
  (price confirms the uptrend). One buy per cross, no re-buy while holding.
- **Sell (whole position):** EMA(8) crosses back below EMA(21) — the signal is
  held while EMA(8) stays below EMA(21), so a refused sell is retried on the
  next bar — or the position is worth ≤ 90% of its cost (stop-loss −10%) or
  ≥ 130% of its cost (take-profit +30%) at the close.
- **Sizing:** 15% of current equity per new position (under the 25% weight
  cap), limited by cash on hand. Sells are sent before buys in each reply.
- **Guards:** zero-volume bars signal nothing; orders cap slippage at 100 bps
  past the decided close; no orders while warming up.
- **Deterministic:** no clock, no randomness, no network, no environment;
  iteration follows the hello symbol order and bar order only.

## Why this shape

The prize bar is beating buy-and-hold over a 3-day final window. Buy-and-hold
eats every down-leg in full; a trend filter sits in cash through downtrends
and rides uptrends. The 8/21 spans are the standard short trend-following
pair. They were picked over the slower 12/26 **not** for dev PnL (12/26 is
marginally better on dev) but because 12/26 makes only ~13 trades in 136 dev
bars, which scales to ~5–7 trades in the 72-bar final window — under the
8-trade guardrail — while 8/21 makes 28. Parameters are round standard values,
chosen for robustness across windows, not tuned to the dev data.

## Backtest (dev window, 136 hourly bars, official grader)

Command: `node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process`
(Docker is not available on this machine, so the `process` driver was used;
the grader runs the bot twice internally and requires byte-identical logs.)

| Entry | Net PnL (USDC) | Return | Max DD | Trades | Assets | Fees (USDC) |
|---|---|---|---|---|---|---|
| **This bot (EMA 8/21, SL −10%, TP +30%, 15%)** | **−183.32** | −1.83% | 2.64% | **28** | 7 | 50.57 |
| Buy-and-hold baseline | −869.34 | −8.69% | 10.92% | 7 | 7 | 19.14 |
| EMA-cross baseline (8/21) | −173.04 | −1.73% | 2.51% | 28 | 7 | 48.18 |
| Hold-cash baseline | 0.00 | 0.00% | 0.00% | 0 | 0 | 0.00 |

The dev window is a falling market (all 7 assets down), so every trend
follower loses a little while buy-and-hold loses a lot. This bot beats
buy-and-hold by **+686.02 USDC** on dev, passes both guardrails
(28 ≥ 8 trades, 2.64% ≤ 25% max drawdown), and is deterministic: two
independent `grade-local` runs give identical `action_log_sha256`
(`63cb9ad860bbaf3ed6a56ac17854f8f577613df5d6d88419b85323f4cc9e0e8a`) and
identical `result_sha256`.

## Sensitivity (same dev window, same grader)

| Variant | Net PnL (USDC) | Trades | Max DD | Note |
|---|---|---|---|---|
| V1: EMA 12/26, confirm, SL −8%, TP +25% | −174.83 | 13 | 1.75% | Best dev PnL, but too few trades for a 72-bar final window |
| **V2 (chosen): EMA 8/21, confirm, SL −10%, TP +30%** | **−183.32** | **28** | **2.64%** | Robust trade count; SL/TP never fired on dev |
| V3: EMA 12/26, no confirmation | −174.83 | 13 | 1.75% | Identical to V1 — confirmation never bound on dev |
| V4: EMA 8/21, no confirmation | −183.32 | 28 | 2.64% | Identical to V2 — confirmation never bound on dev |
| V5: EMA 12/26, confirm, SL −5%, TP +15% | −174.83 | 13 | 1.75% | Identical to V1 — SL/TP never fired on dev |

All variants beat buy-and-hold by ~+686 to ~+695 USDC. The spread between
variants is small (±9 USDC) because the dev window is one falling regime; the
choice of V2 rests on the structural argument (trade frequency vs the 8-trade
guardrail in a 72-bar final window), not on chasing the best dev number.

## Layout

- `main.ts` — the bot (Node 22 TypeScript, stdlib + vendored SDK only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's `sdk/makefun-bars.ts`.
- `LICENSE` — MIT. `README.md` — this file.

## Run locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
