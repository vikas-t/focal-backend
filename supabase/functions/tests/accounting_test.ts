import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { estimateCost } from "../_shared/accounting.ts";

Deno.test("estimateCost — explain with usage data", () => {
  const cost = estimateCost("explain", { prompt_tokens: 1000, completion_tokens: 500 });
  // 1000 * 0.15/1M + 500 * 0.60/1M = 0.00015 + 0.0003 = 0.00045
  assertAlmostEquals(cost, 0.00045, 1e-8);
});

Deno.test("estimateCost — validate adds web search cost", () => {
  const cost = estimateCost("validate", { prompt_tokens: 1000, completion_tokens: 500 });
  // 0.00045 (tokens) + 0.025 (web search)
  assertAlmostEquals(cost, 0.02545, 1e-8);
});

Deno.test("estimateCost — fallback when no usage data (explain)", () => {
  const cost = estimateCost("explain", null);
  assertEquals(cost, 0.002);
});

Deno.test("estimateCost — fallback when no usage data (validate)", () => {
  const cost = estimateCost("validate", null);
  assertEquals(cost, 0.03);
});

Deno.test("estimateCost — fallback when tokens are zero", () => {
  const cost = estimateCost("summarize", { prompt_tokens: 0, completion_tokens: 0 });
  assertEquals(cost, 0.002);
});

Deno.test("estimateCost — null tokens trigger fallback", () => {
  const cost = estimateCost("explain", { prompt_tokens: null, completion_tokens: null });
  assertEquals(cost, 0.002);
});

Deno.test("estimateCost — only prompt tokens present", () => {
  const cost = estimateCost("explain", { prompt_tokens: 5000, completion_tokens: null });
  // 5000 * 0.15/1M = 0.00075
  assertAlmostEquals(cost, 0.00075, 1e-8);
});

Deno.test("estimateCost — worth_reading uses explain pricing", () => {
  const cost = estimateCost("worth_reading", null);
  assertEquals(cost, 0.002);
});
