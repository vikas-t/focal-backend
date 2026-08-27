import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Test the sanitizePayload logic (duplicated here since it's not exported,
// but verifying the contract the proxy depends on).

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...payload };
  delete clean.api_key;
  delete clean.authorization;
  return clean;
}

Deno.test("sanitizePayload — strips api_key and authorization", () => {
  const payload = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    api_key: "sk-secret",
    authorization: "Bearer sk-secret",
  };
  const clean = sanitizePayload(payload);
  assertEquals(clean.api_key, undefined);
  assertEquals(clean.authorization, undefined);
  assertEquals(clean.model, "gpt-4o-mini");
  assertEquals(clean.messages, payload.messages);
});

Deno.test("sanitizePayload — does not mutate original", () => {
  const payload = { model: "gpt-4o-mini", api_key: "sk-secret" };
  sanitizePayload(payload);
  assertEquals(payload.api_key, "sk-secret");
});

Deno.test("sanitizePayload — passes through clean payload unchanged", () => {
  const payload = { model: "gpt-4o-mini", stream: true, messages: [] };
  const clean = sanitizePayload(payload);
  assertEquals(clean.model, "gpt-4o-mini");
  assertEquals(clean.stream, true);
});

// Test usage extraction logic for both Chat Completions and Responses API shapes

// Mirrors the extraction logic in openai.ts proxyNonStreaming
function extractUsage(data: Record<string, unknown>) {
  const u = data.usage as Record<string, number> | undefined;
  return {
    prompt_tokens: u?.prompt_tokens ?? u?.input_tokens ?? null,
    completion_tokens: u?.completion_tokens ?? u?.output_tokens ?? null,
  };
}

Deno.test("Chat Completions usage extraction", () => {
  const data = {
    choices: [{ message: { content: "Hello" } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
  const usage = extractUsage(data);
  assertEquals(usage.prompt_tokens, 100);
  assertEquals(usage.completion_tokens, 50);
});

Deno.test("Responses API usage extraction (input_tokens/output_tokens)", () => {
  const data = {
    output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    usage: { input_tokens: 200, output_tokens: 80 },
  };
  const usage = extractUsage(data);
  assertEquals(usage.prompt_tokens, 200);
  assertEquals(usage.completion_tokens, 80);
});

Deno.test("Missing usage falls back to null", () => {
  const data: Record<string, unknown> = { choices: [{ message: { content: "Hello" } }] };
  const usage = extractUsage(data);
  assertEquals(usage.prompt_tokens, null);
  assertEquals(usage.completion_tokens, null);
});

// Test SSE stream usage parsing logic

Deno.test("SSE stream — extracts usage from final chunk", () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":10}}',
    "data: [DONE]",
  ];

  let captured = { prompt_tokens: null as number | null, completion_tokens: null as number | null };

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (event.usage) {
        captured = {
          prompt_tokens: event.usage.prompt_tokens ?? null,
          completion_tokens: event.usage.completion_tokens ?? null,
        };
      }
    } catch {
      // skip
    }
  }

  assertEquals(captured.prompt_tokens, 50);
  assertEquals(captured.completion_tokens, 10);
});

Deno.test("SSE stream — no usage chunk leaves null", () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}',
    "data: [DONE]",
  ];

  let captured = { prompt_tokens: null as number | null, completion_tokens: null as number | null };

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (event.usage) {
        captured = {
          prompt_tokens: event.usage.prompt_tokens ?? null,
          completion_tokens: event.usage.completion_tokens ?? null,
        };
      }
    } catch {
      // skip
    }
  }

  assertEquals(captured.prompt_tokens, null);
  assertEquals(captured.completion_tokens, null);
});
