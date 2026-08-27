import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "./types.ts";

interface Install {
  install_id: string;
  requests_used: number;
  requests_limit: number;
}

export type QuotaResult =
  | { ok: true; install: Install }
  | { ok: false; code: "service_paused" | "quota_exhausted" | "rate_limited"; message: string };

export async function checkQuota(
  db: SupabaseClient,
  config: AppConfig,
  installId: string,
  ipHash: string | null,
): Promise<QuotaResult> {
  // 1. Kill switch
  if (config.kill_switch) {
    return { ok: false, code: "service_paused", message: "Free tier is temporarily unavailable." };
  }

  // 2. Global daily spend cap
  const today = new Date().toISOString().slice(0, 10);
  const { data: spendRow } = await db
    .from("daily_spend")
    .select("total_usd")
    .eq("day", today)
    .maybeSingle();

  if (spendRow && Number(spendRow.total_usd) >= config.daily_spend_cap_usd) {
    return { ok: false, code: "service_paused", message: "Free tier is temporarily unavailable." };
  }

  // 3. Upsert install (create on first sight, update last_seen on return visit)
  const { data: install, error: upsertErr } = await db.rpc("upsert_install", {
    p_install_id: installId,
    p_requests_limit: config.free_requests_per_install,
    p_ip_hash: ipHash,
  });

  if (upsertErr || !install) {
    return { ok: false, code: "service_paused", message: "Internal error." };
  }

  const inst = install as Install;

  // 4. Quota check
  if (inst.requests_used >= inst.requests_limit) {
    return { ok: false, code: "quota_exhausted", message: "Free request allowance used up." };
  }

  // 5. Rate limit
  const { count } = await db
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("install_id", installId)
    .gte("created_at", new Date(Date.now() - 60_000).toISOString());

  if ((count ?? 0) >= config.rate_limit_per_minute) {
    return { ok: false, code: "rate_limited", message: "Too many requests. Try again shortly." };
  }

  // 6. Reserve the request (increment before calling OpenAI — no refund on failure)
  await db
    .from("installs")
    .update({
      requests_used: inst.requests_used + 1,
      last_seen_at: new Date().toISOString(),
    })
    .eq("install_id", installId);

  return {
    ok: true,
    install: { ...inst, requests_used: inst.requests_used + 1 },
  };
}
