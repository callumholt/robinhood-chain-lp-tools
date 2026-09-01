#!/usr/bin/env tsx
/**
 * Uniswap v3 / v4 range-APR calculator for Robinhood Chain (chain 4663).
 *
 * WHAT IT ANSWERS
 *   1. "What is this pool's APR right now?"  -> pool-average APR (fees / total TVL)
 *   2. "What would MY range earn?"           -> APR for a concentrated position
 *
 * HOW (the only honest way to do #2)
 *   Fees are split between in-range liquidity in proportion to liquidity units.
 *   So the APR of a range is NOT a property of the pool - it depends on how much
 *   liquidity YOU add and how tight your range is:
 *
 *     L_you   = capital / valuePerLiquidity(range, current price)
 *     share   = L_you / (L_active + L_you)
 *     fees/yr = volume_24h * 365 * feeRate * lpShareOfFee * share
 *     APR     = fees/yr / capital
 *
 *   Tighter range -> more L per dollar -> bigger share -> higher APR, but the
 *   position also spends less time in range. The vol-adjusted number at the
 *   bottom is the one worth acting on.
 *
 * DATA SOURCES
 *   - Pool state: Robinhood Chain public RPC (v3 pool contract / v4 StateView)
 *   - Volume + TVL + token USD prices: GeckoTerminal public API (network "robinhood")
 *
 * USAGE
 *   npx tsx scripts/robinhood/uni-range-apr.ts --pool <v3 addr | v4 poolId> [opts]
 *
 *     --width 15            symmetric +/-15% range around spot (default)
 *     --range 2000:2600     explicit low:high price range
 *     --invert              quote prices as token0-per-token1 instead
 *     --capital 10000       position size in USD (default 10000)
 *     --window h24|h6|h1    volume window to annualise (default h24)
 *     --horizon 30          days used for the time-in-range estimate (default 30)
 *     --sweep               print an APR-vs-width table instead of one range
 */

import { Command } from "commander"
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem"

const RPC = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"
const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood"
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as const
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const
const NATIVE = "0x0000000000000000000000000000000000000000"

const client = createPublicClient({ transport: http(RPC) })

const v3Abi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
])
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256 feeGrowthGlobal0,uint256 feeGrowthGlobal1)",
])
const erc20Abi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"])
const initializeEvent = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
)

// ---------------------------------------------------------------- pool state

type PoolState = {
  version: "v3" | "v4"
  id: string
  token0: string
  token1: string
  sym0: string
  sym1: string
  dec0: number
  dec1: number
  /** LP fee in hundredths of a bip (500 = 0.05%). */
  feePpm: number
  dynamicFee: boolean
  tickSpacing: number
  tick: number
  sqrtPriceX96: bigint
  /** Liquidity active at the current tick. */
  liquidity: bigint
  /** Fraction of the swap fee that reaches LPs after the protocol cut. */
  lpFeeShare: number
  hooks?: string
}

async function tokenMeta(addr: string) {
  if (addr.toLowerCase() === NATIVE) return { symbol: "ETH", decimals: 18 }
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "symbol" }).catch(() => "???"),
  ])
  return { symbol: symbol as string, decimals: Number(decimals) }
}

async function readV3(pool: string): Promise<PoolState> {
  const p = pool as `0x${string}`
  const [slot0, liquidity, fee, tickSpacing, token0, token1] = await Promise.all([
    client.readContract({ address: p, abi: v3Abi, functionName: "slot0" }),
    client.readContract({ address: p, abi: v3Abi, functionName: "liquidity" }),
    client.readContract({ address: p, abi: v3Abi, functionName: "fee" }),
    client.readContract({ address: p, abi: v3Abi, functionName: "tickSpacing" }),
    client.readContract({ address: p, abi: v3Abi, functionName: "token0" }),
    client.readContract({ address: p, abi: v3Abi, functionName: "token1" }),
  ])
  const [m0, m1] = await Promise.all([tokenMeta(token0), tokenMeta(token1)])
  // v3 feeProtocol packs two 4-bit denominators (x = protocol takes 1/x).
  const fp = Number(slot0[5])
  const denomZeroForOne = fp % 16
  const denomOneForZero = fp >> 4
  const cut = (d: number) => (d === 0 ? 0 : 1 / d)
  const lpFeeShare = 1 - (cut(denomZeroForOne) + cut(denomOneForZero)) / 2
  return {
    version: "v3",
    id: pool,
    token0,
    token1,
    sym0: m0.symbol,
    sym1: m1.symbol,
    dec0: m0.decimals,
    dec1: m1.decimals,
    feePpm: Number(fee),
    dynamicFee: false,
    tickSpacing: Number(tickSpacing),
    tick: Number(slot0[1]),
    sqrtPriceX96: slot0[0],
    liquidity,
    lpFeeShare,
  }
}

async function readV4(poolId: string): Promise<PoolState> {
  const id = poolId as `0x${string}`
  const [slot0, liquidity, logs] = await Promise.all([
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [id] }),
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [id] }),
    client.getLogs({ address: POOL_MANAGER, event: initializeEvent, args: { id }, fromBlock: 0n, toBlock: "latest" }),
  ])
  const init = logs[0]?.args
  if (!init) throw new Error(`no Initialize event for pool ${poolId} - is it a v4 pool on this chain?`)
  const token0 = init.currency0 as string
  const token1 = init.currency1 as string
  const [m0, m1] = await Promise.all([tokenMeta(token0), tokenMeta(token1)])
  // 0x800000 is the dynamic-fee flag; the live fee then lives in slot0.lpFee.
  const staticFee = Number(init.fee)
  const dynamicFee = staticFee === 0x800000
  // protocolFee packs two 12-bit pip values (out of 1e6), one per direction.
  const pf = Number(slot0[2])
  const pfZeroForOne = pf & 0xfff
  const pfOneForZero = pf >> 12
  const lpFeeShare = 1 - (pfZeroForOne + pfOneForZero) / 2 / 1_000_000
  return {
    version: "v4",
    id: poolId,
    token0,
    token1,
    sym0: m0.symbol,
    sym1: m1.symbol,
    dec0: m0.decimals,
    dec1: m1.decimals,
    feePpm: Number(slot0[3]),
    dynamicFee,
    tickSpacing: Number(init.tickSpacing),
    tick: Number(slot0[1]),
    sqrtPriceX96: slot0[0],
    liquidity,
    lpFeeShare,
    hooks: init.hooks as string,
  }
}

// ------------------------------------------------------------ geckoterminal

type MarketData = {
  name: string
  tvlUsd: number
  volume: Record<string, number>
  baseUsd: number
  quoteUsd: number
  baseAddress: string
}

async function fetchMarket(poolKey: string): Promise<MarketData> {
  const res = await fetch(`${GT}/pools/${poolKey}`, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status} for pool ${poolKey}`)
  const json = (await res.json()) as any
  const a = json.data.attributes
  return {
    name: a.name,
    tvlUsd: Number(a.reserve_in_usd),
    volume: Object.fromEntries(Object.entries(a.volume_usd).map(([k, v]) => [k, Number(v)])),
    baseUsd: Number(a.base_token_price_usd),
    quoteUsd: Number(a.quote_token_price_usd),
    baseAddress: String(json.data.relationships.base_token.data.id).split("_")[1],
  }
}

/** Daily realised vol from GeckoTerminal hourly candles. */
let volFailure: string | null = null
async function realisedVol(poolKey: string): Promise<number | null> {
  let res: Response | null = null
  // GeckoTerminal's free tier is ~30 req/min; a 429 here is common, so retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(`${GT}/pools/${poolKey}/ohlcv/hour?aggregate=1&limit=720`, {
      headers: { Accept: "application/json" },
    })
    if (res.ok) break
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2500))
  }
  if (!res?.ok) {
    volFailure = `GeckoTerminal OHLCV returned ${res?.status ?? "no response"}`
    return null
  }
  const list: number[][] = (await res.json())?.data?.attributes?.ohlcv_list ?? []
  const closes = list
    .map((c) => c[4])
    .filter((n) => n > 0)
    .reverse()
  if (closes.length < 48) {
    volFailure = `only ${closes.length} hourly candles available`
    return null
  }
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]))
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)
  return Math.sqrt(variance) * Math.sqrt(24) // hourly -> daily sigma
}

// ------------------------------------------------------- measured fee growth

/**
 * Fees actually accrued per unit of liquidity over the last `blocks` blocks,
 * read straight from feeGrowthGlobal. This is the ground-truth alternative to
 * volume x feeRate:
 *   - already NET of the protocol fee cut
 *   - works on v4 dynamic-fee / hook pools, where the quoted fee rate is 0
 *   - needs no off-chain volume feed
 * The catch is state retention: the public RPC only keeps ~5k blocks (~8 min),
 * so the sample is short and noisy. For a real 24h figure use uni-range-replay,
 * which reads Swap logs instead - those are retained back to genesis, so no
 * archive node is required.
 */
async function measureFeeGrowth(state: PoolState, blocks: bigint) {
  const head = await client.getBlockNumber()
  const past = head - blocks
  const read = async (blockNumber: bigint) => {
    if (state.version === "v4") {
      const r = await client.readContract({
        address: STATE_VIEW,
        abi: stateViewAbi,
        functionName: "getFeeGrowthGlobals",
        args: [state.id as `0x${string}`],
        blockNumber,
      })
      return [r[0], r[1]] as const
    }
    const p = state.id as `0x${string}`
    const [g0, g1] = await Promise.all([
      client.readContract({ address: p, abi: v3Abi, functionName: "feeGrowthGlobal0X128", blockNumber }),
      client.readContract({ address: p, abi: v3Abi, functionName: "feeGrowthGlobal1X128", blockNumber }),
    ])
    return [g0, g1] as const
  }
  const [now, then, bNow, bThen] = await Promise.all([
    read(head),
    read(past),
    client.getBlock({ blockNumber: head }),
    client.getBlock({ blockNumber: past }),
  ])
  const seconds = Number(bNow.timestamp - bThen.timestamp)
  const Q128 = 2 ** 128
  return {
    seconds,
    /** raw token0 fees per unit liquidity over the window */
    d0: Number(now[0] - then[0]) / Q128,
    d1: Number(now[1] - then[1]) / Q128,
  }
}

// ------------------------------------------------------------------- maths

const Q96 = 2 ** 96

/** Human price of token0 expressed in token1 (the Uniswap-native orientation). */
function priceFromSqrt(sqrtPriceX96: bigint, dec0: number, dec1: number) {
  const sqrtP = Number(sqrtPriceX96) / Q96
  return sqrtP * sqrtP * 10 ** (dec0 - dec1)
}

/**
 * Value (in raw token1 units) of one unit of liquidity spread over [sqrtA, sqrtB]
 * at the current sqrt price. This is what converts capital into liquidity units.
 */
function valuePerLiquidity(sqrtP: number, sqrtA: number, sqrtB: number) {
  if (sqrtP <= sqrtA) {
    // all token0
    const amount0 = 1 / sqrtA - 1 / sqrtB
    return amount0 * sqrtP * sqrtP
  }
  if (sqrtP >= sqrtB) return sqrtB - sqrtA // all token1
  const amount0 = 1 / sqrtP - 1 / sqrtB
  const amount1 = sqrtP - sqrtA
  return amount0 * sqrtP * sqrtP + amount1
}

function alignTick(tick: number, spacing: number, dir: "down" | "up") {
  const q = tick / spacing
  return (dir === "down" ? Math.floor(q) : Math.ceil(q)) * spacing
}

function tickToSqrt(tick: number) {
  return Math.sqrt(1.0001 ** tick)
}

/** Monte-Carlo fraction of the horizon a GBM path spends inside [low, high]. */
function timeInRange(spot: number, low: number, high: number, dailySigma: number, days: number) {
  const stepsPerDay = 24
  const steps = Math.round(days * stepsPerDay)
  const dt = 1 / stepsPerDay
  const sigmaStep = dailySigma * Math.sqrt(dt)
  const paths = 4000
  let inRange = 0
  let total = 0
  for (let p = 0; p < paths; p++) {
    let price = spot
    for (let s = 0; s < steps; s++) {
      // Box-Muller
      const u1 = Math.random() || 1e-12
      const u2 = Math.random()
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      price *= Math.exp(-0.5 * sigmaStep * sigmaStep + sigmaStep * z)
      total++
      if (price >= low && price <= high) inRange++
    }
  }
  return inRange / total
}

// -------------------------------------------------------------------- main

type RangeResult = {
  low: number
  high: number
  tickLower: number
  tickUpper: number
  liquidity: number
  share: number
  aprInRange: number
  multiplier: number
}

function evaluateRange(
  state: PoolState,
  market: MarketData,
  lowHuman: number,
  highHuman: number,
  capitalUsd: number,
  annualLpFeesUsd: number,
  poolAvgApr: number,
): RangeResult {
  const sqrtP = Number(state.sqrtPriceX96) / Q96
  const tickLower = alignTick(
    Math.floor(Math.log(lowHuman * 10 ** (state.dec1 - state.dec0)) / Math.log(1.0001)),
    state.tickSpacing,
    "down",
  )
  let tickUpper = alignTick(
    Math.ceil(Math.log(highHuman * 10 ** (state.dec1 - state.dec0)) / Math.log(1.0001)),
    state.tickSpacing,
    "up",
  )
  if (tickUpper <= tickLower) tickUpper = tickLower + state.tickSpacing
  const sqrtA = tickToSqrt(tickLower)
  const sqrtB = tickToSqrt(tickUpper)

  // token1 USD price: GeckoTerminal labels one side "base"; match by address.
  const token1IsBase = market.baseAddress?.toLowerCase() === state.token1.toLowerCase()
  const token1Usd = token1IsBase ? market.baseUsd : market.quoteUsd
  const capitalToken1Raw = (capitalUsd / token1Usd) * 10 ** state.dec1

  const vpl = valuePerLiquidity(sqrtP, sqrtA, sqrtB)
  const myLiquidity = capitalToken1Raw / vpl
  const share = myLiquidity / (Number(state.liquidity) + myLiquidity)
  const aprInRange = (annualLpFeesUsd * share) / capitalUsd
  return {
    low: priceFromSqrt(BigInt(Math.round(sqrtA * Q96)), state.dec0, state.dec1),
    high: priceFromSqrt(BigInt(Math.round(sqrtB * Q96)), state.dec0, state.dec1),
    tickLower,
    tickUpper,
    liquidity: myLiquidity,
    share,
    aprInRange,
    multiplier: poolAvgApr > 0 ? aprInRange / poolAvgApr : Number.NaN,
  }
}

/**
 * Discovery: top pools by 24h volume, with the crude pool-average APR that a
 * screener would show. The fee rate comes from GeckoTerminal's pool name, which
 * is absent on dynamic-fee pools - those show "dyn" and need --measure.
 */
async function listTopPools(dex: string) {
  const url = dex === "all" ? `${GT}/pools?page=1` : `${GT}/dexes/${dex}/pools?page=1`
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status} listing ${dex}`)
  const rows = ((await res.json()) as any).data as any[]
  console.log(`\nTop pools on ${dex} (Robinhood Chain), by 24h volume\n`)
  console.log(
    `pool id                                                             pair                       fee     24h vol      TVL       pool APR`,
  )
  for (const row of rows.slice(0, 15)) {
    const a = row.attributes
    const feeMatch = /([\d.]+)%$/.exec(a.name)
    const feePct = feeMatch ? Number(feeMatch[1]) : null
    const vol = Number(a.volume_usd.h24)
    const tvl = Number(a.reserve_in_usd)
    const apr = feePct && tvl > 0 ? ((vol * (feePct / 100) * 365) / tvl) * 100 : null
    console.log(
      `${a.address.padEnd(68)}${a.name.replace(/ [\d.]+%$/, "").padEnd(26)} ` +
        `${(feePct === null ? "dyn" : feePct + "%").padStart(6)}  ${usd(vol).padStart(9)}  ${usd(tvl).padStart(9)}  ` +
        `${(apr === null ? "needs --measure" : apr.toFixed(0) + "%").padStart(15)}`,
    )
  }
  console.log(`\nThen: npx tsx scripts/robinhood/uni-range-apr.ts --pool <id> --width 10\n`)
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`
const usd = (x: number) =>
  x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toFixed(2)}`

async function main() {
  const program = new Command()
    .option("--top [dex]", "list top pools by volume (dex: uniswap-v3-robinhood | uniswap-v4-robinhood | all)")
    .option("--pool <id>", "v3 pool address (0x…40 hex) or v4 poolId (0x…64 hex)")
    .option("--width <pct>", "symmetric +/-N% range around spot", "15")
    .option("--range <low:high>", "explicit price range, overrides --width")
    .option("--invert", "quote prices as token0 per token1", false)
    .option("--capital <usd>", "position size in USD", "10000")
    .option("--window <w>", "volume window to annualise: h24|h6|h1", "h24")
    .option("--horizon <days>", "days for the time-in-range estimate", "30")
    .option("--sweep", "print an APR-vs-width table", false)
    .option("--measure [blocks]", "cross-check APR from on-chain feeGrowth (default 5000 blocks ~8min)")
    .parse()
  const opts = program.opts()

  if (opts.top !== undefined) {
    await listTopPools(typeof opts.top === "string" ? opts.top : "uniswap-v3-robinhood")
    return
  }
  if (!opts.pool) {
    console.error("--pool is required (or use --top to discover pools)")
    process.exit(1)
  }

  const poolKey: string = opts.pool.toLowerCase()
  const isV4 = poolKey.length === 66
  const [state, market] = await Promise.all([isV4 ? readV4(poolKey) : readV3(poolKey), fetchMarket(poolKey)])

  const spot = priceFromSqrt(state.sqrtPriceX96, state.dec0, state.dec1)
  const show = (p: number) => (opts.invert ? 1 / p : p)
  const orientation = opts.invert ? `${state.sym0} per ${state.sym1}` : `${state.sym1} per ${state.sym0}`

  const windowHours: Record<string, number> = { h24: 24, h6: 6, h1: 1 }
  const hours = windowHours[opts.window] ?? 24
  const windowVolume = market.volume[opts.window] ?? market.volume.h24
  const annualVolume = (windowVolume / hours) * 24 * 365
  const feeRate = state.feePpm / 1_000_000
  const annualLpFeesUsd = annualVolume * feeRate * state.lpFeeShare
  const poolAvgApr = annualLpFeesUsd / market.tvlUsd
  const capital = Number(opts.capital)

  console.log(`\n=== ${market.name}  (Uniswap ${state.version}, Robinhood Chain) ===`)
  console.log(`pool          ${state.id}`)
  if (state.hooks && state.hooks !== NATIVE) console.log(`hooks         ${state.hooks}  <- can change fees/behaviour`)
  console.log(`tokens        ${state.sym0} (${state.dec0}d) / ${state.sym1} (${state.dec1}d)`)
  console.log(
    `fee           ${(feeRate * 100).toFixed(4)}%${state.dynamicFee ? " (DYNAMIC - set by hook, current value)" : ""}` +
      `   LPs keep ${pct(state.lpFeeShare)} of it`,
  )
  console.log(`tick / spacing ${state.tick} / ${state.tickSpacing}`)
  console.log(`spot          ${show(spot).toPrecision(8)}  ${orientation}`)
  console.log(`active liq    ${Number(state.liquidity).toExponential(4)}`)
  console.log(`TVL           ${usd(market.tvlUsd)}`)
  console.log(`volume        24h ${usd(market.volume.h24)} | 6h ${usd(market.volume.h6)} | 1h ${usd(market.volume.h1)}`)
  // A dynamic-fee pool stores lpFee = 0 between swaps, so volume x feeRate is
  // meaningless there - the feeGrowth measurement is the only valid route.
  const volumeMethodValid = state.feePpm > 0
  console.log(`\n--- headline APR (what a pool screener shows) ---`)
  if (volumeMethodValid) {
    console.log(`annualised LP fees   ${usd(annualLpFeesUsd)}   (from ${opts.window} volume)`)
    console.log(`pool-average APR     ${pct(poolAvgApr)}   = LP fees / total TVL`)
    console.log(`  ^ this is a blended number over ALL liquidity, in range or not.`)
    console.log(`    A real position earns its share of fees among ACTIVE liquidity only.`)
  } else {
    console.log(`volume x feeRate is UNUSABLE on this pool: the hook sets the fee per swap`)
    console.log(`and slot0.lpFee reads 0 between swaps. Falling back to feeGrowth measurement.`)
  }

  // Ground-truth cross-check straight from feeGrowthGlobal.
  let measured: { aprPerDollarPerLiquidity: number; seconds: number; poolApr: number } | null = null
  if (opts.measure !== undefined || !volumeMethodValid) {
    const n = typeof opts.measure === "string" ? Number(opts.measure) : 5000
    const blocks = BigInt(Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000)
    try {
      const fg = await measureFeeGrowth(state, blocks)
      const token1IsBase = market.baseAddress?.toLowerCase() === state.token1.toLowerCase()
      const p1 = token1IsBase ? market.baseUsd : market.quoteUsd
      const p0 = token1IsBase ? market.quoteUsd : market.baseUsd
      const usdPerLiquidity = (fg.d0 * p0) / 10 ** state.dec0 + (fg.d1 * p1) / 10 ** state.dec1
      const annual = (usdPerLiquidity * 365 * 86400) / fg.seconds
      measured = {
        aprPerDollarPerLiquidity: annual,
        seconds: fg.seconds,
        poolApr: (annual * Number(state.liquidity)) / market.tvlUsd,
      }
      console.log(`\n--- measured from feeGrowthGlobal (last ${fg.seconds}s, net of protocol fee) ---`)
      console.log(`pool-average APR     ${pct(measured.poolApr)}   <- independent of any volume feed`)
      console.log(`  Short window: treat as a noisy spot rate, not a 24h average.`)
    } catch (e) {
      console.log(`\n(measured cross-check unavailable: ${e instanceof Error ? e.message : e})`)
    }
  }

  const sigma = await realisedVol(poolKey)
  const horizon = Number(opts.horizon)

  const evalWidth = (widthPct: number) => {
    const w = widthPct / 100
    return evaluateRange(state, market, spot * (1 - w), spot * (1 + w), capital, annualLpFeesUsd, poolAvgApr)
  }

  if (opts.sweep) {
    if (!sigma) console.log(`\n(no vol estimate: ${volFailure} - in-range columns will read n/a)`)
    console.log(`\n--- APR vs range width, ${usd(capital)} position ---`)
    console.log(
      `width    range (${orientation})                 share    APR in-range   x pool avg   in-range ${horizon}d   vol-adj APR`,
    )
    for (const w of [1, 2, 5, 10, 15, 20, 30, 50, 80]) {
      const r = evalWidth(w)
      const tir = sigma ? timeInRange(spot, r.low, r.high, sigma, horizon) : Number.NaN
      const lo = show(opts.invert ? r.high : r.low)
      const hi = show(opts.invert ? r.low : r.high)
      console.log(
        `+/-${String(w).padStart(2)}%  ${lo.toPrecision(6).padStart(12)} - ${hi.toPrecision(6).padEnd(12)}  ` +
          `${pct(r.share).padStart(7)}  ${pct(r.aprInRange).padStart(12)}  ${r.multiplier.toFixed(1).padStart(9)}x  ` +
          `${(Number.isNaN(tir) ? "n/a" : pct(tir)).padStart(13)}  ${(Number.isNaN(tir) ? "n/a" : pct(r.aprInRange * tir)).padStart(11)}`,
      )
    }
  } else {
    let low: number
    let high: number
    if (opts.range) {
      const [a, b] = String(opts.range).split(":").map(Number)
      const [lo, hi] = [Math.min(a, b), Math.max(a, b)]
      ;[low, high] = opts.invert ? [1 / hi, 1 / lo] : [lo, hi]
    } else {
      const w = Number(opts.width) / 100
      low = spot * (1 - w)
      high = spot * (1 + w)
    }
    const r = evaluateRange(state, market, low, high, capital, annualLpFeesUsd, poolAvgApr)
    let headlineApr = r.aprInRange
    const tir = sigma ? timeInRange(spot, r.low, r.high, sigma, horizon) : Number.NaN
    console.log(`\n--- your range, ${usd(capital)} position ---`)
    console.log(
      `range            ${show(opts.invert ? r.high : r.low).toPrecision(8)} - ${show(opts.invert ? r.low : r.high).toPrecision(8)}  ${orientation}`,
    )
    console.log(`ticks            [${r.tickLower}, ${r.tickUpper}]  (aligned to spacing ${state.tickSpacing})`)
    console.log(`your liquidity   ${r.liquidity.toExponential(4)}  -> ${pct(r.share)} of active liquidity`)
    if (volumeMethodValid) {
      console.log(`APR while in range   ${pct(r.aprInRange)}   (${r.multiplier.toFixed(1)}x the pool-average APR)`)
      console.log(`fees/day in range    ${usd((r.aprInRange * capital) / 365)}`)
    }
    if (measured) {
      const mApr = (measured.aprPerDollarPerLiquidity * r.liquidity) / capital
      console.log(`APR in range (measured)  ${pct(mApr)}   <- from feeGrowth, ${measured.seconds}s sample`)
      if (!volumeMethodValid) headlineApr = mApr
    }
    if (sigma) {
      console.log(`\nrealised vol     ${pct(sigma)}/day  (${pct(sigma * Math.sqrt(365))} annualised)`)
      console.log(`time in range    ${pct(tir)} expected over ${horizon}d (GBM, no rebalancing)`)
      console.log(`vol-adjusted APR ${pct(headlineApr * tir)}   <-- the number to compare against alternatives`)
      console.log(`  Excludes impermanent loss and rebalancing costs; it is fee yield only.`)
    } else {
      console.log(`\n(no vol estimate: ${volFailure} - time-in-range skipped)`)
    }
  }
  console.log()
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
