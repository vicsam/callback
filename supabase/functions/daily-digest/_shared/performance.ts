// Shared call-performance calculation — used by /leaderboard (Segment 6) and
// daily-digest (Segment 7). Keep this the single source of truth for how a
// call's % FDV change is computed; do not reimplement it in either caller.
//
// Performance for a call = % FDV change from its 'initial' snapshot to its
// most recent data point: the 'followup' snapshot if the call has completed
// its 24h cycle, or a live getTokenStats() call if it's still active (rather
// than waiting on a stale initial-only reading). Returns null if there's
// nothing to measure (no initial FDV, or no current FDV available).

import { getTokenStats, shortenAddress } from "./dexscreener.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface CallForPerformance {
  id: string;
  ca_address: string;
  chain: string;
  status: string;
  dropped_by_username: string | null;
}

export interface CallPerformance {
  changePct: number;
  symbol: string;
  fdvFrom: number;
  fdvTo: number;
}

export async function getCallPerformance(
  supabase: SupabaseClient,
  call: CallForPerformance,
): Promise<CallPerformance | null> {
  const { data: initialSnapshot } = await supabase
    .from("snapshots")
    .select("fdv")
    .eq("call_id", call.id)
    .eq("snapshot_type", "initial")
    .maybeSingle();

  const fdvFrom = initialSnapshot?.fdv ?? null;
  if (fdvFrom === null || fdvFrom === 0) return null; // nothing to measure against

  let fdvTo: number | null = null;
  let symbol = shortenAddress(call.ca_address);

  if (call.status === "followed_up") {
    const { data: followupSnapshot } = await supabase
      .from("snapshots")
      .select("fdv")
      .eq("call_id", call.id)
      .eq("snapshot_type", "followup")
      .maybeSingle();
    fdvTo = followupSnapshot?.fdv ?? null;
  } else {
    const stats = await getTokenStats(call.ca_address);
    fdvTo = stats?.fdv ?? null;
    if (stats?.symbol) symbol = stats.symbol;
  }

  if (fdvTo === null) return null;

  const changePct = ((fdvTo - fdvFrom) / fdvFrom) * 100;
  return { changePct, symbol, fdvFrom, fdvTo };
}
