import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getTokenStats, shortenAddress } from "./_shared/dexscreener.ts";
import { escapeMarkdown, formatCompactNumber, formatPercent, formatPrice } from "./_shared/format.ts";
import { getCallPerformance } from "./_shared/performance.ts";
import { type BlockscoutFallback, getBlockscoutFallback } from "./_shared/blockscout.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SOLANA_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const EVM_RE = /0x[a-fA-F0-9]{40}/g;

// `addressKind` is a structural classification only — "is this shaped like
// an EVM address or a Solana address" — never a specific chain. An EVM-shaped
// address (0x + 40 hex) is valid on Ethereum, Base, BSC, and dozens of other
// EVM chains; there is no way to tell which one from the text alone. The
// actual chain is discovered later from DexScreener's response (see
// getTokenStats in _shared/dexscreener.ts) and is what actually gets stored
// and displayed. addressKind only decides which GoPlus API shape to call
// (Solana's and EVM's are structurally different) — it is not a source of
// truth for chain identity.
interface DetectedCa {
  address: string;
  addressKind: "solana" | "evm";
}

function detectCas(text: string): DetectedCa[] {
  const results: DetectedCa[] = [];

  const evmMatches = text.match(EVM_RE) ?? [];
  for (const address of evmMatches) {
    results.push({ address, addressKind: "evm" });
  }

  // Strip EVM matches before running the Solana regex so a 0x... address
  // isn't also picked up as a base58-ish Solana match.
  const textWithoutEvm = text.replace(EVM_RE, " ");
  const solanaMatches = textWithoutEvm.match(SOLANA_RE) ?? [];
  for (const address of solanaMatches) {
    results.push({ address, addressKind: "solana" });
  }

  return results;
}

async function sendTelegramReply(
  chatId: number,
  messageId: number,
  text: string,
  parseMode?: "Markdown",
): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: messageId,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    }),
  });
  if (!res.ok) {
    console.error(`sendMessage failed (${res.status}): ${await res.text()}`);
  }
  return res.ok;
}

// --- GoPlus rug-risk data -------------------------------------------------
//
// GoPlus's public API works without an API key/auth header for these
// endpoints (verified live July 2026) — no TELEGRAM_BOT_TOKEN-style secret
// needed. Solana and EVM chains use *different* endpoints with different
// response shapes:
//   EVM:    GET /api/v1/token_security/{chain_id}?contract_addresses=...
//   Solana: GET /api/v1/solana/token_security?contract_addresses=...
// Both return {code, message, result}. `result` is null when GoPlus has no
// data yet for the address (too new / not indexed / malformed) — this is
// not an error, just "no data available."

interface RugRiskData {
  mintRenounced: boolean | null;
  freezeRenounced: boolean | null;
  ownershipRenounced: boolean | null;
  isHoneypot: boolean | null;
  buyTax: number | null;
  sellTax: number | null;
  lpLockedPct: number | null;
  holderCount: number | null;
  top10HolderPct: number | null;
}

// `chain` here must be the chain DISCOVERED from getTokenStats's DexScreener
// response, not the addressKind guess — GoPlus needs the real chain to query
// the right EVM network.
async function getRugRiskData(addressKind: "solana" | "evm", chain: string, address: string): Promise<RugRiskData | null> {
  if (addressKind === "solana") {
    return getSolanaRugRiskData(address);
  }
  return getEvmRugRiskData(chain, address);
}

async function fetchGoPlus(url: string): Promise<any | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.code !== 1 || !body.result) return null;
    return body.result;
  } catch {
    return null;
  }
}

async function getSolanaRugRiskData(address: string): Promise<RugRiskData | null> {
  const url = `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`;
  const result = await fetchGoPlus(url);
  if (!result) return null;

  const entry = result[address] ?? Object.values(result)[0];
  if (!entry) return null;

  // Solana LP tokens are typically burned rather than "locked" in a
  // contract. Not every pool reports burn_percent (e.g. some Orca pools
  // return null), so average across only the pools that do, weighted by
  // TVL, rather than picking a single deepest pool that might be null.
  const dexPools: any[] = Array.isArray(entry.dex) ? entry.dex : [];
  const poolsWithBurnData = dexPools.filter((p) => p?.burn_percent != null);
  let lpLockedPct: number | null = null;
  if (poolsWithBurnData.length > 0) {
    const totalTvl = poolsWithBurnData.reduce((sum, p) => sum + Number(p.tvl ?? 0), 0);
    lpLockedPct = totalTvl > 0
      ? poolsWithBurnData.reduce(
        (sum, p) => sum + Number(p.burn_percent) * (Number(p.tvl ?? 0) / totalTvl),
        0,
      )
      : Number(poolsWithBurnData[0].burn_percent);
  }

  const holders: any[] = Array.isArray(entry.holders) ? entry.holders : [];
  const top10HolderPct = holders.length > 0
    ? holders.slice(0, 10).reduce((sum, h) => sum + Number(h.percent ?? 0), 0) * 100
    : null;

  return {
    mintRenounced: entry.mintable?.status != null ? entry.mintable.status === "0" : null,
    freezeRenounced: entry.freezable?.status != null ? entry.freezable.status === "0" : null,
    ownershipRenounced: null, // not applicable to Solana SPL tokens
    isHoneypot: null, // not applicable the same way on Solana
    buyTax: null,
    sellTax: null,
    lpLockedPct,
    holderCount: entry.holder_count != null ? Number(entry.holder_count) : null,
    top10HolderPct,
  };
}

async function getEvmRugRiskData(chain: string, address: string): Promise<RugRiskData | null> {
  // Do NOT default an unmapped chain to Ethereum's chainId ("1") — that would
  // silently query GoPlus for the wrong network and could return misleading
  // data for an address that happens to collide across chains. A chain
  // GoPlus doesn't have a mapping for (e.g. a niche appchain) should fall
  // through to the existing "no data available" path instead.
  const chainId = EVM_CHAIN_IDS[chain];
  if (!chainId) return null;
  const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`;
  const result = await fetchGoPlus(url);
  if (!result) return null;

  const entry = result[address.toLowerCase()] ?? Object.values(result)[0];
  if (!entry) return null;

  const lpHolders: any[] = Array.isArray(entry.lp_holders) ? entry.lp_holders : [];
  const lpLockedPct = lpHolders.length > 0
    ? lpHolders
      .filter((h) => h.is_locked === 1 || h.is_locked === "1")
      .reduce((sum, h) => sum + Number(h.percent ?? 0), 0) * 100
    : null;

  const holders: any[] = Array.isArray(entry.holders) ? entry.holders : [];
  const top10HolderPct = holders.length > 0
    ? holders.slice(0, 10).reduce((sum, h) => sum + Number(h.percent ?? 0), 0) * 100
    : null;

  const ownerAddress = (entry.owner_address ?? "").toLowerCase();
  const isBurnedOrZeroOwner = ownerAddress === "" ||
    ownerAddress === "0x0000000000000000000000000000000000000000" ||
    ownerAddress === "0x000000000000000000000000000000000000dead";

  return {
    mintRenounced: entry.is_mintable != null ? entry.is_mintable === "0" : null,
    freezeRenounced: null, // not applicable to EVM tokens
    ownershipRenounced: isBurnedOrZeroOwner,
    isHoneypot: entry.is_honeypot != null ? entry.is_honeypot === "1" : null,
    buyTax: entry.buy_tax != null ? Number(entry.buy_tax) * 100 : null,
    sellTax: entry.sell_tax != null ? Number(entry.sell_tax) * 100 : null,
    lpLockedPct,
    holderCount: entry.holder_count != null ? Number(entry.holder_count) : null,
    top10HolderPct,
  };
}

const EVM_CHAIN_IDS: Record<string, string> = {
  ethereum: "1",
  base: "8453",
  bsc: "56",
  arbitrum: "42161",
  polygon: "137",
};

// --- Formatting ------------------------------------------------------------

function formatStatsCard(stats: import("./_shared/dexscreener.ts").TokenStats, address: string): string {
  const label = stats.symbol && stats.symbol !== shortenAddress(address)
    ? `${escapeMarkdown(stats.symbol)} (${shortenAddress(address)})`
    : shortenAddress(address);

  return [
    `📊 ${label} (${stats.chain})`,
    `💰 Price: $${formatPrice(stats.priceUsd)}`,
    `📈 FDV: $${formatCompactNumber(stats.fdv)}`,
    `💧 Liquidity: $${formatCompactNumber(stats.liquidityUsd)}`,
    `📊 Vol 24h: $${formatCompactNumber(stats.volume24h)}`,
    `${formatPercent(stats.priceChange1h)} 1h · ${formatPercent(stats.priceChange24h)} 24h`,
    `🔗 Chart: ${stats.chartUrl}`,
  ].join("\n");
}

// Hardcoded warning thresholds — adjust these if they don't match community
// expectations:
//   LP locked/burned: >=80% -> ✅, else ⚠️
//   Top 10 holders:   >30%  -> ⚠️, else ✅
const LP_LOCKED_OK_THRESHOLD = 80;
const TOP10_HOLDER_WARN_THRESHOLD = 30;

function renouncedLabel(v: boolean | null): string {
  if (v === null) return "n/a";
  return v ? "renounced ✅" : "active ⚠️";
}

// "3h ago", "1d 4h ago". Rounds down to the hour; a call dropped 10 minutes
// ago reads as "0h ago" rather than "1h ago".
function formatHoursAgo(since: Date): string {
  const totalMinutes = Math.max(0, Math.floor((Date.now() - since.getTime()) / 60000));
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days}d ${hours}h ago`;
  return `${hours}h ago`;
}

function formatFdvChange(from: number | null, to: number | null): string {
  const fromLabel = formatCompactNumber(from);
  const toLabel = formatCompactNumber(to);
  if (from === null || to === null || from === 0) return `$${fromLabel} → $${toLabel}`;
  const change = ((to - from) / from) * 100;
  return `$${fromLabel} → $${toLabel} (${change >= 0 ? "+" : ""}${change.toFixed(1)}%)`;
}

// Dispatches between GoPlus (full coverage), Blockscout (partial fallback —
// only when GoPlus has no coverage for this chain), and the plain "no data"
// message (neither has coverage). GoPlus always takes priority when present;
// Blockscout is never consulted otherwise, so this never overrides or
// duplicates GoPlus data.
function formatSecuritySection(
  risk: RugRiskData | null,
  blockscoutFallback: BlockscoutFallback | null,
  chain: string,
): string {
  if (risk) {
    return formatGoPlusSecuritySection(risk, chain);
  }
  if (blockscoutFallback) {
    return formatBlockscoutSecuritySection(blockscoutFallback);
  }
  return "🔐 Security: no data available yet";
}

function formatGoPlusSecuritySection(risk: RugRiskData, chain: string): string {
  const lines = ["🔐 Security"];

  if (chain === "solana") {
    lines.push(`Mint: ${renouncedLabel(risk.mintRenounced)}`);
    lines.push(`Freeze: ${renouncedLabel(risk.freezeRenounced)}`);
  } else {
    lines.push(`Ownership: ${renouncedLabel(risk.ownershipRenounced)}`);
    if (risk.isHoneypot === null) {
      lines.push(`Honeypot: n/a`);
    } else {
      lines.push(`Honeypot: ${risk.isHoneypot ? "🚨 YES" : "✅ No"}`);
    }
    if (risk.buyTax !== null || risk.sellTax !== null) {
      lines.push(
        `Tax: buy ${risk.buyTax !== null ? risk.buyTax.toFixed(1) + "%" : "n/a"} · sell ${
          risk.sellTax !== null ? risk.sellTax.toFixed(1) + "%" : "n/a"
        }`,
      );
    }
  }

  if (risk.lpLockedPct === null) {
    lines.push(`LP Locked: n/a`);
  } else {
    const ok = risk.lpLockedPct >= LP_LOCKED_OK_THRESHOLD;
    lines.push(`LP Locked: ${risk.lpLockedPct.toFixed(1)}% ${ok ? "✅" : "⚠️"}`);
  }

  if (risk.top10HolderPct === null) {
    lines.push(`Top 10 Holders: n/a`);
  } else {
    const warn = risk.top10HolderPct > TOP10_HOLDER_WARN_THRESHOLD;
    lines.push(`Top 10 Holders: ${risk.top10HolderPct.toFixed(1)}% ${warn ? "⚠️" : "✅"}`);
  }

  if (risk.holderCount !== null) {
    lines.push(`Holders: ${formatCompactNumber(risk.holderCount)}`);
  }

  return lines.join("\n");
}

// Clearly labeled as partial so no one mistakes Blockscout's limited signal
// for GoPlus's full automated checks — Blockscout cannot detect honeypots,
// mint/ownership-renounced status, LP locks, or buy/sell tax.
function formatBlockscoutSecuritySection(fallback: BlockscoutFallback): string {
  const lines = ["🔐 Security (partial — limited chain coverage)"];

  if (fallback.contractVerified === null) {
    lines.push(`Contract: n/a`);
  } else {
    lines.push(`Contract: ${fallback.contractVerified ? "Verified ✅" : "Unverified ⚠️"}`);
  }

  if (fallback.top10HolderPct === null) {
    lines.push(`Top 10 Holders: n/a`);
  } else {
    const warn = fallback.top10HolderPct > TOP10_HOLDER_WARN_THRESHOLD;
    lines.push(`Top 10 Holders: ${fallback.top10HolderPct.toFixed(1)}% ${warn ? "⚠️" : "✅"}`);
  }

  if (fallback.holderCount !== null) {
    lines.push(`Holders: ${formatCompactNumber(fallback.holderCount)}`);
  }

  lines.push("⚠️ Honeypot/tax/LP-lock checks unavailable for this chain");

  return lines.join("\n");
}

// --- Leaderboard -----------------------------------------------------------
//
// Ranking is by each user's single BEST call, not average, so one user only
// ever occupies one leaderboard slot. Per-call performance is computed by
// the shared getCallPerformance() (see _shared/performance.ts) — the same
// function daily-digest uses, so the two never diverge.

const LEADERBOARD_SIZE = 10;

interface LeaderboardEntry {
  username: string;
  changePct: number;
  symbol: string;
  fdvFrom: number | null;
  fdvTo: number | null;
}

async function buildLeaderboard(chatId: number): Promise<LeaderboardEntry[]> {
  const { data: calls } = await supabase
    .from("calls")
    .select("id, ca_address, chain, status, dropped_by_username")
    .eq("chat_id", chatId);

  if (!calls || calls.length === 0) return [];

  const bestByUser = new Map<string, LeaderboardEntry>();

  for (const call of calls) {
    if (!call.dropped_by_username) continue;

    const performance = await getCallPerformance(supabase, call);
    if (!performance) continue;

    const existing = bestByUser.get(call.dropped_by_username);
    if (!existing || performance.changePct > existing.changePct) {
      bestByUser.set(call.dropped_by_username, {
        username: call.dropped_by_username,
        changePct: performance.changePct,
        symbol: performance.symbol,
        fdvFrom: performance.fdvFrom,
        fdvTo: performance.fdvTo,
      });
    }
  }

  return Array.from(bestByUser.values())
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, LEADERBOARD_SIZE);
}

function formatLeaderboard(entries: LeaderboardEntry[]): string {
  if (entries.length === 0) {
    return "No calls tracked yet in this chat — drop a CA to get started!";
  }

  const lines = ["🏆 Top Calls in this chat"];
  entries.forEach((entry, i) => {
    const sign = entry.changePct >= 0 ? "+" : "";
    const changeLabel = `${sign}${entry.changePct.toFixed(0)}%`;
    const fdvLabel = `$${formatCompactNumber(entry.fdvFrom)} → $${formatCompactNumber(entry.fdvTo)}`;
    lines.push(
      `${i + 1}. @${escapeMarkdown(entry.username)} — ${escapeMarkdown(entry.symbol)} ${changeLabel} (FDV ${fdvLabel})`,
    );
  });

  return lines.join("\n");
}

// --- Webhook handler -------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const secretHeader = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!secretHeader || secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = await req.json();
  const message = update.message;

  if (!message || typeof message.text !== "string") {
    return new Response("OK", { status: 200 });
  }

  // Command handling: Telegram commands start with "/" and never overlap
  // with the CA regexes (base58/hex charsets don't include "/"), so this
  // branch is checked first and returns early — it can't be shadowed by,
  // or shadow, the CA-detection path below.
  const trimmedText = message.text.trim();
  if (trimmedText === "/leaderboard" || trimmedText.startsWith("/leaderboard@")) {
    const entries = await buildLeaderboard(message.chat.id);
    await sendTelegramReply(message.chat.id, message.message_id, formatLeaderboard(entries), "Markdown");
    return new Response("OK", { status: 200 });
  }

  const detected = detectCas(message.text);
  if (detected.length === 0) {
    return new Response("OK", { status: 200 });
  }

  const chatId = message.chat.id;
  const messageId = message.message_id;
  const droppedByUserId = message.from?.id ?? null;
  const droppedByUsername = message.from?.username ?? null;

  await supabase.from("chats").upsert(
    {
      chat_id: chatId,
      chat_title: message.chat.title ?? null,
    },
    { onConflict: "chat_id", ignoreDuplicates: true },
  );

  for (const ca of detected) {
    // Dedup lookup: has this exact CA already been called in this chat?
    // Ordered by dropped_at desc so a chat with multiple past cycles for
    // the same address only ever compares against the most recent one.
    const { data: priorCall } = await supabase
      .from("calls")
      .select("id, status, dropped_at, dropped_by_username")
      .eq("chat_id", chatId)
      .eq("ca_address", ca.address)
      .order("dropped_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (priorCall && priorCall.status === "active") {
      // Case A: still within the original 24h cycle — don't create a new
      // call/snapshot, just surface a lightweight then-vs-now notice.
      await handleActiveDuplicate(chatId, messageId, ca, priorCall);
      continue;
    }

    // Case B (prior call exists but already followed_up) and Case C (no
    // prior call) both run the full new-call flow; Case B additionally
    // gets a historical context line prepended to the stats card.
    let historyPrefix = "";
    if (priorCall && priorCall.status === "followed_up") {
      historyPrefix = await buildHistoryPrefix(priorCall);
    }

    await handleNewCall(chatId, messageId, droppedByUserId, droppedByUsername, ca, historyPrefix);
  }

  return new Response("OK", { status: 200 });
});

interface PriorCall {
  id: string;
  status: string;
  dropped_at: string;
  dropped_by_username: string | null;
}

async function handleActiveDuplicate(
  chatId: number,
  messageId: number,
  ca: DetectedCa,
  priorCall: PriorCall,
): Promise<void> {
  const stats = await getTokenStats(ca.address);

  const { data: initialSnapshot } = await supabase
    .from("snapshots")
    .select("fdv")
    .eq("call_id", priorCall.id)
    .eq("snapshot_type", "initial")
    .maybeSingle();

  const byLine = priorCall.dropped_by_username
    ? `@${priorCall.dropped_by_username}`
    : "someone";
  const hoursAgo = formatHoursAgo(new Date(priorCall.dropped_at));

  if (stats) {
    const lines = [
      `🔁 Already called ${hoursAgo} by ${byLine}`,
      `Then: FDV ${formatFdvChange(initialSnapshot?.fdv ?? null, stats.fdv)}`,
      `🔗 Chart: ${stats.chartUrl}`,
    ];
    await sendTelegramReply(chatId, messageId, lines.join("\n"));
  } else {
    await sendTelegramReply(
      chatId,
      messageId,
      `🔁 Already called ${hoursAgo} by ${byLine} — no current market data found for ${ca.address}.`,
    );
  }
}

async function buildHistoryPrefix(priorCall: PriorCall): Promise<string> {
  const { data: initialSnapshot } = await supabase
    .from("snapshots")
    .select("fdv")
    .eq("call_id", priorCall.id)
    .eq("snapshot_type", "initial")
    .maybeSingle();

  // This prefix is prepended to a parse_mode: "Markdown" message, and
  // Telegram usernames may legally contain underscores — escape so a
  // username like "vic_82" doesn't get parsed as italic markup.
  const byLine = priorCall.dropped_by_username
    ? `@${escapeMarkdown(priorCall.dropped_by_username)}`
    : "someone";
  const hoursAgo = formatHoursAgo(new Date(priorCall.dropped_at));
  const oldFdv = formatCompactNumber(initialSnapshot?.fdv ?? null);

  return `📌 Previously called ${hoursAgo} by ${byLine} — was $${oldFdv} FDV\n\n`;
}

async function handleNewCall(
  chatId: number,
  messageId: number,
  droppedByUserId: number | null,
  droppedByUsername: string | null,
  ca: DetectedCa,
  historyPrefix: string,
): Promise<void> {
  // Fetch stats FIRST so we know the real chain before writing the `calls`
  // row — the stored chain must be what DexScreener discovered, not the
  // regex-derived addressKind guess (an EVM-shaped address could belong to
  // any EVM chain).
  const stats = await getTokenStats(ca.address);
  const discoveredChain = stats?.chain ?? (ca.addressKind === "solana" ? "solana" : "unknown");

  const { data: insertedCall } = await supabase
    .from("calls")
    .insert({
      chat_id: chatId,
      message_id: messageId,
      ca_address: ca.address,
      chain: discoveredChain,
      dropped_by_user_id: droppedByUserId,
      dropped_by_username: droppedByUsername,
    })
    .select("id")
    .single();

  if (stats) {
    const risk = await getRugRiskData(ca.addressKind, discoveredChain, ca.address);
    // Blockscout is a fallback, not a replacement — only consult it when
    // GoPlus has no coverage at all for this chain, and only for EVM chains
    // (Blockscout doesn't cover Solana).
    const blockscoutFallback = !risk && ca.addressKind === "evm"
      ? await getBlockscoutFallback(discoveredChain, ca.address)
      : null;
    const reply = `${historyPrefix}${formatStatsCard(stats, ca.address)}\n\n${
      formatSecuritySection(risk, blockscoutFallback, discoveredChain)
    }`;
    await sendTelegramReply(chatId, messageId, reply, "Markdown");

    if (insertedCall?.id) {
      await supabase.from("snapshots").insert({
        call_id: insertedCall.id,
        price_usd: stats.priceUsd,
        fdv: stats.fdv,
        liquidity_usd: stats.liquidityUsd,
        volume_24h: stats.volume24h,
        price_change_1h: stats.priceChange1h,
        price_change_24h: stats.priceChange24h,
        snapshot_type: "initial",
      });
    }
  } else {
    await sendTelegramReply(
      chatId,
      messageId,
      `⚠️ Call logged, but no market data found yet for ${ca.address} — may be too new or invalid.`,
    );
  }
}
