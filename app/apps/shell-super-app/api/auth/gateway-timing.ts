import { Clock, Context, Effect, Exit, Schema } from 'effect';

/** Fixed names only: timing diagnostics must never contain credentials, identities or request data. */
const GatewayPhaseSchema = Schema.Literals([
  'document-authentication',
  'document-admission',
  'document-composition',
  'document-home',
  'document-assertions',
  'session-read',
  'session-principal',
  'session-legal-entities',
  'session-tenants',
  'gateway-release',
  'key-verify',
  'principal-resolve',
  'legal-entity-sql',
  'legal-entity-spicedb',
  'assertion-issue',
  'owner-dispatch',
]);
type GatewayPhase = typeof GatewayPhaseSchema.Type;

/**
 * Whether this request's gateway phases are measured. The Shell API root turns it on for each gateway request; each
 * phase is logged when it ends, fixed names and milliseconds only. No client ever receives them: no Shell response
 * carries `server-timing` (`../no-server-timing.ts`).
 */
export class GatewayTimings extends Context.Reference<boolean>(
  '@app/shell-super-app/api/auth/gateway-timing/GatewayTimings',
  {
    defaultValue: () => false,
  },
) {}

const logGatewayPhase = Effect.fn('GatewayTiming.record')(function* logGatewayPhaseEffect<Value, Failure>(
  phase: GatewayPhase,
  startedAt: number,
  exit: Exit.Exit<Value, Failure>,
) {
  const finishedAt = yield* Clock.currentTimeMillis;
  const durationMs = Math.max(0, finishedAt - startedAt);
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
    if (!(yield* GatewayTimings)) {
      return yield* effect;
    }
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(Effect.onExit((exit) => logGatewayPhase(phase, startedAt, exit)));
  });
