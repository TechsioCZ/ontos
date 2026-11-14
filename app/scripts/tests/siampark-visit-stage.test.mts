import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { VisitSchema } from '../../verticals/crm/shared/domain/visits.ts';
import { rehearsalQaVisitTitle, selectRehearsalQaVisit } from '../demo/siampark-visit-stage.mts';

const instant = '2026-10-26T09:00:00Z';
const sample = Effect.gen(function* sampleVisit() {
  return yield* Schema.decodeUnknownEffect(VisitSchema)({
    authorPrincipalId: 'operator',
    clientId: 'client',
    corrections: [],
    createdAt: instant,
    id: 'qa-visit',
    kind: 'visit',
    occurredAt: instant,
    result: rehearsalQaVisitTitle,
    updatedAt: instant,
  });
});
it.effect('selects only the exact reviewed QA title, never ordinary visits or a similar title', () =>
  Effect.gen(function* exactTitle() {
    const visit = yield* sample;
    expect(
      yield* selectRehearsalQaVisit([
        { ...visit, result: 'Prohlídka R101' },
        { ...visit, result: `${rehearsalQaVisitTitle} jiný test` },
        visit,
      ]),
    ).toBe(visit);
    expect(yield* selectRehearsalQaVisit([{ ...visit, result: 'Prohlídka R101' }])).toBeUndefined();
    expect(Exit.isFailure(yield* Effect.exit(selectRehearsalQaVisit([visit, { ...visit, id: visit.id }])))).toBe(true);
  }),
);
