import { Effect, Exit, Logger, Tracer } from 'effect';
import { expect, it } from 'effect-rstest';

import { timedDescription, withRoundTripLog } from '../../../api/mcp/describe-timing.ts';

const span = (name: string) => Effect.void.pipe(Effect.withSpan(name));

it.effect('counts the round trips and sums the parts of one description from its own spans', () =>
  Effect.gen(function* countedDescription() {
    const [value, timing] = yield* timedDescription(
      Effect.all(
        [
          span('sql.transaction'),
          span('postgres'),
          span('postgres'),
          span('AccessDecision.spicedbCheckBulk'),
          span('AccessDecision.spicedbCheckBulk'),
          span('TenantIntentLoader.loadConfigureBases'),
          span('TenantIntentLoader.loadAuthorityCellsMany'),
          span('AccessDecisionLog.recordAll'),
          span('SubjectInspection.resolve'),
          span('an.unrelated.span'),
        ],
        { concurrency: 1 },
      ).pipe(Effect.as('described')),
    );
    expect(value).toBe('described');
    expect(timing).toMatchObject({ spicedbCalls: 2, statements: 2, transactions: 1 });
    // Every part is a whole number of milliseconds, never a missing field.
    for (const ms of [
      timing.cellsMs,
      timing.compositionMs,
      timing.configureMs,
      timing.evidenceMs,
      timing.resolutionMs,
      timing.spicedbMs,
    ]) {
      expect(Number.isInteger(ms) && ms >= 0).toBe(true);
    }
  }),
);

it.effect("keeps the request tracer's context hook while it counts the description's spans", () =>
  Effect.gen(function* contextHookKept() {
    const parent = yield* Effect.tracer;
    let inside = false;
    let hookedInside = 0;
    const hooked = Tracer.make({
      context: (primitive, fiber) => {
        hookedInside += inside ? 1 : 0;
        return primitive['~effect/Effect/evaluate'](fiber);
      },
      span: (options) => parent.span(options),
    });
    yield* timedDescription(
      Effect.sync(() => {
        inside = true;
      }).pipe(
        Effect.andThen(span('postgres')),
        Effect.andThen(
          Effect.sync(() => {
            inside = false;
          }),
        ),
      ),
    ).pipe(Effect.withTracer(hooked));
    expect(hookedInside).toBeGreaterThan(0);
  }),
);

/** A tracer whose context hook keeps state on itself, as a class-based exporter's does. */
class StatefulTracer implements Tracer.Tracer {
  hooked = 0;
  readonly parent: Tracer.Tracer;
  constructor(parent: Tracer.Tracer) {
    this.parent = parent;
  }
  span(options: Parameters<Tracer.Tracer['span']>[0]) {
    return this.parent.span(options);
  }
  context<X>(primitive: Tracer.EffectPrimitive<X>, fiber: Parameters<NonNullable<Tracer.Tracer['context']>>[1]): X {
    this.hooked += 1;
    return primitive['~effect/Effect/evaluate'](fiber);
  }
}

it.effect("calls the request tracer's context hook on that tracer itself", () =>
  Effect.gen(function* contextHookBound() {
    const stateful = new StatefulTracer(yield* Effect.tracer);
    yield* timedDescription(span('postgres')).pipe(Effect.withTracer(stateful));
    expect(stateful.hooked).toBeGreaterThan(0);
  }),
);

/** A logger keeping each structured entry, as JSON text. */
const capturedLogs = (entries: string[]) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);

it.effect('logs one request line with its round trips, when the request succeeds and when it fails', () =>
  Effect.gen(function* roundTripLog() {
    const entries: string[] = [];
    const work = Effect.all([span('sql.transaction'), span('postgres'), span('AccessDecision.spicedbCheckBulk')], {
      concurrency: 1,
    });
    expect(
      yield* withRoundTripLog('queue', work.pipe(Effect.as('queued'))).pipe(Effect.provide(capturedLogs(entries))),
    ).toBe('queued');
    const failed = yield* withRoundTripLog('decide', work.pipe(Effect.andThen(Effect.fail('refused')))).pipe(
      Effect.provide(capturedLogs(entries)),
      Effect.exit,
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect(entries).toHaveLength(2);
    for (const [index, route] of ['queue', 'decide'].entries()) {
      const entry = entries[index] ?? '';
      expect(entry).toContain('agent-platform.request');
      expect(entry).toContain(`"route":"${route}"`);
      expect(entry).toContain('"statements":1');
      expect(entry).toContain('"transactions":1');
      expect(entry).toContain('"spicedbCalls":1');
    }
    expect(entries[0]).toContain('"outcome":"ok"');
    expect(entries[1]).toContain('"outcome":"failed"');
  }),
);

/** One owner dispatch that reported `timing` itself. */
const owner = (app: string, timing: string) =>
  Effect.void.pipe(
    Effect.tap(() => Effect.annotateCurrentSpan({ 'ontos.owner_app': app, 'ontos.owner_timing': timing })),
    Effect.withSpan('ModuleApi.dispatchApprovedRequest'),
  );

it.effect(
  'logs what a request waited on beyond its round trips: owners, Core Reads and Actions, authority checks',
  () =>
    Effect.gen(function* requestSteps() {
      const entries: string[] = [];
      const work = Effect.all(
        [
          owner('work-tasks', 'prepare;dur=12, gate;dur=40'),
          owner('party-registry', 'read;dur=3'),
          span('ReadRuntime.runRead'),
          span('ReadRuntime.runRead'),
          span('ActionRuntime.runAction'),
          span('ActionAuthority.checkActionAuthorities'),
        ],
        { concurrency: 1 },
      );
      yield* withRoundTripLog('decide', work).pipe(Effect.provide(capturedLogs(entries)));
      const [entry = ''] = entries;
      expect(entry).toContain('"ownerCalls":2');
      expect(entry).toContain('"coreReads":2');
      expect(entry).toContain('"coreActions":1');
      expect(entry).toContain('"actionAuthorityChecks":1');
      // The slowest owner call names its app and the phases it reported itself.
      expect(entry).toMatch(/"slowestOwner":"(?<app>work-tasks|party-registry) \d+ ms: /u);
    }),
);
