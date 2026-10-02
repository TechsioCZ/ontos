import {
  Clock,
  Config,
  ConfigProvider,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { Headers, HttpClient } from 'effect/unstable/http';

import { ONTOS_APPLICATION_COMPOSITION_MAX_BYTES } from './application-composition-limits.ts';
import { ActiveApplicationCompositionSourceReadError } from './active-application-composition-source-errors.ts';
import { ActiveApplicationCompositionSource } from './active-application-composition-source-service.ts';

const SNAPSHOT_READ_TIMEOUT = Duration.seconds(5);
const SNAPSHOT_CACHE_TTL_MS = 30_000;
const SnapshotDeadline = Schema.fromJsonString(Schema.Struct({ validUntil: Schema.DateTimeUtcFromString }));

/**
 * The publisher atomically replaces this trusted runtime URL's complete snapshot. A single successful
 * value and concurrent reads are coalesced for at most 30 seconds and never beyond its authority
 * deadline. Failures are not cached, and every consumer still validates the original lease. Deployment
 * may point the URL directly at the Cloudflare KV REST value endpoint with a read-only token.
 */
export const ActiveApplicationCompositionSourceLive = Layer.effect(ActiveApplicationCompositionSource)(
  Effect.gen(function* nodeSourceLayer() {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const clock = yield* Clock.Clock;
    const configuration = yield* ConfigProvider.ConfigProvider;
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
      const headers = Headers.fromInput({ 'cache-control': 'no-cache' });
      const response = yield* client
        .get(url, {
          headers: Option.isSome(token)
            ? Headers.set(headers, 'authorization', `Bearer ${Redacted.value(token.value)}`)
            : headers,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ActiveApplicationCompositionSourceReadError({
                cause: Redacted.make(cause),
                reason: 'The active Application Composition source read failed',
              }),
          ),
        );
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
        (previous, chunk) => {
          const byteLength = previous.byteLength + chunk.byteLength;
          return byteLength > ONTOS_APPLICATION_COMPOSITION_MAX_BYTES
            ? Effect.fail(
                new ActiveApplicationCompositionSourceReadError({
                  reason: `The active Application Composition snapshot exceeds ${ONTOS_APPLICATION_COMPOSITION_MAX_BYTES} bytes`,
                }),
              )
            : Effect.sync(() => {
                previous.chunks.push(chunk);
                return { byteLength, chunks: previous.chunks };
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
      return {
        encoded,
        validUntil: DateTime.toEpochMillis(validUntil),
      };
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
