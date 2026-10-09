import { env } from 'cloudflare:workers';
import { Duration, Effect, Layer, Stream } from 'effect';

import { ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY } from './active-application-composition-edge.ts';
import { ONTOS_APPLICATION_COMPOSITION_MAX_BYTES } from './application-composition-limits.ts';
import { ActiveApplicationCompositionSourceReadError } from './active-application-composition-source-errors.ts';
import { ActiveApplicationCompositionSource } from './active-application-composition-source-service.ts';

const KV_READ_TIMEOUT = Duration.seconds(5);

/**
 * A placed Worker reads the snapshot the stage deploy wrote to its `ONTOS_ACTIVE_APPLICATION_COMPOSITION`
 * Workers KV binding. Every read goes to KV, so a new publication reaches the Worker within KV's
 * propagation time and no isolate keeps an expired observation; a missing binding or key fails closed.
 */
const load = Effect.gen(function* readEdgeSnapshot() {
  const binding = env.ONTOS_ACTIVE_APPLICATION_COMPOSITION;
  if (binding === undefined) {
    return yield* new ActiveApplicationCompositionSourceReadError({
      reason: 'The ONTOS_ACTIVE_APPLICATION_COMPOSITION Workers KV binding is required',
    });
  }
  const snapshot = yield* Effect.tryPromise({
    catch: (cause) =>
      new ActiveApplicationCompositionSourceReadError({ cause, reason: 'The Workers KV snapshot read failed' }),
    try: (signal): PromiseLike<Awaited<ReturnType<typeof binding.get>>> =>
      binding
        .get(ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY, 'stream')
        .then((stream): Awaited<ReturnType<typeof binding.get>> | PromiseLike<ReadableStream<Uint8Array>> =>
          !signal.aborted || stream === null
            ? stream
            : stream.cancel().then(
                () => stream,
                () => stream,
              ),
        ),
  });
  if (snapshot === null) {
    return yield* new ActiveApplicationCompositionSourceReadError({
      reason: 'The ONTOS_ACTIVE_APPLICATION_COMPOSITION Workers KV binding holds no snapshot',
    });
  }
  const body = yield* Stream.runFoldEffect(
    Stream.fromReadableStream({
      evaluate: () => snapshot,
      onError: (cause) =>
        new ActiveApplicationCompositionSourceReadError({ cause, reason: 'The Workers KV body read failed' }),
    }),
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
  return yield* Effect.try({
    catch: (cause) =>
      new ActiveApplicationCompositionSourceReadError({ cause, reason: 'The Workers KV snapshot is not UTF-8 text' }),
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
}).pipe(
  Effect.timeoutOrElse({
    duration: KV_READ_TIMEOUT,
    orElse: () =>
      Effect.fail(
        new ActiveApplicationCompositionSourceReadError({ reason: 'The Workers KV snapshot read timed out' }),
      ),
  }),
);

export const ActiveApplicationCompositionSourceLive = Layer.succeed(
  ActiveApplicationCompositionSource,
  Object.freeze({ load }),
);
