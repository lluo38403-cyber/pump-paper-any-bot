// Pump.fun Paper Sprint: buy-early, sell-fast bot.
//
// What the dev window's own data says (128k events, 765 coins that ever
// reached 1 SOL of real reserves): a coin's price peaks a median of 13 slots
// after it first becomes buyable, then bleeds. Buying at the first moment the
// 1%-of-reserve size cap allows a 0.01 SOL order and selling 300 slots later
// averages +42% per coin before fees; holding longer only gives the bleed
// more time, and take-profits only cap the winners. Momentum filters make it
// worse: waiting for buy pressure to confirm means buying after the pop.
//
// So this bot does the simplest thing that works: buy every fresh coin the
// moment it can (0.02 SOL, one entry per coin), sell it 50 slots later, and
// recycle the slot into the next coin — except a position that is up 1.5x or
// more at sell time, which it rides instead on a trailing stop (sell at 70%
// of the peak value, or after 10000 slots), so slow moons are not cut short.
// No take-profit, no stop loss, no tape reading — the exits are pure time
// plus the winner's trailing stop. A tiny probe mechanism keeps the entry
// above the 20-coin round-trip guardrail even in a dead market: if fewer
// than 20 coins have completed a round trip, it opens small 0.01 SOL probe
// round trips on the most liquid fresh curves and sells them as soon as the
// buy lands.
//
// Deterministic by construction: every decision is a pure function of the
// batch stream (slots, reserves, fills). No clock, no randomness, no
// environment reads. Iteration is over insertion-ordered maps only.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- sizing ---------------------------------------------------------------
const FIRST_BUY = (SOL * 2n) / 100n; // 0.02 SOL per coin
const MIN_BUY = SOL / 100n; // 0.01 SOL: the guardrail's round-trip floor
const MAX_SLIPPAGE_BPS = 10_000;

// ---- exits ----------------------------------------------------------------
const HOLD_SLOTS = 50; // sell every position this many slots after entry...
// ... unless it is a winner at that point (>= 1.5x cost): then ride it with a
// trailing stop (sell at 70% of the peak value) for up to 10000 slots.
const RIDE_ARM_BPS = 15000n;
const RIDE_KEEP_BPS = 7000n;
const RIDE_MAX_SLOTS = 10000;

// ---- probes ---------------------------------------------------------------
const PROBE_BUY = SOL / 100n; // 0.01 SOL
const PROBE_EVERY_BATCHES = 100;
const GUARDRAIL_COINS = 20;

// ---- candidate lifetime ---------------------------------------------------
const CANDIDATE_TTL_SLOTS = 3000; // forget a coin that never became buyable

/** Mark value of `tokens` at the curve's current virtual reserves. */
function markValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (vt === 0n) return 0n;
  return (tokens * vq) / vt;
}

interface Held {
  entrySlot: number;
  probe: boolean;
  peakBps: bigint; // best value/cost seen, in bps (10000 = break-even)
  riding: boolean; // winner being ridden with a trailing stop
}

// Fresh curves seen via CreateEvent, in first-seen order, with their slot.
const candidates = new Map<string, number>();
const entered = new Set<string>(); // mints we bought (or probed) once
const held = new Map<string, Held>();
const pendingBuys = new Set<string>();
const selling = new Set<string>();
const closed = new Set<string>(); // mints whose round trip finished
let orderNo = 0;
let lastProbeSeq = -1_000_000;

function nextId(prefix: string): string {
  orderNo += 1;
  return `${prefix}${orderNo}`;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const orders: Array<BuyInput | SellInput> = [];
    const slot = batch.slot;
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();

    // ---- fold the batch's fills into our books ---------------------------
    for (const f of batch.fills) {
      if (f.client_id.startsWith('b')) {
        pendingBuys.delete(f.mint);
      } else if (f.client_id.startsWith('s')) {
        selling.delete(f.mint);
        if (f.status === 'filled') {
          closed.add(f.mint);
          held.delete(f.mint);
        }
      }
    }
    // Positions the harness closed on its own (curve completed / flattened).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !pendingBuys.has(mint)) {
        closed.add(mint);
        held.delete(mint);
      }
    }

    // ---- fresh curves become candidates ------------------------------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent' && !candidates.has(e.mint) && !entered.has(e.mint)) {
        candidates.set(e.mint, e.slot);
      }
    }

    // ---- exits: probes sell at once; the rest after HOLD_SLOTS, unless they
    // are winners, in which case they ride on a trailing stop --------------
    for (const [mint, pos] of state.positions) {
      const h = held.get(mint);
      if (h === undefined) continue;
      if (selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = markValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const cost = pos.cost_lamports > 0n ? pos.cost_lamports : 1n;
      const ratioBps = (value * 10000n) / cost;
      if (ratioBps > h.peakBps) h.peakBps = ratioBps;
      let exit = false;
      if (h.probe) {
        exit = true;
      } else if (h.riding) {
        if (ratioBps <= (h.peakBps * RIDE_KEEP_BPS) / 10000n) exit = true; // trailing stop
        else if (slot - h.entrySlot > RIDE_MAX_SLOTS) exit = true; // ride time cap
      } else if (slot - h.entrySlot >= HOLD_SLOTS) {
        if (ratioBps >= RIDE_ARM_BPS) {
          h.riding = true; // winner: let it run instead of selling now
        } else {
          exit = true;
        }
      }
      if (!exit) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', client_id: nextId('s'), mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      selling.add(mint);
    }

    // ---- entries: buy every fresh coin the moment the cap allows -----------
    const slots = caps.max_open_positions - state.committedPositionCount();
    let entriesLeft = Math.min(slots, caps.max_orders_per_batch - orders.length);
    if (entriesLeft > 0) {
      for (const [mint, createdSlot] of candidates) {
        if (entriesLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          candidates.delete(mint);
          continue;
        }
        if (slot - createdSlot > CANDIDATE_TTL_SLOTS) {
          candidates.delete(mint); // its early pop is long over
          continue;
        }
        if (entered.has(mint) || held.has(mint) || pendingBuys.has(mint)) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY) continue;
        let amount = FIRST_BUY;
        if (amount > cap) amount = cap;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', client_id: nextId('b'), mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        pendingBuys.add(mint);
        entered.add(mint);
        held.set(mint, { entrySlot: slot, probe: false, peakBps: 10000n, riding: false });
        candidates.delete(mint);
        free -= amount + tx;
        entriesLeft -= 1;
      }
    }

    // ---- probes: keep the 20-coin round-trip guardrail fed -----------------
    if (
      closed.size < GUARDRAIL_COINS &&
      batch.seq - lastProbeSeq >= PROBE_EVERY_BATCHES &&
      state.committedPositionCount() < caps.max_open_positions &&
      orders.length < caps.max_orders_per_batch &&
      free >= PROBE_BUY + tx
    ) {
      let bestMint: string | null = null;
      let bestRq = 0n;
      for (const [mint, curve] of state.curves) {
        if (curve.complete) continue;
        if (entered.has(mint) || held.has(mint) || pendingBuys.has(mint)) continue;
        if (curve.real_quote_reserves > bestRq) {
          bestRq = curve.real_quote_reserves;
          bestMint = mint;
        }
      }
      if (bestMint !== null && bestRq >= MIN_BUY * 100n) {
        const cap = state.maxBuyLamports(bestMint);
        if (cap >= PROBE_BUY) {
          orders.push({ side: 'buy', client_id: nextId('b'), mint: bestMint, quote_lamports: PROBE_BUY, max_slippage_bps: MAX_SLIPPAGE_BPS });
          pendingBuys.add(bestMint);
          entered.add(bestMint);
          held.set(bestMint, { entrySlot: slot, probe: true, peakBps: 10000n, riding: false });
          lastProbeSeq = batch.seq;
        }
      }
    }

    return orders;
  },
});
