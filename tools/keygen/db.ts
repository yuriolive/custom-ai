/**
 * The database seam.
 *
 * `KeyStore` is the whole surface the commands touch, so tests can substitute an
 * in-memory double and need no live Postgres, while `PostgrestKeyStore` is the
 * only implementation that talks to a real instance. Same interface, so the live
 * smoke test exercises the identical code path as the unit tests.
 *
 * Zero dependencies: PostgREST over `fetch`, matching tools/mock-upstream. The
 * service role key is sent in headers only and is never logged, never persisted,
 * and never included in an error message (see redact()).
 */

/**
 * Columns this tool is allowed to read out of `api_keys`.
 *
 * `key_hash` is DELIBERATELY ABSENT. It is not a secret in the plaintext sense —
 * it is not reversible — but it is the exact value the gateway compares against,
 * so it has no business in a terminal, a scrollback buffer, or a CI log. Asserted
 * by test/key.test.ts.
 */
export const SAFE_KEY_COLUMNS = [
  "id",
  "user_id",
  "name",
  "key_prefix",
  "scopes",
  "last_used_at",
  "request_count",
  "revoked_at",
  "created_at",
] as const;

export interface ProfileRef {
  id: string;
  handle: string;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  request_count: number;
  revoked_at: string | null;
  created_at: string;
}

export interface NewApiKey {
  user_id: string;
  name: string;
  /** SHA-256 hex. The ONLY form of the key that is ever persisted. */
  key_hash: string;
  key_prefix: string;
}

export interface KeyStore {
  /** Resolve a profile by handle or by uuid. Returns null when unknown. */
  findProfile(ref: string): Promise<ProfileRef | null>;
  insertKey(row: NewApiKey): Promise<ApiKeyRow>;
  listKeys(userId: string): Promise<ApiKeyRow[]>;
  /** Locate candidate keys by uuid or by the 16-char display prefix. */
  findKeys(selector: string): Promise<ApiKeyRow[]>;
  /** Sets revoked_at. Idempotent at the DB level; already-revoked keys keep their timestamp. */
  revokeKey(id: string): Promise<ApiKeyRow>;
}

export class StoreError extends Error {}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export class PostgrestKeyStore implements KeyStore {
  readonly #base: string;
  readonly #headers: Record<string, string>;
  readonly #serviceRoleKey: string;

  constructor(url: string, serviceRoleKey: string) {
    this.#base = `${url.replace(/\/+$/, "")}/rest/v1`;
    this.#serviceRoleKey = serviceRoleKey;
    this.#headers = {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      accept: "application/json",
    };
  }

  async findProfile(ref: string): Promise<ProfileRef | null> {
    const filter = isUuid(ref)
      ? `id=eq.${encodeURIComponent(ref)}`
      : `handle=eq.${encodeURIComponent(ref)}`;
    const rows = await this.#request<ProfileRef[]>(
      `/profiles?select=id,handle&${filter}&limit=2`,
    );
    if (rows.length === 0) return null;
    return rows[0]!;
  }

  async insertKey(row: NewApiKey): Promise<ApiKeyRow> {
    const rows = await this.#request<ApiKeyRow[]>(
      `/api_keys?select=${SAFE_KEY_COLUMNS.join(",")}`,
      { method: "POST", body: JSON.stringify(row), prefer: "return=representation" },
    );
    const created = rows[0];
    if (!created) throw new StoreError("Insert returned no row.");
    return created;
  }

  async listKeys(userId: string): Promise<ApiKeyRow[]> {
    return this.#request<ApiKeyRow[]>(
      `/api_keys?select=${SAFE_KEY_COLUMNS.join(",")}` +
        `&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`,
    );
  }

  async findKeys(selector: string): Promise<ApiKeyRow[]> {
    const filter = isUuid(selector)
      ? `id=eq.${encodeURIComponent(selector)}`
      : `key_prefix=eq.${encodeURIComponent(selector)}`;
    return this.#request<ApiKeyRow[]>(
      `/api_keys?select=${SAFE_KEY_COLUMNS.join(",")}&${filter}&order=created_at.desc`,
    );
  }

  async revokeKey(id: string): Promise<ApiKeyRow> {
    const rows = await this.#request<ApiKeyRow[]>(
      `/api_keys?select=${SAFE_KEY_COLUMNS.join(",")}&id=eq.${encodeURIComponent(id)}` +
        `&revoked_at=is.null`,
      {
        method: "PATCH",
        body: JSON.stringify({ revoked_at: new Date().toISOString() }),
        prefer: "return=representation",
      },
    );
    const updated = rows[0];
    if (!updated) throw new StoreError(`Key ${id} was not updated (already revoked?).`);
    return updated;
  }

  async #request<T>(
    path: string,
    init: { method?: string; body?: string; prefer?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...this.#headers };
    if (init.prefer) headers["prefer"] = init.prefer;

    let res: Response;
    try {
      res = await fetch(`${this.#base}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
      });
    } catch (cause) {
      throw new StoreError(
        `Cannot reach Supabase at ${this.#base}. Is it running? (${this.#redact(String(cause))})`,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new StoreError(`Supabase ${res.status}: ${this.#redact(text) || res.statusText}`);
    }
    if (!text) return [] as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new StoreError(`Supabase returned non-JSON: ${this.#redact(text).slice(0, 200)}`);
    }
  }

  /**
   * Belt-and-braces: a PostgREST error body can echo a request header back. The
   * service role key must never surface in anything this process prints.
   */
  #redact(text: string): string {
    if (!this.#serviceRoleKey) return text;
    return text.split(this.#serviceRoleKey).join("«redacted»");
  }
}
