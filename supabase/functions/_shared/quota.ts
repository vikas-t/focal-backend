import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "./types.ts";
import { estimateCost } from "./accounting.ts";

interface Install {
  install_id: string;
  requests_used: number;
  requests_limit: number;
}

export type QuotaResult =
  | { ok: true; install: Install; reservedCost: number }
  | { ok: false; code: "service_paused" | "quota_exhausted" | "rate_limited" | "mode_requires_key"; message: string; remaining?: number };

export async function checkQuota(
  db: SupabaseClient,
  config: AppConfig,
  installId: string,
  mode: string,
  ipHash: string | null,
): Promise<QuotaResult> {
  // 1. Kill switch
  if (config.kill_switch) {
    return { ok: false, code: "service_paused", message: "Free tier is temporarily unavailable." };
  }

  // 2. Mode gating
  if (!config.free_modes.includes(mode)) {
    return { ok: false, code: "mode_requires_key", message: "This feature requires your own OpenAI API key." };
  }

  // 3. Rate limit (checked before quota/spend so we don't consume then roll back)
  const { count } = await db
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("install_id", installId)
    .gte("created_at", new Date(Date.now() - 60_000).toISOString());

  if ((count ?? 0) >= config.rate_limit_per_minute) {
    return { ok: false, code: "rate_limited", message: "Too many requests. Try again shortly." };
  }

  // 4. Atomic daily spend reservation (estimate before calling OpenAI)
  const estimatedCost = estimateCost(mode, null);
  const { data: newTotal, error: spendErr } = await db.rpc("reserve_daily_spend", {
    p_estimated_cost: estimatedCost,
    p_cap: config.daily_spend_cap_usd,
  });

  if (spendErr) {
    return { ok: false, code: "service_paused", message: "Internal error." };
  }
  if (newTotal === null) {
    return { ok: false, code: "service_paused", message: "Free tier is temporarily unavailable." };
  }

  // 5. Atomic quota check-and-increment
  const { data: install, error: consumeErr } = await db.rpc("consume_quota", {
    p_install_id: installId,
    p_requests_limit: config.free_requests_per_install,
    p_ip_hash: ipHash,
  });

  if (consumeErr) {
    await rollbackSpend(db, estimatedCost);
    return { ok: false, code: "service_paused", message: "Internal error." };
  }

  const inst = install as Install;
  if (!inst?.install_id) {
    await rollbackSpend(db, estimatedCost);
    return { ok: false, code: "quota_exhausted", message: "Free request allowance used up.", remaining: 0 };
  }

  return {
    ok: true,
    install: inst,
    reservedCost: estimatedCost,
  };
}

async function rollbackSpend(db: SupabaseClient, amount: number): Promise<void> {
  await db.rpc("reconcile_daily_spend", {
    p_reserved: amount,
    p_actual: 0,
  });
}
