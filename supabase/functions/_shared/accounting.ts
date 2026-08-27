import type { SupabaseClient } from "@supabase/supabase-js";
import type { UsageInfo } from "./types.ts";

// gpt-4o-mini pricing (per 1M tokens)
const INPUT_COST = 0.15 / 1_000_000;
const OUTPUT_COST = 0.60 / 1_000_000;
// Responses API web_search: ~$25/1000 calls
const WEB_SEARCH_COST = 0.025;

export function estimateCost(mode: string, usage: UsageInfo | null): number {
  let cost = 0;

  if (usage?.prompt_tokens) cost += usage.prompt_tokens * INPUT_COST;
  if (usage?.completion_tokens) cost += usage.completion_tokens * OUTPUT_COST;
  if (mode === "validate") cost += WEB_SEARCH_COST;

  // Conservative fallback when no usage data arrived
  if (!usage?.prompt_tokens && !usage?.completion_tokens) {
    cost = mode === "validate" ? 0.03 : 0.002;
  }

  return cost;
}

export async function recordUsage(
  db: SupabaseClient,
  installId: string,
  mode: string,
  usage: UsageInfo | null,
  status: "ok" | "upstream_error",
  reservedCost: number,
): Promise<void> {
  const actualCost = estimateCost(mode, usage);
  await db.from("usage_events").insert({
    install_id: installId,
    mode,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    estimated_cost_usd: actualCost,
    status,
  });
  // Reconcile the pre-reserved spend with actual cost
  if (reservedCost !== actualCost) {
    await db.rpc("reconcile_daily_spend", {
      p_reserved: reservedCost,
      p_actual: actualCost,
    });
  }
}
