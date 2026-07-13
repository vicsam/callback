// Blockscout Pro API fallback — used only when GoPlus (_shared/../getRugRiskData
// in index.ts) has no coverage for a chain. Blockscout covers 120+ EVM chains
// but does NOT offer honeypot detection, mint/ownership-renounced flags, LP
// lock %, or buy/sell tax — those are GoPlus-specific automated checks that
// would require trade simulation or deep contract-state parsing to replicate.
// This module only surfaces the two things Blockscout gives us directly:
// contract verification status and top-10 holder concentration. Do not expand
// its scope to try to approximate GoPlus's full checks.
//
// Auth: BLOCKSCOUT_API_KEY env var, sent as ?apikey=... (key format:
// "proapi_..."). Requests without a key return 402, not a soft rate limit —
// confirmed live. Base URL is chain-scoped by path segment:
// https://api.blockscout.com/{chainId}/api/v2/...

const BLOCKSCOUT_API_KEY = Deno.env.get("BLOCKSCOUT_API_KEY");

// Extend as we discover more chains our community trades on. Chain IDs are
// Blockscout's own (same as the EVM chain ID standard) — not to be confused
// with GoPlus's chain_id mapping in index.ts, which is separate.
const BLOCKSCOUT_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  robinhood: 4663,
};

export interface BlockscoutFallback {
  source: "blockscout";
  contractVerified: boolean | null;
  top10HolderPct: number | null;
  holderCount: number | null;
}

export async function getBlockscoutFallback(
  chain: string,
  address: string,
): Promise<BlockscoutFallback | null> {
  if (!BLOCKSCOUT_API_KEY) return null;

  const chainId = BLOCKSCOUT_CHAIN_IDS[chain];
  if (!chainId) return null;

  const [contractVerified, holderData] = await Promise.all([
    getContractVerified(chainId, address),
    getTopHolderConcentration(chainId, address),
  ]);

  // If both individual lookups came back empty, there's nothing useful to
  // show — fall through to the plain "no data available" path rather than
  // rendering an all-n/a partial section.
  if (contractVerified === null && holderData === null) return null;

  return {
    source: "blockscout",
    contractVerified,
    top10HolderPct: holderData?.top10HolderPct ?? null,
    holderCount: holderData?.holderCount ?? null,
  };
}

async function getContractVerified(chainId: number, address: string): Promise<boolean | null> {
  const url = `https://api.blockscout.com/${chainId}/api/v2/smart-contracts/${address}?apikey=${BLOCKSCOUT_API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null; // 404 = not a contract Blockscout knows about, or unindexed
    const body = await res.json();
    // Verified contracts include "is_verified": true plus name/ABI/compiler
    // fields; unverified contracts omit is_verified entirely rather than
    // sending it as false — treat "not present" the same as "false".
    return body?.is_verified === true;
  } catch {
    return null;
  }
}

async function getTopHolderConcentration(
  chainId: number,
  address: string,
): Promise<{ top10HolderPct: number; holderCount: number } | null> {
  const tokenUrl = `https://api.blockscout.com/${chainId}/api/v2/tokens/${address}?apikey=${BLOCKSCOUT_API_KEY}`;
  const holdersUrl = `https://api.blockscout.com/${chainId}/api/v2/tokens/${address}/holders?apikey=${BLOCKSCOUT_API_KEY}`;

  let totalSupplyRaw: string | null = null;
  let holderCount: number | null = null;
  try {
    const res = await fetch(tokenUrl);
    if (!res.ok) return null;
    const body = await res.json();
    totalSupplyRaw = body?.total_supply ?? null;
    holderCount = body?.holders_count != null ? Number(body.holders_count) : null;
  } catch {
    return null;
  }

  if (!totalSupplyRaw) return null;

  let holderItems: any[];
  try {
    const res = await fetch(holdersUrl);
    if (!res.ok) return null;
    const body = await res.json();
    holderItems = Array.isArray(body?.items) ? body.items : [];
  } catch {
    return null;
  }

  if (holderItems.length === 0) return null;

  // Holder `value` and token `total_supply` are both raw base-unit integers
  // (same decimals), so they cancel out in the ratio — no need to apply
  // `decimals` ourselves. These numbers can exceed JS's safe integer range,
  // so sum with BigInt and only convert to a float at the very end.
  try {
    const totalSupply = BigInt(totalSupplyRaw);
    if (totalSupply === 0n) return null;

    const top10Sum = holderItems
      .slice(0, 10)
      .reduce((sum: bigint, item: any) => sum + BigInt(item.value ?? "0"), 0n);

    // Scale by 1e6 before dividing to keep two decimal places of precision
    // through the BigInt division, then convert to a percentage float.
    const pctScaled = (top10Sum * 1_000_000n) / totalSupply;
    const top10HolderPct = Number(pctScaled) / 10_000;

    return { top10HolderPct, holderCount: holderCount ?? holderItems.length };
  } catch {
    return null;
  }
}
