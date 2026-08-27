import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { loadConfig } from "../_shared/config.ts";
import { errorResponse } from "../_shared/errors.ts";
import { checkQuota } from "../_shared/quota.ts";
import { proxyNonStreaming, proxyStreaming } from "../_shared/openai.ts";
import { recordUsage } from "../_shared/accounting.ts";
import { VALID_MODES, RESPONSES_API_MODES } from "../_shared/types.ts";
import type { ProxyRequest } from "../_shared/types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-expose-headers": "X-Quota-Remaining",
  };
}

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

async function hashIp(ip: string): Promise<string> {
  const salt = Deno.env.get("IP_HASH_SALT") ?? "";
  const data = new TextEncoder().encode(ip + salt);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return errorResponse("bad_request", "Method not allowed", corsHeaders());
  }

  let body: ProxyRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON", corsHeaders());
  }

  const { install_id, mode, payload } = body;

  if (!install_id || !UUID_RE.test(install_id)) {
    return errorResponse("bad_request", "Invalid install_id", corsHeaders());
  }
  if (!VALID_MODES.includes(mode)) {
    return errorResponse("bad_request", "Invalid mode", corsHeaders());
  }
  if (!payload || typeof payload !== "object") {
    return errorResponse("bad_request", "Missing payload", corsHeaders());
  }

  if (containsPdf(payload)) {
    return errorResponse(
      "bad_request",
      "PDF analysis requires your own OpenAI API key. The free tier cannot handle documents this large. Add your key in Focal's Options page to analyze PDFs.",
      corsHeaders(),
    );
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const config = await loadConfig(db);

  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ipHash = clientIp ? await hashIp(clientIp) : null;

  const quota = await checkQuota(db, config, install_id, mode, ipHash);
  if (!quota.ok) {
    const refusalHeaders: Record<string, string> = { ...corsHeaders() };
    if (quota.remaining !== undefined) {
      refusalHeaders["X-Quota-Remaining"] = String(quota.remaining);
    }
    return errorResponse(quota.code, quota.message, refusalHeaders);
  }

  const quotaHeaders: Record<string, string> = {
    ...corsHeaders(),
    "X-Quota-Remaining": String(
      Math.max(0, quota.install.requests_limit - quota.install.requests_used),
    ),
  };

  payload.model = config.model;

  const apiKey = Deno.env.get("OPENAI_API_KEY")!;
  const startTime = Date.now();
  const logBase = { install_id, mode, ts: new Date().toISOString() };
  const isStreaming = payload.stream === true;
  const isResponsesApi = RESPONSES_API_MODES.has(mode);
  const reservedCost = quota.reservedCost;

  if (isStreaming) {
    try {
      const { stream, usage } = proxyStreaming(apiKey, payload);

      usage.then(async (u) => {
        console.log(JSON.stringify({
          ...logBase, status: "ok", latency_ms: Date.now() - startTime, ...u,
        }));
        await recordUsage(db, install_id, mode, u, "ok", reservedCost);
      }).catch(async () => {
        console.log(JSON.stringify({
          ...logBase, status: "upstream_error", latency_ms: Date.now() - startTime,
        }));
        await recordUsage(db, install_id, mode, null, "upstream_error", reservedCost);
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          ...quotaHeaders,
        },
      });
    } catch {
      console.log(JSON.stringify({ ...logBase, status: "upstream_error" }));
      await recordUsage(db, install_id, mode, null, "upstream_error", reservedCost);
      return errorResponse("upstream_error", "Failed to process request", quotaHeaders);
    }
  }

  try {
    const { body: responseBody, usage } = await proxyNonStreaming(
      apiKey,
      payload,
      isResponsesApi,
    );

    console.log(JSON.stringify({
      ...logBase,
      status: "ok",
      latency_ms: Date.now() - startTime,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
    }));
    await recordUsage(db, install_id, mode, usage, "ok", reservedCost);

    return new Response(JSON.stringify(responseBody), {
      headers: { "content-type": "application/json", ...quotaHeaders },
    });
  } catch {
    console.log(JSON.stringify({
      ...logBase, status: "upstream_error", latency_ms: Date.now() - startTime,
    }));
    await recordUsage(db, install_id, mode, null, "upstream_error", reservedCost);
    return errorResponse("upstream_error", "Failed to process request", quotaHeaders);
  }
});
