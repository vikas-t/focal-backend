import type { ErrorCode } from "./types.ts";

const HTTP_STATUS: Record<ErrorCode, number> = {
  quota_exhausted: 403,
  mode_requires_key: 403,
  service_paused: 503,
  rate_limited: 429,
  upstream_error: 502,
  bad_request: 400,
};

export function errorResponse(
  code: ErrorCode,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    {
      status: HTTP_STATUS[code],
      headers: {
        "content-type": "application/json",
        ...extraHeaders,
      },
    },
  );
}
