import { startAutosave } from '@app/admin-ui';
import type { AutosaveOutcome } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import { SalesPipelineLifecycleConflictProblemSchema } from '../../shared/sales-pipeline-action-problems.ts';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import {
  draftFrom,
  opportunityAutosaveResult,
  opportunityUnchangedSince,
  sameOpportunityDraft,
  updateCommandOf,
} from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-draft.ts';
import type { FormDraft } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-draft.ts';

const opportunity = Schema.decodeUnknownSync(OpportunitySchema)({
  amountMinor: 250_000,
  createdAt: '2026-10-01T08:00:00.000Z',
  currency: 'CZK',
  expectedCloseDate: '2026-11-30',
  id: '0196a8a0-0000-7000-8000-000000000001',
  lines: [{ productName: 'Pronájem kanceláře', quantity: 1, unitPriceMinor: 250_000, vatRate: 21 }],
  note: 'Volat po 14. hodině',
  partyId: '0196a8a0-0000-7000-8000-0000000000aa',
  probability: 25,
  stage: 'QUALIFIED',
  stageHistory: [],
  title: 'Kanceláře Brno',
  updatedAt: '2026-10-13T08:00:00.000Z',
});
const saved = draftFrom(opportunity);
const conflictProblem = (code: 'sales_pipeline_revision_conflict') =>
  Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
    _tag: 'ApplyCommandActionConflictProblem',
    code,
    detail: 'Obchodní případy se mezitím změnily.',
    status: 409,
    title: 'Konflikt',
    type: 'about:blank',
  });

describe('opportunity edit draft', () => {
  it('ignores surrounding spaces and the line editor keys', () => {
    const rekeyed = { ...saved, lines: saved.lines.map((entry) => ({ ...entry, key: 'new-key' })) };
    expect(sameOpportunityDraft(saved, { ...rekeyed, title: ' Kanceláře Brno ' })).toBe(true);
    expect(sameOpportunityDraft(saved, { ...saved, note: 'Volat dopoledne' })).toBe(false);
  });

  it('never saves an opportunity without a title, with an invalid date or with an invalid line', () => {
    expect(Option.isSome(updateCommandOf(opportunity.id, saved))).toBe(true);
    expect(Option.isNone(updateCommandOf(opportunity.id, { ...saved, title: '  ' }))).toBe(true);
    expect(Option.isNone(updateCommandOf(opportunity.id, { ...saved, closeText: '2026-13-40' }))).toBe(true);
    const invalidLine = saved.lines.map((entry) => ({ ...entry, invalidQuantity: 0 }));
    expect(Option.isNone(updateCommandOf(opportunity.id, { ...saved, lines: invalidLine }))).toBe(true);
  });

  it('resends a revision race only while this opportunity is still the version the draft builds on', () => {
    const unchanged = opportunityUnchangedSince(opportunity.id, saved);
    expect(unchanged([opportunity])).toBe(true);
    expect(unchanged([{ ...opportunity, title: 'Kanceláře Ostrava' }])).toBe(false);
    expect(unchanged([])).toBe(false);
  });

  it.effect('adopts the returned revision and turns only a revision conflict into the conflict line', () =>
    Effect.gen(function* outcomes() {
      expect(yield* opportunityAutosaveResult(Effect.succeed({ revision: 42 }))).toBe(42);
      expect(yield* opportunityAutosaveResult(Effect.fail(conflictProblem('sales_pipeline_revision_conflict')))).toBe(
        'conflict',
      );
      const lifecycle = yield* Schema.decodeUnknownEffect(SalesPipelineLifecycleConflictProblemSchema)({
        _tag: 'SalesPipelineLifecycleConflictProblem',
        code: 'sales_pipeline_lifecycle_conflict',
        detail: 'Příležitost je uzavřená.',
        status: 409,
        title: 'Konflikt',
        type: 'about:blank',
      });
      expect(yield* opportunityAutosaveResult(Effect.fail(lifecycle))).toBe('failed');
    }),
  );
});

const panel = Effect.fnUntraced(function* panel(outcome: AutosaveOutcome) {
  const sent: FormDraft[] = [];
  const controller = yield* startAutosave(saved, {
    equals: sameOpportunityDraft,
    isValid: (value: FormDraft) => Option.isSome(updateCommandOf(opportunity.id, value)),
    save: (value: FormDraft) => Effect.sync(() => sent.push(value)).pipe(Effect.as(outcome)),
  });
  return { controller, sent };
});

describe('opportunity edit panel autosave', () => {
  it.effect('saves a typed note after the quiet time; an empty title stays local', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...saved, title: '' });
      controller.flush();
      expect(controller.status()).toBe('invalid');
      controller.change({ ...saved, note: 'Volat dopoledne' });
      yield* TestClock.adjust('800 millis');
      expect(sent.map(({ note }) => note)).toEqual(['Volat dopoledne']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('holds a conflicting draft instead of sending it again', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* panel('conflict');
      controller.change({ ...saved, closeText: '2026-12-15' });
      controller.flush();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...saved, closeText: '2026-12-20' });
      yield* TestClock.adjust('1 second');
      expect(sent).toHaveLength(1);
    }),
  );
});
