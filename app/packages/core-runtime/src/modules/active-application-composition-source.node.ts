import {
  Clock,
  Config,
  ConfigProvider,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Hash,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import type { Scope } from 'effect';
import { FetchHttpClient, Headers, HttpClient } from 'effect/http';

import { ONTOS_APPLICATION_COMPOSITION_MAX_BYTES } from './application-composition-limits.ts';
import { ActiveApplicationCompositionSourceReadError } from './active-application-composition-source-errors.ts';
import { ActiveApplicationCompositionSource } from './active-application-composition-source-service.ts';

const SNAPSHOT_READ_TIMEOUT = Duration.seconds(5);
const SNAPSHOT_CACHE_TTL_MS = 30_000;
const SnapshotDeadline = Schema.fromJsonString(Schema.Struct({ validUntil: Schema.DateTimeUtcFromString }));

/** One successful read of a source: plain data, so independently bundled owners in one process can share it. */
export interface SharedSnapshotRead {
  readonly encoded: string;
  readonly etag: string | undefined;
  /** Reused without asking the source until then: at most 30 seconds, never beyond the authority deadline. */
  readonly freshUntil: number;
  readonly validUntil: number;
}

/** The last successful read per source and credential. */
export type CompositionSourceReads = Map<string, SharedSnapshotRead>;

declare global {
  /**
   * Installed once by the process host (`scripts/zerops/process-composition-source-reads.mts`): every owner bundle and
   * Outbox loop of the process shares these reads.
   */
  var ontosCompositionSourceReads: CompositionSourceReads | undefined;
}

const freshness = (validUntil: number, now: number) => Math.min(now + SNAPSHOT_CACHE_TTL_MS, validUntil);

/** Separate credentials never share a read; the key holds only a hash of the token. */
const readKey = (url: URL, token: Option.Option<Redacted.Redacted>) =>
  Option.match(token, {
    onNone: () => url.href,
    onSome: (secret) => `${url.href}#${String(Hash.string(Redacted.value(secret)))}`,
  });

const requestHeaders = (held: SharedSnapshotRead | undefined, token: Option.Option<Redacted.Redacted>) => {
  const conditional =
    held?.etag === undefined
      ? Headers.fromInput({ 'cache-control': 'no-cache' })
      : Headers.fromInput({ 'cache-control': 'no-cache', 'if-none-match': held.etag });
  return Option.isSome(token)
    ? Headers.set(conditional, 'authorization', `Bearer ${Redacted.value(token.value)}`)
    : conditional;
};

/** A 304 confirms only the very bytes whose ETag was sent. */
const confirmedRead = (held: SharedSnapshotRead | undefined, status: number, etag: string | undefined, now: number) =>
  status === 304 && held?.etag !== undefined && etag === held.etag
    ? Option.some<SharedSnapshotRead>({ ...held, freshUntil: freshness(held.validUntil, now) })
    : Option.none<SharedSnapshotRead>();

/**
 * The publisher atomically replaces this trusted runtime URL's complete snapshot. A single successful
 * value and concurrent reads are coalesced for at most 30 seconds and never beyond its authority
 * deadline. Failures are not cached, and every consumer still validates the original lease. Deployment
 * may point the URL directly at the Cloudflare KV REST value endpoint with a read-only token.
 *
 * Every owner bundle and Outbox loop of a process builds this layer, and each used to read and parse the whole
 * snapshot on its own every 30 seconds. Under a process host they share the last read (keyed by source and
 * credential, installed by the host): within its freshness nobody asks again, and afterwards the source
 * is asked with that read's ETag, so an unchanged snapshot is confirmed by a 304 without transferring, decoding or
 * parsing it again. A 304 is only accepted for the read whose ETag was sent; any other answer or failure is not
 * cached and never falls back to the previous bytes.
 */
export const ActiveApplicationCompositionSourceLive = Layer.effect(ActiveApplicationCompositionSource)(
  Effect.gen(function* nodeSourceLayer() {
    const sourceFetch = yield* FetchHttpClient.Fetch;
    const sourceRequestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
    // FetchHttpClient resolves transport options from each executing fiber. Pin only the
    // authoritative transport keys; request Scope, tracing and cancellation stay local.
    const client = HttpClient.transformResponse(
      HttpClient.withScope(yield* HttpClient.HttpClient),
      Effect.updateContext((context: Context.Context<Scope.Scope>) => {
        const transport = Context.add(context, FetchHttpClient.Fetch, sourceFetch);
        return Option.isSome(sourceRequestInit)
          ? Context.add(transport, FetchHttpClient.RequestInit, sourceRequestInit.value)
          : Context.omit(FetchHttpClient.RequestInit)(transport);
      }),
    );
    const clock = yield* Clock.Clock;
    const configuration = yield* ConfigProvider.ConfigProvider;
    const layerReads: CompositionSourceReads = new Map();
    const reads = () => globalThis.ontosCompositionSourceReads ?? layerReads;
    const read = Effect.gen(function* readNodeSnapshot() {
      const configuredUrl = yield* Config.String('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL')
        .parse(configuration)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ActiveApplicationCompositionSourceReadError({
                cause: Redacted.make(cause),
                reason: 'The ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL configuration is required',
              }),
          ),
        );
      if (!URL.canParse(configuredUrl)) {
        return yield* new ActiveApplicationCompositionSourceReadError({
          reason: 'The active Application Composition source URL is invalid',
        });
      }
      const url = new URL(configuredUrl);
      const loopback =
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]' ||
        url.hostname.endsWith('.localhost');
      if (
        !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== ''
      ) {
        return yield* new ActiveApplicationCompositionSourceReadError({
          reason:
            'The active Application Composition source requires HTTPS or loopback HTTP without credentials, query, or fragment',
        });
      }
      const token = yield* Config.option(Config.Redacted('ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN'))
        .parse(configuration)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ActiveApplicationCompositionSourceReadError({
                cause: Redacted.make(cause),
                reason: 'The active Application Composition source read-token configuration is invalid',
              }),
          ),
        );
      const key = readKey(url, token);
      const now = clock.currentTimeMillisUnsafe();
      const held = reads().get(key);
      if (held !== undefined && now < held.freshUntil) {
        return held;
      }
      const response = yield* client.get(url, { headers: requestHeaders(held, token) }).pipe(
        Effect.mapError(
          (cause) =>
            new ActiveApplicationCompositionSourceReadError({
              cause: Redacted.make(cause),
              reason: 'The active Application Composition source read failed',
            }),
        ),
      );
      const confirmed = confirmedRead(held, response.status, response.headers['etag'], now);
      if (Option.isSome(confirmed)) {
        reads().set(key, confirmed.value);
        return confirmed.value;
      }
      if (response.status !== 200) {
        return yield* new ActiveApplicationCompositionSourceReadError({
          reason: `The active Application Composition source returned HTTP ${response.status}`,
        });
      }
      const body = yield* Stream.runFoldEffect(
        response.stream.pipe(
          Stream.mapError(
            (cause) =>
              new ActiveApplicationCompositionSourceReadError({
                cause: Redacted.make(cause),
                reason: 'The active Application Composition source body read failed',
              }),
          ),
        ),
        () => {
          const chunks: Uint8Array[] = [];
          return { byteLength: 0, chunks };
        },
        (folded, chunk) => {
          const byteLength = folded.byteLength + chunk.byteLength;
          return byteLength > ONTOS_APPLICATION_COMPOSITION_MAX_BYTES
            ? Effect.fail(
                new ActiveApplicationCompositionSourceReadError({
                  reason: `The active Application Composition snapshot exceeds ${ONTOS_APPLICATION_COMPOSITION_MAX_BYTES} bytes`,
                }),
              )
            : Effect.sync(() => {
                folded.chunks.push(chunk);
                return { byteLength, chunks: folded.chunks };
              });
        },
      );
      const encoded = yield* Effect.try({
        catch: (cause) =>
          new ActiveApplicationCompositionSourceReadError({
            cause: Redacted.make(cause),
            reason: 'The active Application Composition snapshot is not UTF-8 text',
          }),
        try: () => {
          const bytes = new Uint8Array(body.byteLength);
          let offset = 0;
          for (const chunk of body.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        },
      });
      const { validUntil } = yield* Schema.decodeEffect(SnapshotDeadline)(encoded).pipe(
        Effect.mapError(
          (cause) =>
            new ActiveApplicationCompositionSourceReadError({
              cause: Redacted.make(cause),
              reason: 'The active Application Composition snapshot has no valid authority deadline',
            }),
        ),
      );
      const validUntilMillis = DateTime.toEpochMillis(validUntil);
      const fetched: SharedSnapshotRead = {
        encoded,
        etag: response.headers['etag'],
        freshUntil: freshness(validUntilMillis, now),
        validUntil: validUntilMillis,
      };
      reads().set(key, fetched);
      return fetched;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: SNAPSHOT_READ_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ActiveApplicationCompositionSourceReadError({
              reason: 'The active Application Composition source read timed out',
            }),
          ),
      }),
    );
    const cached = yield* Effect.cachedWithTTL(read, (exit) =>
      Exit.isSuccess(exit)
        ? Duration.millis(
            Math.max(0, Math.min(SNAPSHOT_CACHE_TTL_MS, exit.value.validUntil - clock.currentTimeMillisUnsafe())),
          )
        : Duration.zero,
    );
    const load = cached.pipe(Effect.map(({ encoded }) => encoded));
    return Object.freeze({ load });
  }),
);
