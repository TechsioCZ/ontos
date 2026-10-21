/**
 * Idempotent replay of direct writes. OntOS hashes each Action request including the expectedRevision the RS fills in,
 * so a client retry with the same idempotencyKey would otherwise get 409 once the revision moved on. The first result
 * is kept per (grant, key) for a day; the same key with a different input is refused.
 */
import { createHash } from 'node:crypto';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5_000;

interface Entry {
  readonly hash: string;
  readonly result: Readonly<Record<string, unknown>>;
  readonly at: number;
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

export const requestHash = (id: string, input: unknown): string =>
  createHash('sha256').update(`${id}\n${stableJson(input)}`).digest('hex');

export type ReplayLookup =
  | { readonly kind: 'miss' }
  | { readonly kind: 'hit'; readonly result: Readonly<Record<string, unknown>> }
  | { readonly kind: 'conflict' };

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

/** Process-wide cache shared by every request of the resource server. */
export const directReplays = new DirectReplayCache();
