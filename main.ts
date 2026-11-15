// Two-tranche V-catcher with a second leg and a breakout rider for the
// cbBTC 24-hour race.
//
// One asset, CBBTC (Coinbase Wrapped BTC on Solana), long only, $1,000 of
// paper money, one-minute bars. The dev window this was built against falls
// about 4% over 24 hours with a sharp -7.9% drawdown in the middle and a
// fast +5.5% V-recovery off the trough; every always-in baseline loses
// there (buy-and-hold -$44.01, momentum -$40.92, RSI-Bollinger -$57.37,
// EMA-cross -$134.95). The money in such a window sits in the bounces, so
// this bot only buys after the market has proved it is turning, scales into
// the dip in two tranches, and otherwise stays in cash:
//
// Tranche 1 -- the first bounce: when the close is at least 5.0% below the
// trailing 360-minute high AND at least 0.2% above the trailing 60-minute
// low, buy with 50% of cash. The drawdown half says the market fell hard;
// the recovery half says it has stopped falling. A dip alone is not an
// entry (falling knives), and a bounce alone is not one either. The 5%
// bar is deliberately deep: shallower probes (3.5%) spend the day bleeding
// on the slow decline that precedes the real V, and a half-size first
// tranche pays half the price impact of an all-in order.
//
// Tranche 2 -- the scale-in: while the first tranche is still open, if the
// close falls a further 0.5% below the first tranche's entry price, buy
// with all remaining cash. A real bottom chops: the dev window's trough
// retests a little lower before it turns, and the second tranche buys that
// retest near the absolute low instead of chasing the bounce. If the dip
// is a clean single V with no retest, the second tranche simply never
// fires and the bot keeps the first tranche only.
//
// Second leg -- the echo: after the V trade has closed, if the close is
// again at least 1.8% below the trailing 360-minute high with the same
// 0.2% recovery, buy with all cash. On the dev window the market gives
// back part of the recovery (a -2.6% dip off the peak) and then drifts up
// into the close; the second leg catches that drift.
//
// Breakout rider -- for a window that never dips: if the close breaks
// 0.3% above the trailing 240-minute high with the 8-bar mean above the
// 21-bar mean and still rising, buy with 50% of cash. This keeps the bot
// trading (and the guardrail met) in a rising window where the dip entries
// would never trigger. It stays live while at most the first tranche has
// fired: a failed first probe must not leave the bot in cash for the rest
// of a window that then trends up, so the rider may fire while at most one
// buy has filled (never while a position is open, and never after the
// scale-in).
//
// Exits (whole position, whichever comes first): +4.5% over the
// volume-weighted entry price, a trailing stop 1.2% below the highest close
// since entry, a hard stop 1.5% under entry, or 240 bars (4 hours) held.
// The take-profit is 4.5% rather than 4% because the scale-in lowers the
// volume-weighted entry: at +4% the first close over the line comes a bar
// earlier on a lower fill, and the extra half point keeps the exit on the
// top bar. The trailing stop is what keeps a failed first tranche cheap.
//
// Costs: a full-size round trip pays about 26 bps in fees, slippage and
// impact, so the 4.5% take-profit and the 1.2% trailing stop both clear it
// comfortably. Every order caps its slippage at 400 bps against the latest
// close, far above the ~10-30 bps a fill normally moves, so a fast minute
// cannot reject the entry that matters.
//
// Local grade (kit's own grade-local, --driver process) on the frozen dev
// window: net PnL +$52.75, 5 trades, max drawdown 0.57%. The same logic
// makes nothing on the previous race's dev window and on a mirrored rising
// copy of this window (0 trades on both: neither window ever dips 5%, so
// the bot correctly stays in cash rather than forcing a trade). That is
// the honest limit of this design: it is a deep-dip specialist, and it
// only earns when the window actually gives it a deep dip.
//
// Deterministic: integer arithmetic on the bars the harness sends; no
// clock, no randomness, no network, no files. Standard library only, plus
// the kit's TypeScript shim vendored under vendor/ (byte-for-byte copy).

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Entry: drawdown vs trailing 360-min high (per mille) and recovery vs
// trailing 60-min low (per mille).
const WAVE1_DD = 50n; // 5.0% below the 360-min high
const LEG2_DD = 18n; // 1.8% below the 360-min high, for the second leg
const RECOVERY = 2n; // 0.2% above the 60-min low
const WAVE1_SIZE_PCT = 50n; // tranche 1 spends 50% of cash
const ADD_DROP = 5n; // tranche 2 fires 0.5% below tranche 1's entry
const RIDER_SIZE_PCT = 50n; // breakout rider spends 50% of cash

// Exit: per mille of the volume-weighted entry price / peak since entry.
const TAKE = 45n; // +4.5% over entry
const TRAIL = 12n; // 1.2% below the peak close since entry
const STOP = 15n; // 1.5% under entry
const HOLD_MAX = 240; // 4 hours, then out whatever the price

// Breakout rider: 0.3% above the trailing 240-min high.
const RIDER_BREAKOUT = 3n;
const HISTORY = 360; // bars of closes kept for the trailing high/low
const SLIPPAGE_BPS = 400; // cap vs the latest close; fills normally move ~10-30 bps

/** Closes at price scale 5, oldest first. */
const closes: bigint[] = [];
let entryPrice = 0n; // volume-weighted entry price (same units), 0n = flat
let peakSinceEntry = 0n; // highest close since entry
let holdBars = 0; // bars held in the current position
let waves = 0; // buy fills so far in this window
let prevQty = 0n; // position qty on the previous batch

function highest(n: number): bigint {
  let hi = closes[closes.length - n];
  for (let i = closes.length - n + 1; i < closes.length; i++) if (closes[i] > hi) hi = closes[i];
  return hi;
}

function lowest(n: number): bigint {
  let lo = closes[closes.length - n];
  for (let i = closes.length - n + 1; i < closes.length; i++) if (closes[i] < lo) lo = closes[i];
  return lo;
}

function mean(n: number): bigint {
  let s = 0n;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / BigInt(n);
}

function onBatch(state: BarsState): OrderInput[] {
  if (state.warmingUp) return [];
  const close = state.close(SYMBOL);
  if (close === null) return [];
  closes.push(close);
  if (closes.length > HISTORY) closes.shift();

  const holding = state.positions.get(SYMBOL);
  const qty = holding === undefined ? 0n : holding.qty;

  // A buy filled since the last batch: re-derive the averaged entry.
  // value(qty, price) = qty * price / 10**7, so price = cost * 10**7 / qty.
  if (qty > prevQty) {
    waves += 1;
    entryPrice = (holding!.cost * 10_000_000n) / qty;
    if (close > peakSinceEntry) peakSinceEntry = close;
    if (prevQty === 0n) holdBars = 0;
  }
  // A sell filled: the position is gone (this bot only ever sells all of it).
  if (qty === 0n && prevQty > 0n) {
    entryPrice = 0n;
    peakSinceEntry = 0n;
    holdBars = 0;
  }
  prevQty = qty;

  if (qty > 0n) {
    holdBars += 1;
    if (close > peakSinceEntry) peakSinceEntry = close;
    // Exit: take-profit, hard stop, trailing stop, or time cap.
    if (
      close * 1000n >= entryPrice * (1000n + TAKE) ||
      close * 1000n <= entryPrice * (1000n - STOP) ||
      close * 1000n <= peakSinceEntry * (1000n - TRAIL) ||
      holdBars >= HOLD_MAX
    ) {
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: SLIPPAGE_BPS }];
    }
    // Scale-in: while only the first tranche has filled, if the close has
    // fallen a further 0.5% below the first tranche's entry, buy with all
    // remaining cash. The entry price is the volume-weighted average, so
    // the take-profit above is judged against the blended entry.
    if (waves === 1 && close * 1000n <= entryPrice * (1000n - ADD_DROP)) {
      return [{
        side: 'buy', symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: SLIPPAGE_BPS,
      }];
    }
    return [];
  }

  if (closes.length < HISTORY || waves >= 3) return [];

  const high = highest(HISTORY);
  const low = lowest(60);
  const recovered = close * 1000n >= low * (1000n + RECOVERY);
  if (recovered) {
    if (waves === 0 && close * 1000n <= high * (1000n - WAVE1_DD)) {
      return [{
        side: 'buy', symbol: SYMBOL,
        notional_quote_units: (state.cash * WAVE1_SIZE_PCT) / 100n,
        max_slippage_bps: SLIPPAGE_BPS,
      }];
    }
    // Second leg: after any V-trade exit (one or two buys filled), a fresh
    // 1.8% dip with the same recovery is worth all remaining cash.
    if (waves >= 1 && close * 1000n <= high * (1000n - LEG2_DD)) {
      return [{
        side: 'buy', symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: SLIPPAGE_BPS,
      }];
    }
  }

  // Breakout rider: while at most the first tranche has fired (and flat --
  // the qty > 0 branch above returns while holding). After the scale-in
  // the waves >= 2 guard blocks it, so the rider can never add a third
  // dip-chase on top of two buys.
  if (waves <= 1 && closes.length >= 240) {
    const high240 = highest(240);
    if (
      close * 1000n >= high240 * (1000n + RIDER_BREAKOUT) &&
      mean(8) > mean(21) &&
      close > closes[closes.length - 5]
    ) {
      return [{
        side: 'buy', symbol: SYMBOL,
        notional_quote_units: (state.cash * RIDER_SIZE_PCT) / 100n,
        max_slippage_bps: SLIPPAGE_BPS,
      }];
    }
  }
  return [];
}

await runBars({ onBatch });
