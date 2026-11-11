import { Effect, Tracer } from 'effect';
import { expect, it } from 'effect-rstest';

import { timedDescription } from '../../../api/mcp/describe-timing.ts';

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
