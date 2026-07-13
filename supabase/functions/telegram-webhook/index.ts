import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getTokenStats, shortenAddress } from "./_shared/dexscreener.ts";
import { escapeMarkdown, formatCompactNumber, formatPercent, formatPrice } from "./_shared/format.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SOLANA_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const EVM_RE = /0x[a-fA-F0-9]{40}/g;

interface DetectedCa {
  address: string;
  chain: "solana" | "ethereum";
}

function detectCas(text: string): DetectedCa[] {
  const results: DetectedCa[] = [];

  const evmMatches = text.match(EVM_RE) ?? [];
  for (const address of evmMatches) {
    results.push({ address, chain: "ethereum" });
  }

  // Strip EVM matches before running the Solana regex so a 0x... address
  // isn't also picked up as a base58-ish Solana match.
  const textWithoutEvm = text.replace(EVM_RE, " ");
  const solanaMatches = textWithoutEvm.match(SOLANA_RE) ?? [];
  for (const address of solanaMatches) {
    results.push({ address, chain: "solana" });
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

async function getRugRiskData(chain: string, address: string): Promise<RugRiskData | null> {
  if (chain === "solana") {
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
  const chainId = EVM_CHAIN_IDS[chain] ?? "1";
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

function formatSecuritySection(risk: RugRiskData | null, chain: string): string {
  if (!risk) {
    return "🔐 Security: no data available yet";
  }

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
    const { data: insertedCall } = await supabase
      .from("calls")
      .insert({
        chat_id: chatId,
        message_id: messageId,
        ca_address: ca.address,
        chain: ca.chain,
        dropped_by_user_id: droppedByUserId,
        dropped_by_username: droppedByUsername,
      })
      .select("id")
      .single();

    const stats = await getTokenStats(ca.chain, ca.address);

    if (stats) {
      const risk = await getRugRiskData(ca.chain, ca.address);
      const reply = `${formatStatsCard(stats, ca.address)}\n\n${formatSecuritySection(risk, ca.chain)}`;
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

  return new Response("OK", { status: 200 });
});
