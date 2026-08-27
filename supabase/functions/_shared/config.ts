import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "./types.ts";

const DEFAULTS: AppConfig = {
  free_requests_per_install: 20,
  daily_spend_cap_usd: 3.0,
  rate_limit_per_minute: 10,
  model: "gpt-4o-mini",
  kill_switch: false,
  free_modes: ["explain", "summarize", "worth_reading"],
};

export async function loadConfig(db: SupabaseClient): Promise<AppConfig> {
  const { data, error } = await db.from("config").select("key, value");
  if (error || !data) return { ...DEFAULTS };

  const config = { ...DEFAULTS } as Record<string, unknown>;
  for (const row of data) {
    if (row.key in DEFAULTS) {
      config[row.key] = row.value;
    }
  }
  return config as unknown as AppConfig;
}
