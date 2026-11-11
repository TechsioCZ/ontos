import { Effect } from 'effect';
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
