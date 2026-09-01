#!/usr/bin/env tsx
/**
 * Exact 24h fee replay for a Uniswap v3/v4 range on Robinhood Chain.
 *
 * WHY THIS EXISTS
 *   uni-range-apr.ts estimates: it takes a third-party 24h volume number, a
 *   quoted fee rate, and the liquidity active RIGHT NOW, then extrapolates.
 *   Three approximations, and it cannot see hook fees or dynamic fees at all.
 *
 *   This script instead replays every Swap event of the last 24h. Each event
 *   carries the amounts, the price, and - critically - the liquidity that was
 *   active at that instant. So for a candidate range we can compute exactly:
 *
 *     for each swap, if tick_at_swap is inside [tickLower, tickUpper]:
 *         feePaid       = |amountIn| * feeRate            (v4 emits the fee directly)
 *         lpFee         = feePaid * lpFeeShare            (net of protocol cut)
 *         yourShare     = L_you / (liquidity_at_swap + L_you)
 *         yourFees     += lpFee * yourShare
 *
 *   No volume feed, no extrapolation, no assumption about where liquidity sat.
 *   Out-of-range swaps contribute zero, so time-in-range is measured, not modelled.
 *
 * PUBLIC RPC LIMITS
 *   State is pruned at ~5k blocks, but LOGS go back to genesis. The only cap is
 *   per-call span (~50k blocks / ~10k logs), so we chunk and halve on failure.
 *
 * USAGE
 *   npx tsx scripts/robinhood/uni-range-replay.ts --pool <addr|poolId> [opts]
 *     --width 10        +/-10% around current spot (default)
 *     --range 2000:2600 explicit price range, overrides --width
 *     --capital 10000   position size in USD
 *     --hours 24        lookback window (default 24)
 *     --validate        also check the replay against feeGrowthGlobal
 */

import { Command } from "commander"
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem"

const RPC = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"
const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood"
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as const
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const
const NATIVE = "0x0000000000000000000000000000000000000000"
const BLOCKS_PER_SEC = 10 // ~0.1s blocks; refined from real timestamps at runtime

// The public RPC rate-limits aggressively (HTTP 429). Transport-level retry
// covers every call, not just the chunked getLogs loop.
const client = createPublicClient({
  transport: http(RPC, { retryCount: 3, retryDelay: 600, timeout: 30_000 }),
})

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
  "function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256,uint256)",
])
const erc20Abi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"])

const v3SwapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
)
const v4SwapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
)
const initializeEvent = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
)

type PoolState = {
  version: "v3" | "v4"
  id: string
  token0: string
  token1: string
  sym0: string
  sym1: string
  dec0: number
  dec1: number
  feePpm: number
  tickSpacing: number
  tick: number
  sqrtPriceX96: bigint
  liquidity: bigint
  /** v3 only: fraction of the swap fee LPs keep after the protocol cut. */
  lpFeeShare: number
  /** v4 only: protocol fee in ppm of the gross input, per direction. */
  protocolFeePpm: { zeroForOne: number; oneForZero: number }
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

async function readPool(id: string): Promise<PoolState> {
  if (id.length === 66) {
    const pid = id as `0x${string}`
    const [slot0, liquidity, logs] = await Promise.all([
      client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [pid] }),
      client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [pid] }),
      client.getLogs({
        address: POOL_MANAGER,
        event: initializeEvent,
        args: { id: pid },
        fromBlock: 0n,
        toBlock: "latest",
      }),
    ])
    const init = logs[0]?.args
    if (!init) throw new Error(`no Initialize event for ${id}`)
    const [m0, m1] = await Promise.all([tokenMeta(init.currency0 as string), tokenMeta(init.currency1 as string)])
    const pf = Number(slot0[2])
    return {
      version: "v4",
      id,
      token0: init.currency0 as string,
      token1: init.currency1 as string,
      sym0: m0.symbol,
      sym1: m1.symbol,
      dec0: m0.decimals,
      dec1: m1.decimals,
      feePpm: Number(slot0[3]),
      tickSpacing: Number(init.tickSpacing),
      tick: Number(slot0[1]),
      sqrtPriceX96: slot0[0],
      liquidity,
      lpFeeShare: 1,
      protocolFeePpm: { zeroForOne: pf & 0xfff, oneForZero: pf >> 12 },
      hooks: init.hooks as string,
    }
  }
  const p = id as `0x${string}`
  const [slot0, liquidity, fee, tickSpacing, token0, token1] = await Promise.all([
    client.readContract({ address: p, abi: v3Abi, functionName: "slot0" }),
    client.readContract({ address: p, abi: v3Abi, functionName: "liquidity" }),
    client.readContract({ address: p, abi: v3Abi, functionName: "fee" }),
    client.readContract({ address: p, abi: v3Abi, functionName: "tickSpacing" }),
    client.readContract({ address: p, abi: v3Abi, functionName: "token0" }),
    client.readContract({ address: p, abi: v3Abi, functionName: "token1" }),
  ])
  const [m0, m1] = await Promise.all([tokenMeta(token0), tokenMeta(token1)])
  const fp = Number(slot0[5])
  const cut = (d: number) => (d === 0 ? 0 : 1 / d)
  return {
    version: "v3",
    id,
    token0,
    token1,
    sym0: m0.symbol,
    sym1: m1.symbol,
    dec0: m0.decimals,
    dec1: m1.decimals,
    feePpm: Number(fee),
    tickSpacing: Number(tickSpacing),
    tick: Number(slot0[1]),
    sqrtPriceX96: slot0[0],
    liquidity,
    lpFeeShare: 1 - (cut(fp % 16) + cut(fp >> 4)) / 2,
    protocolFeePpm: { zeroForOne: 0, oneForZero: 0 },
  }
}

// ------------------------------------------------------------- swap fetching

type SwapRow = {
  block: bigint
  amount0: bigint
  amount1: bigint
  liquidity: bigint
  tick: number
  /** fee rate in ppm at the time of the swap (v4 emits it; v3 is static) */
  feePpm: number
}

/**
 * Fetch every Swap in [fromBlock, toBlock], chunking around the RPC's per-call
 * span and log-count caps. Halves the chunk on failure rather than giving up.
 */
/** The RPC refuses somewhere near 10k logs per response; aim comfortably under. */
const TARGET_LOGS = 7500
const MIN_CHUNK = 250n
const MAX_CHUNK = 40_000n

function isRateLimit(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${(e as any).details ?? ""}` : String(e)
  return /429|too many requests|rate limit/i.test(msg)
}

/**
 * Fetch every Swap in [fromBlock, toBlock].
 *
 * The public RPC imposes two DIFFERENT limits and they need opposite responses:
 *
 *   - Range/log-count cap  -> the chunk is too big. Shrink it.
 *   - Rate limit (HTTP 429) -> we are asking too fast. Slow down and retry the
 *     SAME chunk. Shrinking here is actively harmful: it multiplies the number
 *     of requests, which causes more 429s. (An earlier version did exactly that
 *     and spent 72 minutes in backoff to fetch a 24h window.)
 *
 * So we adapt the delay to the observed rate limit and only resize on real range
 * errors, decaying the delay back down after sustained success.
 */
async function streamSwaps(
  state: PoolState,
  fromBlock: bigint,
  toBlock: bigint,
  onSwap: (row: SwapRow) => void,
): Promise<number> {
  let seen = 0
  let chunk = 20_000n
  let delayMs = 150
  let cursor = fromBlock
  let calls = 0
  let cleanStreak = 0
  const total = Math.max(1, Number(toBlock - fromBlock))
  const started = Date.now()

  const getChunk = (from: bigint, to: bigint) =>
    state.version === "v4"
      ? client.getLogs({
          address: POOL_MANAGER,
          event: v4SwapEvent,
          args: { id: state.id as `0x${string}` },
          fromBlock: from,
          toBlock: to,
        })
      : client.getLogs({ address: state.id as `0x${string}`, event: v3SwapEvent, fromBlock: from, toBlock: to })

  while (cursor <= toBlock) {
    const end = cursor + chunk - 1n > toBlock ? toBlock : cursor + chunk - 1n
    let logs: Awaited<ReturnType<typeof getChunk>> | null = null
    let rangeError = false

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        logs = await getChunk(cursor, end)
        break
      } catch (e) {
        if (isRateLimit(e)) {
          delayMs = Math.min(2000, Math.round(delayMs * 1.6) + 50) // ease off, keep the chunk
          cleanStreak = 0
          await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)))
          continue
        }
        rangeError = true // genuinely too much data for one call
        break
      }
    }

    if (!logs) {
      if (!rangeError) throw new Error(`getLogs kept rate-limiting near block ${cursor}; try ROBINHOOD_RPC_URL`)
      if (chunk <= MIN_CHUNK) throw new Error(`getLogs failed even at ${chunk}-block chunks near ${cursor}`)
      chunk = chunk / 4n < MIN_CHUNK ? MIN_CHUNK : chunk / 4n
      cleanStreak = 0
      continue
    }

    calls++
    // Fold each log into the caller's accumulators immediately and drop it. A
    // busy pool emits ~1M swaps a day; buffering them all exhausts the heap and
    // the process dies without an error, so nothing is ever retained here.
    for (const l of logs) {
      const a = l.args as any
      onSwap({
        block: l.blockNumber as bigint,
        amount0: a.amount0 as bigint,
        amount1: a.amount1 as bigint,
        liquidity: a.liquidity as bigint,
        tick: Number(a.tick),
        feePpm: state.version === "v4" ? Number(a.fee) : state.feePpm,
      })
      seen++
    }
    cursor = end + 1n

    // Size the NEXT chunk from observed log density rather than creeping upward
    // and rediscovering the cap. A busy pool packs >1 log per block, so a blind
    // 40k-block request always overflows the ~10k-log cap: the chunk grows, the
    // call fails, it halves back, and most requests are wasted on the discovery.
    // Aiming at TARGET_LOGS converges in one step and keeps every call useful.
    const got = logs.length
    if (got > 0) {
      const scaled = (chunk * BigInt(TARGET_LOGS)) / BigInt(Math.max(got, 1))
      chunk = scaled < MIN_CHUNK ? MIN_CHUNK : scaled > MAX_CHUNK ? MAX_CHUNK : scaled
    } else if (chunk < MAX_CHUNK) {
      chunk *= 2n // empty stretch, cover ground faster
      if (chunk > MAX_CHUNK) chunk = MAX_CHUNK
    }
    if (++cleanStreak >= 5) {
      delayMs = Math.max(120, Math.round(delayMs * 0.8))
      cleanStreak = 0
    }
    if (calls % 5 === 0) {
      const done = Number(cursor - fromBlock) / total
      const secs = (Date.now() - started) / 1000
      const eta = done > 0 ? (secs / done) * (1 - done) : 0
      process.stderr.write(
        `\r  replaying swaps ${(done * 100).toFixed(0)}%  ${seen} logs  ${delayMs}ms/call  eta ${eta.toFixed(0)}s    `,
      )
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  process.stderr.write(
    `\r  replayed ${seen} swaps in ${calls} calls, ${((Date.now() - started) / 1000).toFixed(0)}s${" ".repeat(20)}\n`,
  )
  return seen
}

// -------------------------------------------------------------------- maths

const Q96 = 2 ** 96
const priceFromSqrt = (s: bigint, d0: number, d1: number) => (Number(s) / Q96) ** 2 * 10 ** (d0 - d1)
const tickToSqrt = (t: number) => Math.sqrt(1.0001 ** t)
const alignTick = (t: number, sp: number, dir: "down" | "up") =>
  (dir === "down" ? Math.floor(t / sp) : Math.ceil(t / sp)) * sp

function valuePerLiquidity(sqrtP: number, sqrtA: number, sqrtB: number) {
  if (sqrtP <= sqrtA) return (1 / sqrtA - 1 / sqrtB) * sqrtP * sqrtP
  if (sqrtP >= sqrtB) return sqrtB - sqrtA
  return (1 / sqrtP - 1 / sqrtB) * sqrtP * sqrtP + (sqrtP - sqrtA)
}

/**
 * Split a swap into its input leg and the fee rate that actually reaches LPs.
 *
 * The two protocol versions disagree on BOTH points, and getting either wrong
 * silently skews the answer (this is what `--validate` is for):
 *
 *   v3: amount0/amount1 are the POOL's deltas, so the positive leg is the input.
 *       fee() is already the LP-facing rate; slot0.feeProtocol says what fraction
 *       of that the protocol skims (1/4 on Robinhood Chain).
 *
 *   v4: amount0/amount1 are the SWAPPER's deltas, so the NEGATIVE leg is the
 *       input. The event's `fee` is the TOTAL charged, i.e. protocol + LP. Since
 *       total = phi + (1 - phi) * lambda, the LP's cut of the gross input is just
 *       (total - phi) - which also recovers the right rate on dynamic-fee pools
 *       where lambda changes per swap.
 */
function swapInputAndLpRate(state: PoolState, s: SwapRow) {
  if (state.version === "v3") {
    return {
      in0: s.amount0 > 0n ? Number(s.amount0) : 0,
      in1: s.amount1 > 0n ? Number(s.amount1) : 0,
      lpRate: (s.feePpm / 1_000_000) * state.lpFeeShare,
    }
  }
  const zeroForOne = s.amount0 < 0n
  const phi = zeroForOne ? state.protocolFeePpm.zeroForOne : state.protocolFeePpm.oneForZero
  return {
    in0: s.amount0 < 0n ? -Number(s.amount0) : 0,
    in1: s.amount1 < 0n ? -Number(s.amount1) : 0,
    lpRate: Math.max(0, s.feePpm - phi) / 1_000_000,
  }
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`
const usd = (x: number) =>
  Math.abs(x) >= 1e6
    ? `$${(x / 1e6).toFixed(2)}M`
    : Math.abs(x) >= 1e3
      ? `$${(x / 1e3).toFixed(1)}k`
      : `$${x.toFixed(2)}`

// --------------------------------------------------------------------- main

async function main() {
  const opts = new Command()
    .requiredOption("--pool <id>", "v3 pool address or v4 poolId")
    .option("--width <pct>", "symmetric +/-N% range", "10")
    .option("--range <low:high>", "explicit price range")
    .option("--capital <usd>", "position size in USD", "10000")
    .option("--hours <h>", "lookback window in hours", "24")
    .option("--validate", "cross-check the replay against feeGrowthGlobal", false)
    .parse()
    .opts()

  const state = await readPool(String(opts.pool).toLowerCase())
  const head = await client.getBlockNumber()
  const hours = Number(opts.hours)
  const span = BigInt(Math.round(hours * 3600 * BLOCKS_PER_SEC))
  const fromBlock = head > span ? head - span : 0n

  // Token USD prices (only used to value the fees at the end).
  const gt = await fetch(`${GT}/pools/${state.id}`, { headers: { Accept: "application/json" } })
  if (!gt.ok) throw new Error(`GeckoTerminal ${gt.status}`)
  const gtJson = (await gt.json()) as any
  const attrs = gtJson.data.attributes
  const baseAddr = String(gtJson.data.relationships.base_token.data.id).split("_")[1] ?? ""
  const token1IsBase = baseAddr.toLowerCase() === state.token1.toLowerCase()
  const price1Usd = Number(token1IsBase ? attrs.base_token_price_usd : attrs.quote_token_price_usd)
  const price0Usd = Number(token1IsBase ? attrs.quote_token_price_usd : attrs.base_token_price_usd)

  const spot = priceFromSqrt(state.sqrtPriceX96, state.dec0, state.dec1)
  let low: number
  let high: number
  if (opts.range) {
    const [a, b] = String(opts.range).split(":").map(Number)
    low = Math.min(a, b)
    high = Math.max(a, b)
  } else {
    const w = Number(opts.width) / 100
    low = spot * (1 - w)
    high = spot * (1 + w)
  }
  const tickLower = alignTick(
    Math.floor(Math.log(low * 10 ** (state.dec1 - state.dec0)) / Math.log(1.0001)),
    state.tickSpacing,
    "down",
  )
  const tickUpper = alignTick(
    Math.ceil(Math.log(high * 10 ** (state.dec1 - state.dec0)) / Math.log(1.0001)),
    state.tickSpacing,
    "up",
  )
  const sqrtA = tickToSqrt(tickLower)
  const sqrtB = tickToSqrt(tickUpper)
  const sqrtP = Number(state.sqrtPriceX96) / Q96

  const capital = Number(opts.capital)
  const capitalToken1Raw = (capital / price1Usd) * 10 ** state.dec1
  const myL = capitalToken1Raw / valuePerLiquidity(sqrtP, sqrtA, sqrtB)

  console.log(`\n=== ${attrs.name}  (Uniswap ${state.version}, Robinhood Chain) ===`)
  console.log(`pool     ${state.id}`)
  console.log(`window   last ${hours}h  (blocks ${fromBlock} - ${head})`)
  console.log(`spot     ${spot.toPrecision(8)} ${state.sym1} per ${state.sym0}`)
  console.log(`range    ${low.toPrecision(8)} - ${high.toPrecision(8)}   ticks [${tickLower}, ${tickUpper}]`)
  console.log(`capital  ${usd(capital)}  ->  liquidity ${myL.toExponential(4)}`)
  console.log(
    state.version === "v3"
      ? `LPs keep ${pct(state.lpFeeShare)} of swap fees (protocol cut applied)\n`
      : `protocol fee ${state.protocolFeePpm.zeroForOne}/${state.protocolFeePpm.oneForZero} ppm of input, deducted before the LP share\n`,
  )

  // Accumulators, folded in as swaps stream past (nothing is buffered).

  // --- replay ---------------------------------------------------------------
  let vol0 = 0
  let vol1 = 0
  let poolFee0 = 0
  let poolFee1 = 0
  let myFee0 = 0
  let myFee1 = 0
  let inRangeSwaps = 0
  let inRangeBlocks = 0
  let prevBlock = fromBlock
  let prevTick = state.tick
  let feePpmSum = 0

  let first = true
  const swapCount = await streamSwaps(state, fromBlock, head, (s) => {
    if (first) {
      prevTick = s.tick
      first = false
    }
    // Time weighting: price held prevTick from prevBlock until this swap.
    if (prevTick >= tickLower && prevTick < tickUpper) inRangeBlocks += Number(s.block - prevBlock)
    prevBlock = s.block
    prevTick = s.tick

    const { in0, in1, lpRate } = swapInputAndLpRate(state, s)
    feePpmSum += s.feePpm
    vol0 += in0
    vol1 += in1
    const fee0 = in0 * lpRate
    const fee1 = in1 * lpRate
    poolFee0 += fee0
    poolFee1 += fee1

    if (s.tick >= tickLower && s.tick < tickUpper) {
      inRangeSwaps++
      // Had we been in the pool, active liquidity would have been higher by myL.
      const share = myL / (Number(s.liquidity) + myL)
      myFee0 += fee0 * share
      myFee1 += fee1 * share
    }
  })
  if (swapCount === 0) throw new Error("no swaps in window")
  if (prevTick >= tickLower && prevTick < tickUpper) inRangeBlocks += Number(head - prevBlock)

  const toUsd0 = (raw: number) => (raw / 10 ** state.dec0) * price0Usd
  const toUsd1 = (raw: number) => (raw / 10 ** state.dec1) * price1Usd
  const volumeUsd = toUsd0(vol0) + toUsd1(vol1)
  const poolFeesUsd = toUsd0(poolFee0) + toUsd1(poolFee1)
  const myFeesUsd = toUsd0(myFee0) + toUsd1(myFee1)
  const totalBlocks = Number(head - fromBlock)
  const timeInRange = inRangeBlocks / totalBlocks
  const annualiser = (365 * 24) / hours

  console.log(`--- what actually happened, last ${hours}h ---`)
  console.log(`swaps            ${swapCount.toLocaleString()}  (${inRangeSwaps.toLocaleString()} inside your range)`)
  console.log(`volume (in-legs) ${usd(volumeUsd)}    GeckoTerminal says ${usd(Number(attrs.volume_usd.h24))}`)
  console.log(`LP fees, whole pool ${usd(poolFeesUsd)}`)
  if (state.version === "v4")
    console.log(`mean fee rate    ${(feePpmSum / swapCount / 10_000).toFixed(4)}%  (per-swap, from the event)`)
  console.log(`time in range    ${pct(timeInRange)}  (block-weighted, measured not modelled)`)
  console.log()
  console.log(`--- your ${usd(capital)} position over that window ---`)
  console.log(
    `fees earned      ${usd(myFeesUsd)}   = ${state.sym0} ${(myFee0 / 10 ** state.dec0).toPrecision(6)} + ${state.sym1} ${(myFee1 / 10 ** state.dec1).toPrecision(6)}`,
  )
  console.log(`return           ${pct(myFeesUsd / capital)} over ${hours}h`)
  console.log(`annualised APR   ${pct((myFeesUsd * annualiser) / capital)}   <-- realised, not extrapolated`)
  console.log(
    poolFeesUsd > 0
      ? `share of pool fees ${pct(myFeesUsd / poolFeesUsd)}`
      : `share of pool fees n/a - the pool accrued NO LP fees in this window`,
  )
  if (poolFeesUsd === 0 && swapCount > 0) {
    console.log(`  ${swapCount} swaps happened but none paid LP fees. On a hooked v4 pool this`)
    console.log(`  usually means the hook captures the fee. Providing liquidity here earns nothing.`)
  }

  if (opts.validate) {
    // Replay the last 4000 blocks and compare with the feeGrowthGlobal delta over
    // exactly the same range. They measure the same thing by different routes, so
    // agreement validates the sign conventions, fee rate and protocol-fee handling.
    // Self-contained window. A 24h fetch takes minutes, by which time head-3000
    // has been pruned, so re-read the head AND re-fetch that window's swaps: the
    // feeGrowth delta and the replayed swaps must cover exactly the same blocks
    // or the comparison is off by whatever traded in between.
    const vHead = await client.getBlockNumber()
    const vFrom = vHead - 3000n
    let g0 = 0
    let g1 = 0
    let vCount = 0
    await streamSwaps(state, vFrom + 1n, vHead, (s) => {
      if (s.block > vHead) return
      const { in0, in1, lpRate } = swapInputAndLpRate(state, s)
      g0 += (in0 * lpRate) / Number(s.liquidity)
      g1 += (in1 * lpRate) / Number(s.liquidity)
      vCount++
    })
    if (vCount === 0) {
      console.log("\n(validation skipped: no swaps in the state-retention window)")
      console.log()
      return
    }
    const read = async (bn: bigint) =>
      state.version === "v4"
        ? await client.readContract({
            address: STATE_VIEW,
            abi: stateViewAbi,
            functionName: "getFeeGrowthGlobals",
            args: [state.id as `0x${string}`],
            blockNumber: bn,
          })
        : ((await Promise.all([
            client.readContract({
              address: state.id as `0x${string}`,
              abi: v3Abi,
              functionName: "feeGrowthGlobal0X128",
              blockNumber: bn,
            }),
            client.readContract({
              address: state.id as `0x${string}`,
              abi: v3Abi,
              functionName: "feeGrowthGlobal1X128",
              blockNumber: bn,
            }),
          ])) as [bigint, bigint])
    const [now, then] = await Promise.all([read(vHead), read(vFrom)])
    const Q128 = 2 ** 128
    const chain0 = Number(now[0] - then[0]) / Q128
    const chain1 = Number(now[1] - then[1]) / Q128
    console.log(`\n--- validation: replay vs feeGrowthGlobal, blocks ${vFrom + 1n}-${vHead} ---`)
    const line = (sym: string, replay: number, chain: number) =>
      chain === 0
        ? `fee growth ${sym}:  replay ${replay.toExponential(6)}  chain 0 - POOL ACCRUED NOTHING`
        : `fee growth ${sym}:  replay ${replay.toExponential(6)}  chain ${chain.toExponential(6)}  ratio ${(replay / chain).toFixed(4)}`
    console.log(line(state.sym0, g0, chain0))
    console.log(line(state.sym1, g1, chain1))
    if (chain0 === 0 && chain1 === 0) {
      if (g0 > 0 || g1 > 0) {
        console.log(`  WARNING: swaps happened and the replay expected LP fees, but the pool's`)
        console.log(`  own fee growth did not move. On a hooked v4 pool that usually means the`)
        console.log(`  HOOK is taking the fee, so LPs earn nothing. Do not trust the APR above.`)
      } else {
        console.log(`  No fee-earning swaps in the retention window, so this run proves nothing`)
        console.log(`  either way. Re-run against a pool with live flow.`)
      }
    } else {
      console.log(`  Ratios near 1.0 confirm the fee maths, sign convention and protocol-fee cut.`)
    }
  }
  console.log()
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
