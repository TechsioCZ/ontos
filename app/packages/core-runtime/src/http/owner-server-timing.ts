/**
 * What one owner request spent its time on, sent back to its caller as one `server-timing` header: the spans the
 * request already emits, counted and summed under fixed names. A caller waiting on this owner (the Shell's approval
 * routes) can then say what the owner was doing, not only how long it took. Fixed names and numbers only, never a
 * query, an identity or a value. Sums of nested or concurrent spans can exceed the request's wall time. A `-count`
 * metric carries a number of spans in its `dur`, not milliseconds.
 */
import { Clock, Effect, Schema, Tracer } from 'effect';
import { HttpEffect, HttpServerResponse } from 'effect/http';

/** The phases an owner request is split into. */
const OwnerPhaseSchema = Schema.Literals(['gate', 'spicedb', 'evidence', 'sql', 'transaction', 'remote']);
type OwnerPhase = typeof OwnerPhaseSchema.Type;

/** The span names that measure each phase. */
const PHASE_OF = new Map<string, OwnerPhase>([
  ['AccessDecisionGate.decide', 'gate'],
  ['AccessDecisionGate.decideMany', 'gate'],
  ['AccessDecisionGate.list', 'gate'],
  ['AccessDecisionGate.listMany', 'gate'],
  ['AccessDecision.spicedbCheckBulk', 'spicedb'],
  ['AccessDecisionLog.record', 'evidence'],
  ['AccessDecisionLog.recordAll', 'evidence'],
  ['ModuleRelease.fetchNode', 'remote'],
  ['ModuleRelease.fetchWorker', 'remote'],
  ['postgres', 'sql'],
  ['sql.transaction', 'transaction'],
]);

const PHASES: readonly OwnerPhase[] = OwnerPhaseSchema.literals;
/** Every phase but evidence (one write per decision batch, timed only) also carries its number of spans. */
const COUNTED: readonly OwnerPhase[] = PHASES.filter((phase) => phase !== 'evidence');

/** The header's metric names, in the order they are sent. */
export const OWNER_TIMING_METRICS: readonly string[] = [
  'owner-total',
  ...PHASES.map((phase) => `owner-${phase}`),
  ...COUNTED.map((phase) => `owner-${phase}-count`),
];

/** A tracer that sums the phases of the spans it sees and passes every span on to `tracer`. */
const makePhaseCounter = (tracer: Tracer.Tracer) => {
  const totals = new Map<OwnerPhase, { count: number; ms: number }>(
    PHASES.map((phase) => [phase, { count: 0, ms: 0 }]),
  );
  const span: Tracer.Tracer['span'] = (options) => {
    const opened = tracer.span(options);
    const phase = PHASE_OF.get(options.name);
    if (phase === undefined) {
      return opened;
    }
    const end = opened.end.bind(opened);
    opened.end = (endTime, exit) => {
      end(endTime, exit);
      const total = totals.get(phase);
      if (total !== undefined) {
        total.count += 1;
        total.ms += Number(endTime - options.startTime) / 1e6;
      }
    };
    return opened;
  };
  // The request's own tracer keeps its context hook, called on that tracer as its own method.
  const counting = Tracer.make(
    tracer.context === undefined ? { span } : { context: tracer.context.bind(tracer), span },
  );
  const header = (totalMs: number) =>
    [
      `owner-total;dur=${Math.round(totalMs)}`,
      ...PHASES.map((phase) => `owner-${phase};dur=${Math.round(totals.get(phase)?.ms ?? 0)}`),
      ...COUNTED.map((phase) => `owner-${phase}-count;dur=${totals.get(phase)?.count ?? 0}`),
    ].join(', ');
  return { counting, header };
};

/**
 * Runs one owner request handler with its phases counted, and adds their `server-timing` header to the response it
 * ends in, succeeded or failed. Outside an HTTP server request it only runs `handler`.
 */
export const withOwnerServerTiming = Effect.fn('OwnerServerTiming.withOwnerServerTiming')(function* ownerServerTiming<
  A,
  E,
  R,
>(handler: Effect.Effect<A, E, R>) {
  const counter = makePhaseCounter(yield* Effect.tracer);
  const startedAt = yield* Clock.currentTimeNanos;
  const context = yield* Effect.context();
  HttpEffect.appendPreResponseHandlerUnsafe(context, (_request, response) =>
    Clock.currentTimeNanos.pipe(
      Effect.map((now) =>
        HttpServerResponse.setHeader(response, 'server-timing', counter.header(Number(now - startedAt) / 1e6)),
      ),
    ),
  );
  return yield* handler.pipe(Effect.withTracer(counter.counting));
});
