import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkQuota } from "../_shared/quota.ts";
import { createMockClient, defaultConfig } from "./mock_supabase.ts";
import type { AppConfig } from "../_shared/types.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const BASE_CONFIG: AppConfig = {
  free_requests_per_install: 20,
  daily_spend_cap_usd: 3.0,
  rate_limit_per_minute: 10,
  model: "gpt-4o-mini",
  kill_switch: false,
};

const INSTALL_ID = "550e8400-e29b-41d4-a716-446655440000";

Deno.test("checkQuota — kill switch returns service_paused", async () => {
  const mock = defaultConfig();
  const db = createMockClient(mock) as unknown as SupabaseClient;
  const config = { ...BASE_CONFIG, kill_switch: true };

  const result = await checkQuota(db, config, INSTALL_ID, null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, "service_paused");
  }
});

Deno.test("checkQuota — daily spend cap exceeded returns service_paused", async () => {
  const mock = defaultConfig();
  const today = new Date().toISOString().slice(0, 10);
  mock.tables.daily_spend = {
    rows: [{ day: today, total_usd: 5.0 }],
  };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, "service_paused");
  }
});

Deno.test("checkQuota — spend under cap passes", async () => {
  const mock = defaultConfig();
  const today = new Date().toISOString().slice(0, 10);
  mock.tables.daily_spend = {
    rows: [{ day: today, total_usd: 1.5 }],
  };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, null);
  assertEquals(result.ok, true);
});

Deno.test("checkQuota — no spend row passes (first day)", async () => {
  const mock = defaultConfig();
  mock.tables.daily_spend = { rows: [] };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, null);
  assertEquals(result.ok, true);
});

Deno.test("checkQuota — quota exhausted returns quota_exhausted", async () => {
  const mock = defaultConfig();
  mock.tables["rpc:upsert_install"] = {
    rpcResult: {
      install_id: INSTALL_ID,
      requests_used: 20,
      requests_limit: 20,
    },
  };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, "quota_exhausted");
  }
});

Deno.test("checkQuota — quota not exhausted passes", async () => {
  const mock = defaultConfig();
  mock.tables["rpc:upsert_install"] = {
    rpcResult: {
      install_id: INSTALL_ID,
      requests_used: 19,
      requests_limit: 20,
    },
  };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, null);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.install.requests_used, 20); // incremented by reservation
  }
});

Deno.test("checkQuota — rate limited returns rate_limited", async () => {
  const mock = defaultConfig();
  mock.tables.usage_events = { rows: [], count: 10 };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, "rate_limited");
  }
});

Deno.test("checkQuota — under rate limit passes", async () => {
  const mock = defaultConfig();
  mock.tables.usage_events = { rows: [], count: 5 };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, null);
  assertEquals(result.ok, true);
});

Deno.test("checkQuota — upsert error returns service_paused", async () => {
  const mock = defaultConfig();
  mock.tables["rpc:upsert_install"] = {
    rpcError: { message: "db error" },
  };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, "service_paused");
  }
});

Deno.test("checkQuota — fresh install with zero usage passes", async () => {
  const mock = defaultConfig();
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, "abc123");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.install.requests_used, 1); // first request reserved
    assertEquals(result.install.requests_limit, 20);
  }
});
