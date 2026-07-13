import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getTokenStats } from "./_shared/dexscreener.ts";
import { formatCompactNumber } from "./_shared/format.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Testing override: pass ?window_minutes=N to treat calls due in the last N
// minutes as eligible instead of the real 24h threshold. Only affects which
// calls are selected — the rest of the logic (fetch stats, compare, post,
// insert snapshot, update status) is identical to the real 24h path, so
// nothing production-only is being skipped by testing this way.
const DEFAULT_WINDOW_HOURS = 24;

async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<boolean> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (replyToMessageId != null) {
    body.reply_to_message_id = replyToMessageId;
    body.allow_sending_without_reply = true;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`sendMessage failed (${res.status}): ${await res.text()}`);
  }
  return res.ok;
}

function pctChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from === 0) return null;
  return ((to - from) / from) * 100;
}

function formatChange(from: number | null, to: number | null): string {
  const change = pctChange(from, to);
  const fromLabel = `$${formatCompactNumber(from)}`;
  const toLabel = `$${formatCompactNumber(to)}`;
  if (change === null) return `${fromLabel} → ${toLabel}`;
  const arrow = change >= 0 ? "✅" : "🔻";
  return `${fromLabel} → ${toLabel} (${change >= 0 ? "+" : ""}${change.toFixed(1)}% ${arrow})`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const secretHeader = req.headers.get("X-Cron-Secret");
  if (!secretHeader || secretHeader !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const urlParams = new URL(req.url).searchParams;
  const windowMinutesParam = urlParams.get("window_minutes");
  const cutoff = windowMinutesParam
    ? new Date(Date.now() - Number(windowMinutesParam) * 60 * 1000)
    : new Date(Date.now() - DEFAULT_WINDOW_HOURS * 60 * 60 * 1000);

  const { data: dueCalls, error } = await supabase
    .from("calls")
    .select("id, chat_id, message_id, ca_address, chain, dropped_by_username, dropped_at")
    .eq("status", "active")
    .lte("dropped_at", cutoff.toISOString());

  if (error || !dueCalls) {
    return new Response(JSON.stringify({ error: error?.message ?? "query failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const results: Array<{ call_id: string; outcome: string }> = [];

  for (const call of dueCalls) {
    try {
      // Skip if a followup snapshot already exists for this call (defends
      // against re-processing if the status update below ever fails
      // partway through a previous run).
      const { data: existingFollowup } = await supabase
        .from("snapshots")
        .select("id")
        .eq("call_id", call.id)
        .eq("snapshot_type", "followup")
        .maybeSingle();

      if (existingFollowup) {
        results.push({ call_id: call.id, outcome: "skipped_already_followed_up" });
        continue;
      }

      const { data: initialSnapshot } = await supabase
        .from("snapshots")
        .select("price_usd, fdv, liquidity_usd, volume_24h")
        .eq("call_id", call.id)
        .eq("snapshot_type", "initial")
        .maybeSingle();

      const currentStats = await getTokenStats(call.chain, call.ca_address);

      const label = call.ca_address.length > 12
        ? `${call.ca_address.slice(0, 4)}...${call.ca_address.slice(-4)}`
        : call.ca_address;
      const byLine = call.dropped_by_username
        ? `Called by @${call.dropped_by_username} · 24h ago`
        : `Dropped 24h ago`;

      let messageText: string;

      if (currentStats) {
        const initialFdv = initialSnapshot?.fdv ?? null;
        const initialLiq = initialSnapshot?.liquidity_usd ?? null;
        messageText = [
          `🔔 24h Follow-up: ${currentStats.symbol ?? label} (${label})`,
          byLine,
          `FDV: ${formatChange(initialFdv, currentStats.fdv)}`,
          `Liquidity: ${formatChange(initialLiq, currentStats.liquidityUsd)}`,
          `📊 Still active — chart: ${currentStats.chartUrl}`,
        ].join("\n");
      } else {
        messageText = [
          `🔔 24h Follow-up: ${label}`,
          byLine,
          `⚠️ No market data found — may be delisted or liquidity pulled`,
        ].join("\n");
      }

      await sendTelegramMessage(call.chat_id, messageText, call.message_id ?? undefined);

      await supabase.from("snapshots").insert({
        call_id: call.id,
        price_usd: currentStats?.priceUsd ?? null,
        fdv: currentStats?.fdv ?? null,
        liquidity_usd: currentStats?.liquidityUsd ?? null,
        volume_24h: currentStats?.volume24h ?? null,
        price_change_1h: currentStats?.priceChange1h ?? null,
        price_change_24h: currentStats?.priceChange24h ?? null,
        snapshot_type: "followup",
      });

      await supabase.from("calls").update({ status: "followed_up" }).eq("id", call.id);

      results.push({ call_id: call.id, outcome: currentStats ? "posted" : "posted_no_data" });
    } catch (err) {
      // Don't let one failing call abort the batch — record and continue.
      results.push({ call_id: call.id, outcome: `error: ${(err as Error).message}` });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
