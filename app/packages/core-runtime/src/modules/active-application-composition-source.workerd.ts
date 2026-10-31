import { env } from 'cloudflare:workers';
import { Duration, Effect, Layer } from 'effect';

import { ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY } from './active-application-composition-edge.ts';
import { ONTOS_APPLICATION_COMPOSITION_MAX_BYTES } from './application-composition-limits.ts';
import { ActiveApplicationCompositionSourceReadError } from './active-application-composition-source-errors.ts';
import {
  ActiveApplicationCompositionSource,
  requestScopedActiveApplicationCompositionSource,
} from './active-application-composition-source-service.ts';

const KV_READ_TIMEOUT = Duration.seconds(5);

/**
 * A placed Worker reads the snapshot the stage deploy wrote to its `ONTOS_ACTIVE_APPLICATION_COMPOSITION`
 * Workers KV binding. The edge dispatcher builds this Layer anew for each HTTP request: repeated
 * loads within that request share one wire observation, while the next request reads KV again.
 * This source cache never crosses request boundaries; consumers still validate the lease on every
 * load, and a missing binding or key fails closed.
 * The value is read as one buffer: KV values are bounded, and a per-chunk stream fold cost more CPU than
 * the whole snapshot decode on a fresh isolate.
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
    // @effect-diagnostics-next-line asyncFunction:off -- Workers KV is a native Promise boundary; all request orchestration stays in Effect.
    try: async () => await binding.get(ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY, 'arrayBuffer'),
  });
  if (snapshot === null) {
    return yield* new ActiveApplicationCompositionSourceReadError({
      reason: 'The ONTOS_ACTIVE_APPLICATION_COMPOSITION Workers KV binding holds no snapshot',
    });
  }
  if (snapshot.byteLength > ONTOS_APPLICATION_COMPOSITION_MAX_BYTES) {
    return yield* new ActiveApplicationCompositionSourceReadError({
      reason: `The active Application Composition snapshot exceeds ${ONTOS_APPLICATION_COMPOSITION_MAX_BYTES} bytes`,
    });
  }
  return yield* Effect.try({
    catch: (cause) =>
      new ActiveApplicationCompositionSourceReadError({ cause, reason: 'The Workers KV snapshot is not UTF-8 text' }),
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(snapshot),
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

export const ActiveApplicationCompositionSourceLive = load.pipe(
  requestScopedActiveApplicationCompositionSource,
  Layer.effect(ActiveApplicationCompositionSource),
);
