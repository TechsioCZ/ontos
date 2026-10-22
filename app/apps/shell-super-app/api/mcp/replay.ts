/**
 * Idempotent replay of direct writes. OntOS hashes each Action request including the expectedRevision the Shell
 * fills in, so a client retry with the same idempotencyKey would otherwise get 409 once the revision moved on. The
 * first result is kept per (grant, key) for a day in this isolate; the same key with a different input is refused.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

interface Entry {
  readonly at: number;
  readonly hash: string;
  readonly result: Readonly<Record<string, unknown>>;
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** SHA-256 of the tool id and its canonical input (Web Crypto: Node and workerd). */
export const requestHash = async (id: string, input: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${id}\n${stableJson(input)}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export type ReplayLookup =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'hit'; readonly result: Readonly<Record<string, unknown>> }
  | { readonly kind: 'miss' };

export class DirectReplayCache {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  lookup(grantId: string, key: string, hash: string): ReplayLookup {
    const entry = this.#entries.get(`${grantId}\n${key}`);
    if (entry === undefined || this.#now() - entry.at > TTL_MS) {
      return { kind: 'miss' };
    }
    return entry.hash === hash ? { kind: 'hit', result: entry.result } : { kind: 'conflict' };
  }

  remember(grantId: string, key: string, hash: string, result: Readonly<Record<string, unknown>>): void {
    if (this.#entries.size >= MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) {
        this.#entries.delete(oldest);
      }
    }
    this.#entries.set(`${grantId}\n${key}`, { at: this.#now(), hash, result });
  }
}

export const directReplays = new DirectReplayCache();
