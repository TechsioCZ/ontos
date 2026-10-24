import { HttpEffect, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Clock, Context, Effect, Exit, Option, Ref, Schema } from 'effect';

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
export type GatewayPhase = typeof GatewayPhaseSchema.Type;

interface GatewayTiming {
  readonly durationMs: number;
  readonly phase: GatewayPhase;
}

export class GatewayTimings extends Context.Reference<Option.Option<Ref.Ref<readonly GatewayTiming[]>>>(
  '@app/shell-super-app/api/auth/gateway-timing/GatewayTimings',
  { defaultValue: Option.none },
) {}

const MAX_PHASES = 64;
const MAX_OWNER_HEADER_LENGTH = 4096;
// Mirror Core's fixed ReadPhase names without importing another deployment's private implementation.
const ownerPhase =
  /^(?<phase>read-authentication|read-admission|read-scope|read-module|read-permission|read-prepare|read-transaction|read-authority|read-rls|read-owner|read-validation|read-audit|read-encode)\s*;\s*dur=(?<duration>\d+(?:\.\d+)?)$/u;

// Commas inside quoted descriptions are data, never metric separators (including escaped quotes).
const timingMetrics = (header: string): readonly string[] => {
  const metrics: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      metrics.push(header.slice(start, index));
      if (metrics.length === MAX_PHASES) {
        return metrics;
      }
      start = index + 1;
    }
  }
  if (quoted) {
    return [];
  }
  metrics.push(header.slice(start));
  return metrics;
};

const ownerServerTimings = (header: string): readonly string[] => {
  if (header.length > MAX_OWNER_HEADER_LENGTH) {
    return [];
  }
  const timings: string[] = [];
  for (const metric of timingMetrics(header)) {
    const groups = ownerPhase.exec(metric.trim())?.groups;
    if (groups !== undefined && Number.isFinite(Number(groups['duration']))) {
      timings.push(`${groups['phase']};dur=${groups['duration']}`);
    }
  }
  return timings;
};

export const gatewayServerTiming = (timings: readonly GatewayTiming[]): string => {
  const metrics: string[] = [];
  for (const { durationMs, phase } of timings.slice(0, MAX_PHASES)) {
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      metrics.push(`${phase};dur=${durationMs}`);
    }
  }
  return metrics.join(', ');
};

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
      Effect.map((entries) => {
        const gateway = gatewayServerTiming(entries).split(', ').filter(Boolean);
        const owner = ownerServerTimings(response.headers['server-timing'] ?? '').slice(0, MAX_PHASES - gateway.length);
        const header = [...owner, ...gateway].join(', ');
        return header.length === 0
          ? HttpServerResponse.removeHeader(response, 'server-timing')
          : HttpServerResponse.setHeader(response, 'server-timing', header);
      }),
    ),
  );
  return { appendResponseHeader, timings };
});
