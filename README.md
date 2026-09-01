# Robinhood Chain LP tools

Work out what a Uniswap **v3 or v4** liquidity position would actually earn on
[Robinhood Chain](https://docs.robinhood.com/chain/connecting) (chain ID 4663) —
for a price range you choose, not the blended pool average a screener shows.

Two tools:

| | what it does | speed | accuracy |
|---|---|---|---|
| `uni-range-apr` | estimates from current liquidity + a 24h volume feed | seconds | approximate |
| `uni-range-replay` | replays every Swap event over the window | ~1–4 min | measured |

Everything runs against the **public RPC**. No API key, no archive node, no subgraph.

## Install

```bash
pnpm install     # or npm install
```

## Quick start

```bash
# 1. find pools
pnpm apr --top uniswap-v3-robinhood

# 2. estimate an APR for a range
pnpm apr --pool <address|poolId> --width 10 --capital 10000

# 3. see how APR trades off against range width
pnpm apr --pool <address|poolId> --sweep

# 4. measure what that range would really have earned over the last 24h
pnpm replay --pool <address|poolId> --width 10 --capital 10000 --validate
```

A v3 pool is a 40-hex address; a v4 pool is a 64-hex poolId. Both tools detect
which from the length.

## Why "pool APR" is the wrong number

A screener shows `fees / total TVL`. That is blended across all liquidity,
in-range or not, and nobody earns it. Fees go to in-range liquidity in
proportion to liquidity units, so the APR of a *range* depends on how much
liquidity you add and how tight the range is:

```
L_you   = capital / valuePerLiquidity(range, spot)
share   = L_you / (L_active + L_you)
fees/yr = volume * feeRate * lpShareOfFee * share * 365
APR     = fees/yr / capital
```

Two consequences people get wrong:

- **Pool-average APR is not a floor.** If existing liquidity is concentrated
  tighter than your range, you earn *less* than the pool average. Observed on a
  live v4 pool: 101% pool average, 32% for a ±10% range.
- **Volume is not the thing to select on.** Fee tier, the protocol cut, and how
  much liquidity competes with you matter more. A 0.01% pool doing $150M/day can
  pay an LP less than a 0.046% pool doing $12M/day.

## How the replay works

`uni-range-replay` fetches every `Swap` event over the window. Each event carries
the amounts, the price, the tick, and — critically — the **liquidity active at
that instant**. So for a candidate range:

```
for each swap, if tick_at_swap is inside [tickLower, tickUpper]:
    feePaid   = |amountIn| * feeRate       # v4 emits the actual fee per swap
    lpFee     = feePaid * lpFeeShare       # net of the protocol cut
    yourShare = L_you / (liquidity_at_swap + L_you)
    yourFees += lpFee * yourShare
```

No volume feed, no extrapolation, no assumption about where liquidity sits.
Out-of-range swaps contribute zero, so **time-in-range is measured rather than
modelled**.

### Validation

`--validate` replays a recent block window and compares the implied fee growth
against the pool's own `feeGrowthGlobal` over exactly the same blocks — two
independent routes to the same quantity. Observed agreement:

```
fee growth WETH:  replay 6.383207e-3  chain 6.383799e-3  ratio 0.9999
fee growth USDG:  replay 1.781253e-11 chain 1.781048e-11 ratio 1.0001
```

That confirms the sign convention, the fee rate and the protocol-fee handling.
Replayed 24h volume also lands within ~2% of GeckoTerminal independently.

## Chain-specific gotchas

These will silently corrupt your numbers if you don't handle them:

1. **v3 pools here have the protocol fee switched on.** `slot0.feeProtocol` is
   `0x44`, so LPs keep only **75%** of the swap fee. Ignoring it overstates APR
   by a third.
2. **Many v4 pools use dynamic fees.** `slot0.lpFee` reads `0` between swaps
   because the hook sets the fee per swap, so `volume × feeRate` computes 0%.
   One such pool's realised mean fee was **0.121%**, measurable only from the
   `fee` field on each Swap event.
3. **State is pruned at ~5000 blocks (~8 min), but logs go back to genesis.** So
   historical fee work needs no archive node — read logs, not state. `eth_getLogs`
   caps at roughly 50k blocks / 10k logs per call and rate-limits hard (HTTP 429).
   Those two failures need *opposite* responses: shrink the chunk for the former,
   slow down but keep the chunk for the latter. Halving on a 429 multiplies your
   request count and makes it worse.
4. **Busy pools emit ~1M swaps a day.** Fold each log into running totals and drop
   it; buffering a day of swaps exhausts the heap and the process dies silently.

## Sample results

All measured, all cross-checked against on-chain `feeGrowthGlobal`.

### 24h, v4 WETH/USDG 0.046% — ±10% range, $10k

```
swaps            50,010  (50,010 inside your range)
volume (in-legs) $12.23M    GeckoTerminal says $12.02M
LP fees, whole pool $5.6k
mean fee rate    0.0577%  (per-swap, from the event)
time in range    100.00%
fees earned      $29.32
annualised APR   107.00%      validation ratio 1.0000
```

The estimator's guess for the same pool and range was 115%. Close enough to look
right, far enough to be worth measuring.

### Matched 2h window — why volume is the wrong selector

Same range (±10%), same size ($10k), same two hours:

| Pool | Swaps | Volume | Your fees | APR | Your share |
|---|---|---|---|---|---|
| v3 USDG/WETH **0.01%** | 97,328 | $39.14M | $1.61 | 70.6% | 0.05% |
| v4 WETH/USDG **0.046%** | 3,109 | $0.58M | $1.52 | 66.5% | 0.57% |

The v3 pool pushed **68× the volume** and paid the same $10k position essentially
the same fees. A 0.01% tier with a 25% protocol cut nets 0.0075% per trade, and
that thin margin is shared across far more liquidity — your slice there is 0.05%
versus 0.57%. Fee tier and crowding beat raw flow.

Note also how much the window matters: the v3 pool annualised to 96.9% over a
different 24h and 70.6% here. Single-window figures are samples, not forecasts.

## Limitations — read before acting on any of this

- **Fee yield only.** No impermanent loss, no gas, no rebalancing cost. These are
  gross figures and IL can exceed fees.
- **One window is one sample.** The same pool annualised to 39% over a quiet hour
  and 97% over the full day. Treat any single run as a wide range, not a point.
- **Past fees do not predict future fees.** Volume and volatility are the inputs
  and neither is knowable ahead of time.
- **Time-in-range in `uni-range-apr` is a GBM model** at measured realised vol.
  `uni-range-replay` measures it instead, but only over the window it replays.
- **100% time-in-range flatters the result.** A range that never got breached
  carries no out-of-range haircut; over a month it usually will.
- Within a single swap the price can cross ticks and change liquidity. The event
  reports the final values, so very large swaps are attributed slightly coarsely.
- **The public RPC has a throughput ceiling of roughly a few hundred thousand
  swaps per run.** A 24h replay of a ~1M-swap/day pool needs several hundred
  `eth_getLogs` calls and the public endpoint hard-fails on rate limiting partway
  through, whatever the pacing. Quieter pools finish 24h in about 7 minutes. Past
  that ceiling, shorten `--hours` or point `ROBINHOOD_RPC_URL` at a paid endpoint.

Not financial advice. Verify anything before putting money behind it.

## Reference

Canonical Uniswap deployments for chain 4663:
[Uniswap/contracts/deployments/4663.md](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md)

| Contract | Address |
|---|---|
| UniswapV3Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| TickLens | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` |
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |

Set `ROBINHOOD_RPC_URL` to use your own endpoint instead of the rate-limited
public one.

## Licence

MIT
