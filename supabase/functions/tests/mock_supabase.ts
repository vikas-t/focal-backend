// Minimal mock of the Supabase client for unit testing.
// Covers .from().select/insert/update/eq/gte/maybeSingle and .rpc().

type Row = Record<string, unknown>;

interface MockTableConfig {
  rows?: Row[];
  error?: { message: string };
  count?: number;
  rpcResult?: unknown;
  rpcError?: { message: string };
  insertError?: { message: string };
}

export interface MockConfig {
  tables: Record<string, MockTableConfig>;
}

class MockQueryBuilder {
  private cfg: MockTableConfig;
  private filters: Array<{ col: string; op: string; val: unknown }> = [];
  private headOnly = false;
  private countMode = false;

  constructor(cfg: MockTableConfig) {
    this.cfg = cfg;
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.headOnly = true;
    if (opts?.count) this.countMode = true;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }

  gte(col: string, val: unknown) {
    this.filters.push({ col, op: "gte", val });
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: unknown }> {
    if (this.cfg.error) return { data: null, error: this.cfg.error };
    const rows = this.applyFilters();
    return { data: rows[0] ?? null, error: null };
  }

  async insert(row: Row) {
    if (this.cfg.insertError) return { data: null, error: this.cfg.insertError };
    this.cfg.rows = this.cfg.rows ?? [];
    this.cfg.rows.push(row);
    return { data: row, error: null };
  }

  update(_row: Row) {
    // Return a chainable builder (update().eq() pattern)
    return this;
  }

  async then(resolve: (val: { data: Row[] | null; error: unknown; count?: number }) => void) {
    if (this.cfg.error) {
      resolve({ data: null, error: this.cfg.error });
      return;
    }
    if (this.countMode && this.headOnly) {
      resolve({ data: null, error: null, count: this.cfg.count ?? 0 });
      return;
    }
    resolve({ data: this.applyFilters(), error: null });
  }

  private applyFilters(): Row[] {
    return this.cfg.rows ?? [];
  }
}

export function createMockClient(config: MockConfig) {
  return {
    from(table: string) {
      const cfg = config.tables[table] ?? { rows: [] };
      return new MockQueryBuilder(cfg);
    },
    async rpc(name: string, _params?: Record<string, unknown>) {
      // Look for rpc config under a special key
      const cfg = config.tables[`rpc:${name}`] ?? {};
      if (cfg.rpcError) return { data: null, error: cfg.rpcError };
      return { data: cfg.rpcResult ?? null, error: null };
    },
  };
}

export function defaultConfig(): MockConfig {
  return {
    tables: {
      config: {
        rows: [
          { key: "free_requests_per_install", value: 20 },
          { key: "daily_spend_cap_usd", value: 3.0 },
          { key: "rate_limit_per_minute", value: 10 },
          { key: "model", value: "gpt-4o-mini" },
          { key: "kill_switch", value: false },
        ],
      },
      daily_spend: { rows: [] },
      installs: { rows: [] },
      usage_events: { rows: [], count: 0 },
      "rpc:upsert_install": {
        rpcResult: {
          install_id: "550e8400-e29b-41d4-a716-446655440000",
          requests_used: 0,
          requests_limit: 20,
        },
      },
    },
  };
}
