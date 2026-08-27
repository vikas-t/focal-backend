import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadConfig } from "../_shared/config.ts";
import { createMockClient } from "./mock_supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

Deno.test("loadConfig — returns values from database", async () => {
  const db = createMockClient({
    tables: {
      config: {
        rows: [
          { key: "free_requests_per_install", value: 50 },
          { key: "daily_spend_cap_usd", value: 10.0 },
          { key: "rate_limit_per_minute", value: 5 },
          { key: "model", value: "gpt-4o" },
          { key: "kill_switch", value: true },
        ],
      },
    },
  });

  const config = await loadConfig(db as unknown as SupabaseClient);
  assertEquals(config.free_requests_per_install, 50);
  assertEquals(config.daily_spend_cap_usd, 10.0);
  assertEquals(config.rate_limit_per_minute, 5);
  assertEquals(config.model, "gpt-4o");
  assertEquals(config.kill_switch, true);
});

Deno.test("loadConfig — returns defaults on error", async () => {
  const db = createMockClient({
    tables: {
      config: { error: { message: "table not found" } },
    },
  });

  const config = await loadConfig(db as unknown as SupabaseClient);
  assertEquals(config.free_requests_per_install, 20);
  assertEquals(config.daily_spend_cap_usd, 3.0);
  assertEquals(config.kill_switch, false);
});

Deno.test("loadConfig — ignores unknown keys", async () => {
  const db = createMockClient({
    tables: {
      config: {
        rows: [
          { key: "free_requests_per_install", value: 30 },
          { key: "unknown_key", value: "whatever" },
        ],
      },
    },
  });

  const config = await loadConfig(db as unknown as SupabaseClient);
  assertEquals(config.free_requests_per_install, 30);
  assertEquals((config as unknown as Record<string, unknown>)["unknown_key"], undefined);
});

Deno.test("loadConfig — partial config merges with defaults", async () => {
  const db = createMockClient({
    tables: {
      config: {
        rows: [
          { key: "kill_switch", value: true },
        ],
      },
    },
  });

  const config = await loadConfig(db as unknown as SupabaseClient);
  assertEquals(config.kill_switch, true);
  assertEquals(config.free_requests_per_install, 20);
  assertEquals(config.model, "gpt-4o-mini");
});
