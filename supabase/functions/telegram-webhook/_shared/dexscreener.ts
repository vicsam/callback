// Shared DexScreener client — used by both telegram-webhook (Segment 2) and
// process-followups (Segment 4). Keep this the single source of truth; do
// not fork copies into either function.

export interface TokenStats {
  symbol: string;
  priceUsd: number;
  fdv: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  volume1h: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  pairAddress: string;
  dexId: string;
  chartUrl: string;
  chain: string;
}

export function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function shortenAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// DexScreener's tokens endpoint takes a chainId in the path and returns a
// bare array of matching pairs (not wrapped in a `pairs` key). An unknown
// or invalid address returns 200 with an empty array, not a 404.
export async function getTokenStats(chain: string, address: string): Promise<TokenStats | null> {
  const url = `https://api.dexscreener.com/tokens/v1/${chain}/${address}`;

  let pairs: any[];
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    pairs = await res.json();
  } catch {
    return null;
  }

  if (!Array.isArray(pairs) || pairs.length === 0) {
    return null;
  }

  // A token can have multiple pairs (e.g. paired with SOL and with USDC).
  // Report the one with the highest liquidity as canonical.
  const best = pairs.reduce((a, b) => {
    const liqA = a?.liquidity?.usd ?? 0;
    const liqB = b?.liquidity?.usd ?? 0;
    return liqB > liqA ? b : a;
  });

  const priceUsd = Number(best.priceUsd);
  if (!Number.isFinite(priceUsd)) return null;

  return {
    symbol: best.baseToken?.symbol ?? shortenAddress(address),
    priceUsd,
    fdv: numOrNull(best.fdv),
    liquidityUsd: numOrNull(best.liquidity?.usd),
    volume24h: numOrNull(best.volume?.h24),
    volume1h: numOrNull(best.volume?.h1),
    priceChange1h: numOrNull(best.priceChange?.h1),
    priceChange24h: numOrNull(best.priceChange?.h24),
    pairAddress: best.pairAddress,
    dexId: best.dexId,
    chartUrl: best.url ?? `https://dexscreener.com/${chain}/${best.pairAddress}`,
    chain,
  };
}
