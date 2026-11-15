# btc-race-20261115

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/giber76/btc-race-20261115/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/giber76/btc-race-20261115/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

Two-Wave V-Catcher + Breakout Rider — a long-only cbBTC paper-trading bot for make.fun's 24-hour BTC race. It buys sharp V-reversals in two waves (40% of cash, then all cash) once the market proves it is turning, and rides breakouts when the window never dips; exits at +4% take-profit, a 1.2% trailing stop, a 1.5% hard stop, or 4 hours held. Local dev grade on the frozen window: +$40.01 net PnL, 4 trades, 1.33% max drawdown.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <path-to-unpacked-kit> --bot . --driver process --worktree
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=95qxbanw&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
