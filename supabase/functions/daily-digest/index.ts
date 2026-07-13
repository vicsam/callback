import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { formatCompactNumber } from "./_shared/format.ts";
import { getCallPerformance } from "./_shared/performance.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DEFAULT_WINDOW_HOURS = 24;

async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    console.error(`sendMessage failed (${res.status}): ${await res.text()}`);
  }
  return res.ok;
}

interface DigestLine {
  username: string;
  symbol: string;
  changePct: number;
  fdvFrom: number;
  fdvTo: number;
  droppedAt: string;
}

function formatDigest(lines: DigestLine[]): string {
  const header = `📅 Daily Digest — ${lines.length} call${lines.length === 1 ? "" : "s"} in the last 24h`;

  // Chronological (dropped_at ascending) so the digest reads as a timeline
  // of the day's activity, not a ranking — ranking is what /leaderboard is for.
  const chronological = [...lines].sort(
    (a, b) => new Date(a.droppedAt).getTime() - new Date(b.droppedAt).getTime(),
  );

  const body = chronological.map((line, i) => {
    const sign = line.changePct >= 0 ? "+" : "";
    const changeLabel = `${sign}${line.changePct.toFixed(0)}%`;
    const byUser = line.username ? `@${line.username}` : "someone";
    return `${i + 1}. ${byUser} — ${line.symbol} ${changeLabel} (FDV $${
      formatCompactNumber(line.fdvFrom)
    } → $${formatCompactNumber(line.fdvTo)})`;
  });

  const best = lines.reduce((a, b) => (b.changePct > a.changePct ? b : a));
  const bestByUser = best.username ? `@${best.username}` : "someone";
  const bestSign = best.changePct >= 0 ? "+" : "";
  const bestLine = `🏆 Best call: ${bestByUser} — ${best.symbol} ${bestSign}${
    best.changePct.toFixed(0)
  }%`;

  return [header, "", ...body, "", bestLine].join("\n");
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
  const windowHoursParam = urlParams.get("window_hours");
  const windowHours = windowHoursParam ? Number(windowHoursParam) : DEFAULT_WINDOW_HOURS;
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const { data: activeChats, error: chatsError } = await supabase
    .from("chats")
    .select("chat_id")
    .eq("is_active", true);

  if (chatsError || !activeChats) {
    return new Response(JSON.stringify({ error: chatsError?.message ?? "query failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const results: Array<{ chat_id: number; outcome: string }> = [];

  for (const chat of activeChats) {
    try {
      const { data: calls } = await supabase
        .from("calls")
        .select("id, ca_address, chain, status, dropped_by_username, dropped_at")
        .eq("chat_id", chat.chat_id)
        .gte("dropped_at", cutoff.toISOString());

      if (!calls || calls.length === 0) {
        results.push({ chat_id: chat.chat_id, outcome: "skipped_no_calls" });
        continue;
      }

      const lines: DigestLine[] = [];
      for (const call of calls) {
        const performance = await getCallPerformance(supabase, call);
        if (!performance) continue;
        lines.push({
          username: call.dropped_by_username ?? "",
          symbol: performance.symbol,
          changePct: performance.changePct,
          fdvFrom: performance.fdvFrom,
          fdvTo: performance.fdvTo,
          droppedAt: call.dropped_at,
        });
      }

      if (lines.length === 0) {
        // Calls existed in the window, but none had measurable performance
        // (e.g. all lacked an initial FDV) — nothing meaningful to report.
        results.push({ chat_id: chat.chat_id, outcome: "skipped_no_measurable_calls" });
        continue;
      }

      await sendTelegramMessage(chat.chat_id, formatDigest(lines));
      results.push({ chat_id: chat.chat_id, outcome: "posted" });
    } catch (err) {
      results.push({ chat_id: chat.chat_id, outcome: `error: ${(err as Error).message}` });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
