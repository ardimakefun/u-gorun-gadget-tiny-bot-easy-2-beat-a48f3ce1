// Tiny trend bot: EMA crossover with trend confirmation, stop-loss and take-profit.
//
// Strategy (long only, one position per asset, fixed fractional sizing):
//   - Per symbol, EMA(8) and EMA(21) of hourly closes, seeded as the mean of the
//     first `span` closes, then the standard 2/(span+1) recursion. All arithmetic is
//     float64 (+ - * / only), so the same bars always give the same orders.
//   - BUY when EMA(8) crosses above EMA(21) AND the close is above EMA(21)
//     (price confirms the uptrend instead of a flat whipsaw cross). One buy per
//     cross; no re-buy while holding.
//   - SELL the whole position when EMA(8) crosses back below EMA(21) (the signal
//     is held while EMA(8) stays below EMA(21), so a refused sell is retried on
//     the next bar), or when the position is worth <= 90% of its cost (stop-loss
//     -10%) or >= 130% of its cost (take-profit +30%) at the close.
//   - Sizing: 15% of current equity per new position (well under the 25% weight
//     cap), limited by cash on hand. Sells are sent before buys; a sell's proceeds
//     land at the next open and never fund a buy in the same reply.
//   - A bar with zero volume signals nothing; a bar with no volume recorded
//     (v null) is not held back. Orders cap slippage at 100 bps (1%) past the
//     close they were decided on. No orders while warming up.
//   - Fully deterministic: no clock, no randomness, no network, no environment;
//     iteration follows the hello symbol order and bar order only.
//
// Why this shape: the prize bar is beating buy-and-hold over a 3-day final
// window. Buy-and-hold eats every down-leg in full. A trend filter sits in cash
// through downtrends and rides uptrends, so it should lose less in falling
// markets and keep most of the upside in rising ones. The spans 8/21 are the
// standard short trend-following pair; they were picked over the slower 12/26
// not for dev PnL (12/26 is marginally better on dev) but because 12/26 makes
// only ~13 trades in 136 dev bars, which scales to ~5-7 trades in the 72-bar
// final window — under the 8-trade guardrail — while 8/21 makes 28. The
// stop-loss / take-profit are risk caps that never fired on the dev window; the
// parameters are round standard values, chosen for robustness across windows,
// not tuned to the dev data; see README.md for the sensitivity check.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 8;
const SLOW_SPAN = 21;
/** Stop-loss: sell when the position is worth at most 90% of its cost. */
const STOP_NUM = 90n;
const STOP_DEN = 100n;
/** Take-profit: sell when the position is worth at least 130% of its cost. */
const TAKE_NUM = 130n;
const TAKE_DEN = 100n;
/** Fixed weight per new position, in basis points of equity (15%). */
const WEIGHT_BPS = 1500n;
/** Max slippage per order, in bps past the close it was decided on (1%). */
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: closes collected until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the previous bar, once both EMAs are set. */
  prevGap: number | null;
  /** fast - slow after this bar. */
  gap: number | null;
  /** Sell signal held while EMA(8) stays below EMA(21). */
  down: boolean;
}

const series = new Map<string, Series>();

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

function pushBar(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_SPAN, warm: [], value: null },
      slow: { span: SLOW_SPAN, warm: [], value: null },
      prevGap: null,
      gap: null,
      down: false,
    };
    series.set(bar.symbol, s);
  }
  // Prices are compared only within one symbol, so raw integer units are fine.
  const c = Number(bar.c);
  stepEma(s.fast, c);
  stepEma(s.slow, c);
  s.prevGap = s.gap;
  s.gap = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  if (s.gap === null || s.gap >= 0) s.down = false;
  return s;
}

/** Whether a held position exits on this close: held sell signal, stop-loss or take-profit. */
function shouldExit(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, signal: boolean): boolean {
  if (signal) return true;
  const value = state.value(symbol, held.qty);
  return value * STOP_DEN <= held.cost * STOP_NUM || value * TAKE_DEN >= held.cost * TAKE_NUM;
}

await runBars({
  onBatch(state, batch) {
    const crossUp = new Set<string>();
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      const s = pushBar(bar);
      fresh.add(bar.symbol);
      if (s.prevGap === null || s.gap === null || bar.v === '0') continue;
      if (s.gap > 0 && s.prevGap <= 0) {
        // Buy only when the close also sits above the slow EMA (trend confirmation).
        if (s.slow.value !== null && Number(bar.c) > s.slow.value) crossUp.add(bar.symbol);
      }
      if (s.gap < 0 && s.prevGap >= 0) s.down = true;
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (shouldExit(state, symbol, held, series.get(symbol)!.down)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else if (crossUp.has(symbol)) {
        entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = (WEIGHT_BPS * state.equity) / BPS;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
