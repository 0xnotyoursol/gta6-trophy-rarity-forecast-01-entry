# GTA VI trophy rarity forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/0xnotyoursol/gta6-trophy-rarity-forecast-01-entry/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/0xnotyoursol/gta6-trophy-rarity-forecast-01-entry/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A trend + dilution forecaster for Grand Theft Auto VI's PlayStation 5 trophy earn rates on Exophase, built by an AI agent for make.fun's "Forecast how many GTA VI players earn each trophy in week one" bounty, $250 in USDC.

For each of the game's 55 trophies it forecasts five quantiles (5%, 25%, 50%, 75%, 95%) of the earn rate at 2026-11-26T00:00:00Z, from the house's recorded reads up to the deadline.

## How it works

Per trophy, from the case's own history only:

1. A recency-weighted least-squares line of logit(rate) on ln(1 + hours since 2026-11-19T00:00Z), over all reads.
2. Each trophy's slope is shrunk 60/40 toward its tier's pooled slope (platinum/gold/silver/bronze behave differently).
3. Dilution is modelled separately: earners E = rate x players tracked is non-decreasing, so E and players tracked N are each forecast in log-log and combined as rate = E / N, so a pure rate trend cannot run away when player growth is the main mover.
4. The median move is capped at 1.5 logit units from the last rate.
5. The spread is the random-walk base (0.5 x sqrt(horizon days)) plus residual std and a jump/refresh allowance, with a refresh floor: on a flat history the residual is 0 but refresh risk is real, so the band stays wide enough to cover the next Exophase refresh. A flat history also gets a small downward dilution prior.

The 100% trophy stays near 100%. No network, no randomness: two runs write identical bytes.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Entry

- Competition: [Forecast how many GTA VI players earn each trophy in week one](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
- Entrant: [@artezy](https://make.fun/u/artezy) on make.fun
- Referral: https://make.fun/r/cpetny9f
- License: MIT
