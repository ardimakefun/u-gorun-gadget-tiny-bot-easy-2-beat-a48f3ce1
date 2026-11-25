// Tiny trend bot: EMA crossover with trend confirmation, stop-loss, take-profit,
// time exit and re-entry while the trend lasts.
//
// Strategy (long only, one position per asset, fixed fractional sizing):
//   - Per symbol, EMA(8) and EMA(21) of hourly closes, seeded as the mean of the
//     first `span` closes, then the standard 2/(span+1) recursion. All arithmetic is
//     float64 (+ - * / only), so the same bars always give the same orders.
//   - BUY when EMA(8) crosses above EMA(21) AND the close is above EMA(21)
//     (price confirms the uptrend instead of a flat whipsaw cross). One buy per
//     cross; no re-buy while holding.
//   - ALSO BUY (level entry, no cross needed) when flat, EMA(8) is already above
//     EMA(21) and the close is above EMA(21), if this symbol has never traded in
//     this run, or its last exit was the time exit. This is the guardrail fix: a
//     window that opens mid-trend (or after a warm-up that built the trend) never
//     shows a cross inside the window, so a cross-only bot can make 0 trades
//     there; the level entry buys the trend that is already there. A stop-loss /
//     take-profit / cross-down exit does NOT re-enter: only the time exit does.
//   - SELL the whole position when EMA(8) crosses back below EMA(21) (the signal
//     is held while EMA(8) stays below EMA(21), so a refused sell is retried on
//     the next bar), or when the position is worth <= 90% of its cost (stop-loss
//     -10%) or >= 130% of its cost (take-profit +30%) at the close, or when it
//     has been held TIME_EXIT_BARS bars (time exit: forces turnover so a clean
//     one-way window still produces sells, and re-entry then re-buys the trend).
//   - Sizing: 15% of current equity per new position (well under the 25% weight
//     cap), limited by cash on hand. Sells are sent before buys; a sell's proceeds
//     land at the next open and never fund a buy in the same reply.
//   - A bar with zero volume signals nothing; a bar with no volume recorded
//     (v null) is not held back. Orders cap slippage at 100 bps (1%) past the
//     close they were decided on. No orders while warming up.
//   - Fully deterministic: no clock, no randomness, no network, no environment;
//     iteration follows the hello symbol order and bar order only.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 8;
const SLOW_SPAN = 21;
/** Time exit: sell a position held at least this many bars (decision bars). */
const TIME_EXIT_BARS = 24;
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
  /** Seq of the bar the current position's buy was decided on, else null. */
  entrySeq: number | null;
  /** Seq of the bar a buy was decided on but not yet filled, else null. */
  pendingBuySeq: number | null;
  /** True when the last exit was the time exit: may re-enter while trend is up. */
  reenter: boolean;
  /** True once this symbol has ever bought in this run. */
  traded: boolean;
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
      entrySeq: null,
      pendingBuySeq: null,
      reenter: false,
      traded: false,
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

/** Why a held position exits on this close, else null: held sell signal, stop-loss, take-profit, or time exit. */
function exitKind(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, signal: boolean, seq: number, entrySeq: number | null): 'signal' | 'sl' | 'tp' | 'time' | null {
  if (signal) return 'signal';
  const value = state.value(symbol, held.qty);
  if (value * STOP_DEN <= held.cost * STOP_NUM) return 'sl';
  if (value * TAKE_DEN >= held.cost * TAKE_NUM) return 'tp';
  if (entrySeq !== null && seq - entrySeq >= TIME_EXIT_BARS) return 'time';
  return null;
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

    // Settle last bar's buy: a fill means the position opened (record its
    // decision seq for the time exit); a rejection clears the pending buy so
    // the level entry may retry it. A sell that was refused leaves entrySeq
    // set, so the time exit keeps retrying it on the next bar.
    for (const { symbol } of state.hello.symbols) {
      const s = series.get(symbol);
      if (s === undefined) continue;
      if (s.pendingBuySeq !== null) {
        if (state.positions.has(symbol)) {
          s.entrySeq = s.pendingBuySeq;
          s.traded = true;
          s.pendingBuySeq = null;
        } else if (batch.fills.some((f) => f.symbol === symbol && f.side === 'buy' && f.status === 'rejected')) {
          s.pendingBuySeq = null;
        }
      } else if (s.entrySeq !== null && !state.positions.has(symbol)) {
        s.entrySeq = null;
      }
    }

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        const kind = exitKind(state, symbol, held, s.down, state.seq, s.entrySeq);
        if (kind !== null) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          // Only the time exit may re-enter while the trend lasts. entrySeq
          // stays set until the position is gone, so a refused time-exit sell
          // is retried on the next bar.
          s.reenter = kind === 'time';
        }
      } else if (crossUp.has(symbol)) {
        entries.push(symbol);
      } else if (s.gap !== null && s.gap > 0 && s.slow.value !== null && Number(state.latest.get(symbol)!.c) > s.slow.value && (s.reenter || !s.traded)) {
        // Level entry: the trend is already up and there was no cross to catch
        // (window opened mid-trend, or the trend built during warm-up), or the
        // time exit just closed a position while the trend lasts.
        entries.push(symbol);
      }
      if (s.gap !== null && s.gap < 0) s.reenter = false;
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
      const bs = series.get(symbol)!;
      bs.pendingBuySeq = state.seq;
      bs.reenter = false;
      cash -= slice;
      room--;
    }
    return orders;
  },
});
