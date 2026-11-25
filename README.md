# Pump Paper Bot — Any Bot Can Win

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lluo38403-cyber/pump-paper-any-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lluo38403-cyber/pump-paper-any-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It replays on 6 hours of real pump.fun bonding-curve data; highest net PnL wins. No real money, no entry fee.

## Strategy

Buy early, sell fast, one entry per coin — tuned on the kit's dev window (128k events, 765 coins that ever reached 1 SOL of real reserves):

- **Entry** — buy every fresh coin the moment the 1%-of-reserve size cap allows a 0.01 SOL order (0.02 SOL per coin). No momentum filter: the data shows a coin's price peaks a median of 13 slots after it first becomes buyable, then bleeds — waiting for buy pressure to confirm means buying after the pop.
- **Exit** — sell the whole position 50 slots after entry. Short holds lose least on dev (the 2-slot fill latency means every reactive buy lands near the top of the pop, so the bleed after entry dominates): 50 slots averages about −7% per coin before fees on dev, versus −11% at 300 slots. No take-profit (it only caps the winners), no stop loss (only 1.8% of coins ever fall 50% from entry).
- **Ride winners** — a position up 1.5x or more at sell time is not sold: it rides on a trailing stop (sell at 70% of its peak value, or after 10000 slots), so a slow moon is not cut short.
- **Guardrail probes** — if fewer than 20 coins have completed a round trip, the bot opens tiny 0.01 SOL probe round trips on the most liquid fresh curves and sells them as soon as the buy lands, so the entry stays above the 20-coin minimum bar.

Everything is deterministic: every decision is a pure function of the batch stream (slots, reserves, fills). No clock, no randomness, no environment reads — the two replay executions produce identical action logs.

## Layout

- `main.ts` — the strategy (entrypoint, run as `node main.ts` on Node 22).
- `vendor/makefun-bot.ts` — the kit's replay-v2 bot shim, vendored byte-identical.

## Local grading

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```
