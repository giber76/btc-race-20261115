// Two-tier V-catcher with a second leg and a breakout rider for the
// cbBTC 24-hour race.
//
// One asset, CBBTC (Coinbase Wrapped BTC on Solana), long only, $1,000 of
// paper money, one-minute bars. The dev window this was built against falls
// about 4% over 24 hours with a sharp -7.9% drawdown in the middle and a
// fast +5.5% V-recovery off the trough; every always-in baseline loses
// there (buy-and-hold -$44.01, momentum -$40.92, RSI-Bollinger -$57.37,
// EMA-cross -$134.95). The money in such a window sits in the bounces, so
// this bot only buys after the market has proved it is turning, scales
// into the dip in two tiers, and otherwise stays in cash.
//
// Why two tiers instead of one deep entry (the v2 design, +$52.75 on dev
// but a deep-dip specialist): a single 5.0% entry has two holes. First,
// if the dip is a clean single V with no retest, the retest scale-in
// never fires and only half the cash is invested at the bottom (v2 makes
// ~$27.95 there). Second, if the dip is 4.5-5.0% deep, a 5.0% entry never
// fires at all -- the previous race's dev window tops out at a 4.97%
// drawdown against its trailing high, and v2 makes $0 on it, while a
// 4.7% entry makes +$9.84. The two tiers close both holes:
//
// Tier 1 -- the early tranche: when the close is at least 4.7% below the
// trailing 360-minute high AND at least 0.2% above the trailing 60-minute
// low, buy with 25% of cash. The drawdown half says the market fell hard;
// the recovery half says it has stopped falling. A dip alone is not an
// entry (falling knives), and a bounce alone is not one either.
//
// Tier 2 -- the deep tranche: when the close is at least 5.0% below the
// trailing 360-minute high with the same recovery, buy with all remaining
// cash. On the dev window tier 1 fills near the top of the plunge and
// tier 2 fills at the trough; together they put 100% of cash to work at a
// blended entry near the bottom whether or not the trough retests.
//
// Scale-in -- the retest: while a tier-2 position is open, if the close
// falls a further 0.5% below the tier-2 fill price, buy with all remaining
// cash. A real bottom chops: the dev window's trough retests a little
// lower before it turns. (With tier 2 taking all remaining cash there is
// normally nothing left to scale in with; the rule stays so the design
// keeps working if tier 2's size is ever reduced.)
//
// Second leg -- the echo: after a deep trade has closed, if the close is
// again at least 1.8% below the trailing 360-minute high with the same
// recovery, buy with all cash. On the dev window the market gives back
// part of the recovery (a -2.6% dip off the peak) and then drifts up into
// the close; the second leg catches that drift.
//
// Breakout rider -- for a window that never dips: if the close breaks
// 0.3% above the trailing 240-minute high with the 8-bar mean above the
// 21-bar mean and still rising, buy with 50% of cash. This keeps the bot
// trading (and the guardrail met) in a rising window where the dip entries
// would never trigger. It stays live while at most one buy has filled: a
// failed first probe must not leave the bot in cash for the rest of a
// window that then trends up, so the rider may fire while at most one buy
// has filled (never while a position is open, and never after the second
// tier). In practice the rider never fired on any of the three windows
// tested (dev, previous race, mirrored dev): in a slow grind the close
// never jumps 0.3% above the 240-minute high. It stays as insurance for
// a sharp race-window breakout.
//
// Exits (whole position, whichever comes first): +4.5% over the
// volume-weighted entry price, a trailing stop 1.2% below the highest close
// since entry, a hard stop 1.5% under entry, or 240 bars (4 hours) held.
// The take-profit is 4.5% rather than 5% because the blended entry sits
// above the trough: at +5% the first close over the line comes after the
// recovery peak, and the trailing stop would exit lower instead.
//
// Costs: a full-size round trip pays about 26 bps in fees, slippage and
// impact, so the 4.5% take-profit and the 1.2% trailing stop both clear it
// comfortably. Every order caps its slippage at 400 bps against the latest
// close, far above the ~10-30 bps a fill normally moves, so a fast minute
// cannot reject the entry that matters.
//
// Honest limits, measured with the kit's own grade-local and a
// bit-perfect simulator on three windows: this design gives up about
// $4 of dev PnL against the single-deep-entry v2 (+$48.61 vs +$52.75) to
// buy insurance worth far more -- on a clean single V it makes +$48.61
// instead of v2's +$27.95, and on the previous race's window (4.97% dip)
// it makes +$9.84 instead of v2's $0. Its worst tested window is a
// mirrored (inverted) dev window, -$3.97, from the second leg buying a
// dip that never recovers. The stretch target of +$100 local dev is not
// honestly reachable: the window's up-legs sum to roughly +10% gross
// before costs, and a causal strategy cannot capture all of them -- the
// board leader at $74.1 is near-perfect capture of every wiggle.
//
// Deterministic: integer arithmetic on the bars the harness sends; no
// clock, no randomness, no network, no files. Standard library only, plus
// the kit's TypeScript shim vendored under vendor/ (byte-for-byte copy).

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Entries: drawdown vs trailing 360-min high (per mille) and recovery vs
// trailing 60-min low (per mille).
const WAVE1_DD = 47n; // 4.7% below the 360-min high, tier 1
const WAVE2_DD = 50n; // 5.0% below the 360-min high, tier 2
const LEG2_DD = 18n; // 1.8% below the 360-min high, for the second leg
const RECOVERY = 2n; // 0.2% above the 60-min low
const WAVE1_SIZE_PCT = 25n; // tier 1 spends 25% of cash
const WAVE2_SIZE_PCT = 100n; // tier 2 spends all remaining cash
const ADD_DROP = 5n; // scale-in fires 0.5% below the tier-2 fill price
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
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units; never send a smaller buy

/** Closes at price scale 5, oldest first. */
const closes: bigint[] = [];
let entryPrice = 0n; // volume-weighted entry price (same units), 0n = flat
let peakSinceEntry = 0n; // highest close since entry
let holdBars = 0; // bars held in the current position
let waves = 0; // buy fills so far in this window
let prevQty = 0n; // position qty on the previous batch
let prevCost = 0n; // position cost basis on the previous batch
let deep1Done = false; // tier-1 tranche sent
let deep2Done = false; // tier-2 tranche sent
let deepEntry = 0n; // fill price of the latest deep tranche (scale-in trigger)

function highest(n: number): bigint {
  let hi = closes[closes.length - n];
  for (let i = closes.length - n + 1; i < closes.length; i++) if (closes[i] > hi) hi = closes[i];
  return hi;
}

function lowest(n: number): bigint {
  let lo = closes[closes.length - n];
  for (let i = closes.length - n; i < closes.length; i++) if (closes[i] < lo) lo = closes[i];
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
  // When the tier-2 tranche fills, back out its own fill price from the
  // change in cost and qty: that price is the scale-in trigger.
  if (qty > prevQty) {
    waves += 1;
    const newCost = holding!.cost;
    if (deep2Done && deepEntry === 0n) {
      const fillQty = qty - prevQty;
      const fillSpend = newCost - prevCost;
      if (fillQty > 0n && fillSpend > 0n) deepEntry = (fillSpend * 10_000_000n) / fillQty;
    }
    entryPrice = (newCost * 10_000_000n) / qty;
    if (close > peakSinceEntry) peakSinceEntry = close;
    if (prevQty === 0n) holdBars = 0;
    prevCost = newCost;
  }
  // A sell filled: the position is gone (this bot only ever sells all of it).
  if (qty === 0n && prevQty > 0n) {
    entryPrice = 0n;
    peakSinceEntry = 0n;
    holdBars = 0;
    prevCost = 0n;
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
    const high = highest(HISTORY);
    const low = lowest(60);
    const recovered = close * 1000n >= low * (1000n + RECOVERY);
    // Tier 2: while only tier 1 has filled, a 5.0% drawdown with recovery
    // buys all remaining cash at the trough.
    if (deep1Done && !deep2Done && recovered && close * 1000n <= high * (1000n - WAVE2_DD)) {
      deep2Done = true;
      return [{
        side: 'buy', symbol: SYMBOL,
        notional_quote_units: (state.cash * WAVE2_SIZE_PCT) / 100n,
        max_slippage_bps: SLIPPAGE_BPS,
      }];
    }
    // Scale-in: while a tier-2 position is open and cash remains, if the
    // close has fallen a further 0.5% below the tier-2 fill price (backed
    // out from the fill's cost and qty above), buy with all remaining cash.
    if (deep2Done && deepEntry > 0n && state.cash >= MIN_NOTIONAL && close * 1000n <= deepEntry * (1000n - ADD_DROP)) {
      return [{
        side: 'buy', symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: SLIPPAGE_BPS,
      }];
    }
    return [];
  }

  if (closes.length < HISTORY) return [];

  const high = highest(HISTORY);
  const low = lowest(60);
  const recovered = close * 1000n >= low * (1000n + RECOVERY);
  if (recovered) {
    // Tier 1: first deep tranche, 25% of cash at a 4.7% drawdown.
    if (!deep1Done && close * 1000n <= high * (1000n - WAVE1_DD)) {
      deep1Done = true;
      return [{
        side: 'buy', symbol: SYMBOL,
        notional_quote_units: (state.cash * WAVE1_SIZE_PCT) / 100n,
        max_slippage_bps: SLIPPAGE_BPS,
      }];
    }
    // Tier 2 from flat: tier 1 already filled and exited before the dip
    // reached 5.0%; the deep tranche is still worth all remaining cash.
    if (deep1Done && !deep2Done && close * 1000n <= high * (1000n - WAVE2_DD)) {
      deep2Done = true;
      return [{
        side: 'buy', symbol: SYMBOL,
        notional_quote_units: (state.cash * WAVE2_SIZE_PCT) / 100n,
        max_slippage_bps: SLIPPAGE_BPS,
      }];
    }
    // Second leg: after any deep trade has closed, a fresh 1.8% dip with
    // the same recovery is worth all remaining cash.
    if (deep1Done && close * 1000n <= high * (1000n - LEG2_DD)) {
      return [{
        side: 'buy', symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: SLIPPAGE_BPS,
      }];
    }
  }

  // Breakout rider: while at most one buy has filled (and flat -- the
  // qty > 0 branch above returns while holding). After the second tier
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
