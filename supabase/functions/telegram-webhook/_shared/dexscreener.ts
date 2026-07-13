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

// An EVM-shaped address (0x + 40 hex) is not chain-specific — the same
// address format can exist on Ethereum, Base, BSC, or any other EVM chain
// (and, as observed live, sometimes even collides with an unrelated token
// deployed at the identical address on a completely different chain, e.g.
// PulseChain). There is no way to know which chain a dropped CA belongs to
// from the address text alone, so we don't ask DexScreener for one chain —
// we search the address across all chains it queries and let the response
// tell us which chain(s) actually have it. Legacy endpoint chosen deliberately
// over /tokens/v1/{chainId}/{address} because it doesn't require a chain
// upfront. Response is `{schemaVersion, pairs: [...] | null}` — `pairs` is
// null (not an empty array) when nothing matches anywhere.
export async function getTokenStats(address: string): Promise<TokenStats | null> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;

  let body: { pairs?: any[] | null };
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }

  const pairs = body?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return null;
  }

  // A token can have multiple pairs across multiple chains and DEXes.
  // Report the one with the highest liquidity as canonical, and trust its
  // chainId as the token's real chain — never the regex-guessed one.
  const best = pairs.reduce((a, b) => {
    const liqA = a?.liquidity?.usd ?? 0;
    const liqB = b?.liquidity?.usd ?? 0;
    return liqB > liqA ? b : a;
  });

  const priceUsd = Number(best.priceUsd);
  if (!Number.isFinite(priceUsd)) return null;

  const chain = best.chainId ?? "unknown";

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
