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
  free_modes: ["explain", "summarize", "worth_reading", "validate"],
  free_validates_per_install: 5,
};

const INSTALL_ID = "550e8400-e29b-41d4-a716-446655440000";

Deno.test("checkQuota — kill switch returns service_paused", async () => {
  const mock = defaultConfig();
  const db = createMockClient(mock) as unknown as SupabaseClient;
  const config = { ...BASE_CONFIG, kill_switch: true };

  const result = await checkQuota(db, config, INSTALL_ID, "explain", null);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "service_paused");
});

Deno.test("checkQuota — mode not in free_modes returns mode_requires_key", async () => {
  const mock = defaultConfig();
  const db = createMockClient(mock) as unknown as SupabaseClient;
  const config = { ...BASE_CONFIG, free_modes: ["explain"] };

  const result = await checkQuota(db, config, INSTALL_ID, "validate", null);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "mode_requires_key");
});

Deno.test("checkQuota — explain passes and uses consume_quota", async () => {
  const mock = defaultConfig();
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, "explain", null);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.install.requests_used, 1);
    assertEquals(result.install.validates_used, 0);
  }
});

Deno.test("checkQuota — validate passes and uses consume_validate_quota", async () => {
  const mock = defaultConfig();
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, "validate", null);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.install.validates_used, 1);
    assertEquals(result.install.requests_used, 0);
    assertEquals(result.reservedCost, 0.03);
  }
});

Deno.test("checkQuota — rate limited returns rate_limited", async () => {
  const mock = defaultConfig();
  mock.tables.usage_events = { rows: [], count: 10 };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, "explain", null);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "rate_limited");
});

Deno.test("checkQuota — under rate limit passes", async () => {
  const mock = defaultConfig();
  mock.tables.usage_events = { rows: [], count: 5 };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, "explain", null);
  assertEquals(result.ok, true);
});

Deno.test("checkQuota — spend cap exceeded returns service_paused", async () => {
  const mock = defaultConfig();
  mock.tables["rpc:reserve_daily_spend"] = { rpcResult: null };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, "explain", null);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "service_paused");
});

Deno.test("checkQuota — quota exhausted returns remaining 0", async () => {
  const mock = defaultConfig();
  mock.tables["rpc:consume_quota"] = {
    rpcResult: { install_id: null, requests_used: null, requests_limit: null, validates_used: null, validates_limit: null },
  };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, "explain", null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, "quota_exhausted");
    assertEquals(result.remaining, 0);
  }
});

Deno.test("checkQuota — validate quota exhausted returns specific message", async () => {
  const mock = defaultConfig();
  mock.tables["rpc:consume_validate_quota"] = {
    rpcResult: { install_id: null, requests_used: null, requests_limit: null, validates_used: null, validates_limit: null },
  };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, "validate", null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, "quota_exhausted");
    assertEquals(result.message.includes("validation"), true);
  }
});

Deno.test("checkQuota — consume error returns service_paused", async () => {
  const mock = defaultConfig();
  mock.tables["rpc:consume_quota"] = { rpcError: { message: "db error" } };
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, "explain", null);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "service_paused");
});

Deno.test("checkQuota — fresh install with ip hash passes", async () => {
  const mock = defaultConfig();
  const db = createMockClient(mock) as unknown as SupabaseClient;

  const result = await checkQuota(db, BASE_CONFIG, INSTALL_ID, "explain", "abc123");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.install.requests_used, 1);
    assertEquals(result.install.requests_limit, 20);
    assertEquals(result.install.validates_limit, 5);
  }
});
