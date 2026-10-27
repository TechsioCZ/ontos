/**
 * Replay of direct writes is owned by this isolate. Grant/key pairs and canonical request bytes are stable across retries.
 */
import { Array as Arr, Clock, Duration, Effect, Schema } from 'effect';
import type { Crypto } from 'effect';

const TTL_MS = Duration.toMillis(Duration.hours(24));
const MAX_ENTRIES = 5000;

export const DirectReplayResultSchema = Schema.Struct({
  messageCs: Schema.String,
  replayed: Schema.Boolean,
  result: Schema.Json,
  status: Schema.Literal('executed'),
  url: Schema.optionalKey(Schema.String),
});
export type DirectReplayResult = typeof DirectReplayResultSchema.Type;

interface Entry {
  readonly at: number;
  readonly hash: string;
  readonly result: DirectReplayResult;
}

const isJsonArray = Arr.isArray<Schema.Json | undefined>;
const isJsonObject = Schema.is(Schema.JsonObject);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const encodeKey = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

// Preserve the existing protocol: lexical object keys, original array order, JSON scalar escaping and null for absence.
// Encode keys individually: encoding a sorted object would reorder integer-like keys again.
const canonicalRequestJson = (value: Schema.Json | undefined): Effect.Effect<string, Schema.SchemaError> => {
  if (isJsonArray(value)) {
    return Effect.forEach(value, canonicalRequestJson, { concurrency: 1 }).pipe(
      Effect.map((items) => `[${items.join(',')}]`),
    );
  }
  if (isJsonObject(value)) {
    return Effect.forEach(
      Object.keys(value).toSorted(),
      (key) =>
        Effect.all([encodeKey(key), canonicalRequestJson(value[key])], { concurrency: 1 }).pipe(
          Effect.map(([encodedKey, encodedValue]) => `${encodedKey}:${encodedValue}`),
        ),
      { concurrency: 1 },
    ).pipe(Effect.map((entries) => `{${entries.join(',')}}`));
  }
  return value === undefined ? Effect.succeed('null') : encodeJson(value);
};

/** SHA-256 of the tool id, newline and canonical input. A digest failure remains a platform defect. */
export const requestHash = Effect.fn('McpReplay.requestHash')(
  (crypto: Crypto.Crypto, id: string, input: Schema.Json): Effect.Effect<string, Schema.SchemaError> =>
    canonicalRequestJson(input).pipe(
      Effect.flatMap((canonical) =>
        crypto.digest('SHA-256', new TextEncoder().encode(`${id}\n${canonical}`)).pipe(Effect.orDie),
      ),
      Effect.map((digest) => [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')),
    ),
);

export type ReplayLookup =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'hit'; readonly result: DirectReplayResult }
  | { readonly kind: 'miss' };

export class DirectReplayCache {
  readonly #entries = new Map<string, Entry>();

  readonly lookup = Effect.fn('McpReplay.lookup')(
    (grantId: string, key: string, hash: string): Effect.Effect<ReplayLookup> =>
      Effect.sync(() => this.#entries.get(`${grantId}\n${key}`)).pipe(
        Effect.flatMap((entry) =>
          entry === undefined
            ? Effect.succeed<ReplayLookup>({ kind: 'miss' })
            : Clock.currentTimeMillis.pipe(
                Effect.map((now): ReplayLookup => {
                  if (now - entry.at > TTL_MS) {
                    return { kind: 'miss' };
                  }
                  return entry.hash === hash ? { kind: 'hit', result: entry.result } : { kind: 'conflict' };
                }),
              ),
        ),
      ),
  );

  readonly remember = Effect.fn('McpReplay.remember')(
    (grantId: string, key: string, hash: string, result: DirectReplayResult): Effect.Effect<void> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Effect.sync(() => {
            // Keep eviction and insertion synchronous so another fiber cannot interleave them.
            if (this.#entries.size >= MAX_ENTRIES) {
              const oldest = this.#entries.keys().next().value;
              if (oldest !== undefined) {
                this.#entries.delete(oldest);
              }
            }
            this.#entries.set(`${grantId}\n${key}`, { at: now, hash, result });
          }),
        ),
      ),
  );
}

export const directReplays = new DirectReplayCache();
