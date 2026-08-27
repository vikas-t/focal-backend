import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { errorResponse } from "../_shared/errors.ts";

Deno.test("errorResponse — quota_exhausted returns 403 with correct body", async () => {
  const resp = errorResponse("quota_exhausted", "No more free requests.");
  assertEquals(resp.status, 403);
  assertEquals(resp.headers.get("content-type"), "application/json");

  const body = await resp.json();
  assertEquals(body.error.code, "quota_exhausted");
  assertEquals(body.error.message, "No more free requests.");
});

Deno.test("errorResponse — service_paused returns 503", async () => {
  const resp = errorResponse("service_paused", "Unavailable.");
  assertEquals(resp.status, 503);
  const body = await resp.json();
  assertEquals(body.error.code, "service_paused");
});

Deno.test("errorResponse — rate_limited returns 429", async () => {
  const resp = errorResponse("rate_limited", "Slow down.");
  assertEquals(resp.status, 429);
});

Deno.test("errorResponse — upstream_error returns 502", async () => {
  const resp = errorResponse("upstream_error", "Failed.");
  assertEquals(resp.status, 502);
});

Deno.test("errorResponse — bad_request returns 400", async () => {
  const resp = errorResponse("bad_request", "Invalid.");
  assertEquals(resp.status, 400);
});

Deno.test("errorResponse — extra headers are included", async () => {
  const resp = errorResponse("bad_request", "Nope", { "X-Custom": "yes" });
  assertEquals(resp.headers.get("X-Custom"), "yes");
  assertEquals(resp.headers.get("content-type"), "application/json");
});
