import { HttpEffect, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Clock, Context, Effect, Exit, Option, Ref, Schema } from 'effect';

/** Fixed names only: timing diagnostics must never contain credentials, identities or request data. */
const GatewayPhaseSchema = Schema.Literals([
  'gateway-release',
  'key-verify',
  'principal-resolve',
  'legal-entity-sql',
  'legal-entity-spicedb',
  'assertion-issue',
  'owner-dispatch',
]);
export type GatewayPhase = typeof GatewayPhaseSchema.Type;

interface GatewayTiming {
  readonly durationMs: number;
  readonly phase: GatewayPhase;
}

export class GatewayTimings extends Context.Reference<Option.Option<Ref.Ref<readonly GatewayTiming[]>>>(
  '@app/shell-super-app/api/auth/gateway-timing/GatewayTimings',
  { defaultValue: Option.none },
) {}

export const gatewayServerTiming = (timings: readonly GatewayTiming[]): string =>
  timings.map(({ durationMs, phase }) => `${phase};dur=${durationMs}`).join(', ');

const recordGatewayTiming = Effect.fn('GatewayTiming.record')(function* recordGatewayTimingEffect<Value, Failure>(
  timings: Ref.Ref<readonly GatewayTiming[]>,
  phase: GatewayPhase,
  startedAt: number,
  exit: Exit.Exit<Value, Failure>,
) {
  const finishedAt = yield* Clock.currentTimeMillis;
  const durationMs = Math.max(0, finishedAt - startedAt);
  yield* Ref.update(timings, (entries) => [...entries, { durationMs, phase }]);
  yield* (
    Exit.isFailure(exit)
      ? Effect.logWarning('Shell gateway phase failed')
      : Effect.logInfo('Shell gateway phase completed')
  ).pipe(Effect.annotateLogs({ durationMs, gatewayPhase: phase }));
});

/** Request-local values only; also records failed phases without exposing their errors. */
export const observeGatewayPhase = (phase: GatewayPhase) =>
  Effect.fn('GatewayTiming.observePhase')(function* observeGatewayPhaseEffect<Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ) {
    const timings = yield* GatewayTimings;
    if (Option.isNone(timings)) {
      return yield* effect;
    }
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(Effect.onExit((exit) => recordGatewayTiming(timings.value, phase, startedAt, exit)));
  });

/** The HTTP boundary installs this fresh collector and hook for each request, including error responses. */
export const gatewayTimingCollector = Effect.gen(function* gatewayTimingCollectorEffect() {
  const timings = yield* Ref.make<readonly GatewayTiming[]>([]);
  const appendResponseHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
    Ref.get(timings).pipe(
      Effect.map((entries) =>
        entries.length === 0
          ? response
          : HttpServerResponse.setHeader(response, 'server-timing', gatewayServerTiming(entries)),
      ),
    ),
  );
  return { appendResponseHeader, timings };
});
