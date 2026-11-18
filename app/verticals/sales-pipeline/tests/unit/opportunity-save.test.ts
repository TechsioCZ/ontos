import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import { SalesPipelineLifecycleConflictProblemSchema } from '../../shared/sales-pipeline-action-problems.ts';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import {
  draftFrom,
  opportunitySaveResult,
  opportunityUnchangedSince,
  sameOpportunityDraft,
  updateCommandOf,
} from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-draft.ts';

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
const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-07T12:00:00Z',
  proposalId: '20000000-0000-4000-8000-000000000001',
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

  it.effect('maps a saved revision, a revision conflict and an approval proposal to their outcomes', () =>
    Effect.gen(function* outcomes() {
      expect(yield* opportunitySaveResult(Effect.succeed({ revision: 42 }))).toBe(42);
      expect(yield* opportunitySaveResult(Effect.fail(conflictProblem('sales_pipeline_revision_conflict')))).toBe(
        'conflict',
      );
      expect(yield* opportunitySaveResult(Effect.fail(proposal))).toBe('proposed');
      const lifecycle = yield* Schema.decodeUnknownEffect(SalesPipelineLifecycleConflictProblemSchema)({
        _tag: 'SalesPipelineLifecycleConflictProblem',
        code: 'sales_pipeline_lifecycle_conflict',
        detail: 'Příležitost je uzavřená.',
        status: 409,
        title: 'Konflikt',
        type: 'about:blank',
      });
      expect(yield* opportunitySaveResult(Effect.fail(lifecycle))).toBe('failed');
    }),
  );
});
