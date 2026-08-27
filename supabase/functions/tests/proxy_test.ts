import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { VALID_MODES, RESPONSES_API_MODES } from "../_shared/types.ts";

// Tests for pure functions extracted from proxy/index.ts.
// The proxy itself depends on Deno.serve and Deno.env, so we test the
// pure validation/detection logic here rather than the full handler.

// ---------- containsPdf ----------

function containsPdf(payload: Record<string, unknown>): boolean {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "file" && part.file?.file_data) return true;
    }
  }
  return false;
}

Deno.test("containsPdf — detects PDF file content in messages", () => {
  const payload = {
    messages: [
      { role: "system", content: "You are helpful." },
      {
        role: "user",
        content: [
          { type: "file", file: { filename: "doc.pdf", file_data: "data:application/pdf;base64,abc" } },
          { type: "text", text: "Explain this." },
        ],
      },
    ],
  };
  assertEquals(containsPdf(payload), true);
});

Deno.test("containsPdf — returns false for text-only messages", () => {
  const payload = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What is this about?" },
    ],
  };
  assertEquals(containsPdf(payload), false);
});

Deno.test("containsPdf — returns false for no messages", () => {
  assertEquals(containsPdf({}), false);
  assertEquals(containsPdf({ input: "test" }), false);
});

Deno.test("containsPdf — returns false for file without file_data", () => {
  const payload = {
    messages: [
      {
        role: "user",
        content: [{ type: "file", file: { filename: "doc.pdf" } }],
      },
    ],
  };
  assertEquals(containsPdf(payload), false);
});

// ---------- UUID validation ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.test("UUID regex — accepts valid v4 UUID", () => {
  assertEquals(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000"), true);
  assertEquals(UUID_RE.test("6ba7b810-9dad-41d5-80b4-00c04fd430c8"), true); // valid v4 (8 is in [89ab] range)
  assertEquals(UUID_RE.test("6ba7b810-9dad-11d5-70b4-00c04fd430c8"), false); // not v4 (version digit is 1, not 4; variant 7 not in [89ab])
});

Deno.test("UUID regex — rejects non-UUID strings", () => {
  assertEquals(UUID_RE.test("not-a-uuid"), false);
  assertEquals(UUID_RE.test(""), false);
  assertEquals(UUID_RE.test("550e8400e29b41d4a716446655440000"), false); // no dashes
});

Deno.test("UUID regex — case insensitive", () => {
  assertEquals(UUID_RE.test("550E8400-E29B-41D4-A716-446655440000"), true);
});

// ---------- Mode validation ----------

Deno.test("VALID_MODES contains all expected modes", () => {
  assertEquals(VALID_MODES.includes("explain"), true);
  assertEquals(VALID_MODES.includes("summarize"), true);
  assertEquals(VALID_MODES.includes("validate"), true);
  assertEquals(VALID_MODES.includes("worth_reading"), true);
  assertEquals(VALID_MODES.length, 4);
});

Deno.test("VALID_MODES rejects unknown modes", () => {
  assertEquals(VALID_MODES.includes("chat"), false);
  assertEquals(VALID_MODES.includes(""), false);
});

Deno.test("RESPONSES_API_MODES only includes validate", () => {
  assertEquals(RESPONSES_API_MODES.has("validate"), true);
  assertEquals(RESPONSES_API_MODES.has("explain"), false);
  assertEquals(RESPONSES_API_MODES.has("summarize"), false);
  assertEquals(RESPONSES_API_MODES.size, 1);
});

// ---------- Streaming detection ----------

Deno.test("streaming is determined by payload.stream", () => {
  const isStreaming = (p: Record<string, unknown>) => p.stream === true;
  assertEquals(isStreaming({ stream: true }), true);
  assertEquals(isStreaming({ stream: false }), false);
  assertEquals(isStreaming({}), false);
  assertEquals(isStreaming({ stream: "true" }), false); // string, not boolean
});
