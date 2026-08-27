import type { UsageInfo } from "./types.ts";

const CHAT_URL = "https://api.openai.com/v1/chat/completions";
const RESPONSES_URL = "https://api.openai.com/v1/responses";

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...payload };
  delete clean.api_key;
  delete clean.authorization;
  return clean;
}

export async function proxyNonStreaming(
  apiKey: string,
  payload: Record<string, unknown>,
  isResponsesApi: boolean,
): Promise<{ body: Record<string, unknown>; usage: UsageInfo }> {
  const url = isResponsesApi ? RESPONSES_URL : CHAT_URL;
  const clean = sanitizePayload(payload);
  clean.stream = false;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(clean),
  });

  if (!resp.ok) {
    const status = resp.status;
    // Read and discard the body — never forward it (may contain org info)
    await resp.text().catch(() => {});
    throw new Error(`OpenAI returned HTTP ${status}`);
  }

  const data = await resp.json();

  // Chat Completions: data.usage.prompt_tokens / completion_tokens
  // Responses API:    data.usage.input_tokens  / output_tokens
  const usage: UsageInfo = {
    prompt_tokens: data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? null,
    completion_tokens: data.usage?.completion_tokens ?? data.usage?.output_tokens ?? null,
  };

  return { body: data, usage };
}

export function proxyStreaming(
  apiKey: string,
  payload: Record<string, unknown>,
): { stream: ReadableStream<Uint8Array>; usage: Promise<UsageInfo> } {
  const clean = sanitizePayload(payload);
  clean.stream = true;
  clean.stream_options = { include_usage: true };

  let resolveUsage: (u: UsageInfo) => void;
  let rejectUsage: (e: Error) => void;
  const usagePromise = new Promise<UsageInfo>((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });

  const decoder = new TextDecoder();
  let captured: UsageInfo = { prompt_tokens: null, completion_tokens: null };

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const resp = await fetch(CHAT_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(clean),
        });

        if (!resp.ok) {
          await resp.text().catch(() => {});
          const errEvent = `data: ${JSON.stringify({ error: { message: "upstream error" } })}\n\n`;
          controller.enqueue(new TextEncoder().encode(errEvent));
          controller.close();
          rejectUsage!(new Error(`OpenAI returned HTTP ${resp.status}`));
          return;
        }

        const reader = resp.body!.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Pass through to client immediately
          controller.enqueue(value);

          // Also parse for usage data
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;

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
              // not valid JSON, skip
            }
          }
        }

        controller.close();
        resolveUsage!(captured);
      } catch (err) {
        controller.error(err);
        rejectUsage!(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  return { stream: readable, usage: usagePromise };
}
