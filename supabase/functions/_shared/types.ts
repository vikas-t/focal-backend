export interface ProxyRequest {
  install_id: string;
  mode: string;
  payload: Record<string, unknown>;
}

export type ErrorCode =
  | "quota_exhausted"
  | "mode_requires_key"
  | "service_paused"
  | "rate_limited"
  | "upstream_error"
  | "bad_request";

export interface AppConfig {
  free_requests_per_install: number;
  daily_spend_cap_usd: number;
  rate_limit_per_minute: number;
  model: string;
  kill_switch: boolean;
}

export interface UsageInfo {
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export const VALID_MODES = ["explain", "summarize", "validate", "worth_reading"];

export const RESPONSES_API_MODES = new Set(["validate"]);
