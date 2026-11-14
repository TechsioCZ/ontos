import { Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SalesPipelineCommandSchema } from '../../shared/actions/apply-command.ts';
import { opportunityAmountMinor } from '../../shared/model/opportunity.ts';
import { opportunityResourceDescriptor } from '../../shared/resources/opportunity.ts';

const opportunityId = '0196a8a0-0000-7000-8000-000000000001';

it('owns its primary resource type', () => {
  expect(opportunityResourceDescriptor.owningModuleId).toBe('demo.sales-pipeline');
});

it('sums line amounts without VAT', () => {
  expect(
    opportunityAmountMinor([
      { productName: 'Chair', quantity: 2, unitPriceMinor: 150_000, vatRate: 21 },
      { productName: 'Desk', quantity: 1, unitPriceMinor: 5000, vatRate: 10 },
    ]),
  ).toBe(305_000);
});

it('decodes a stage change command with a branded opportunity id', () => {
  const command = Schema.decodeUnknownSync(SalesPipelineCommandSchema)({
    _tag: 'ChangeOpportunityStage',
    id: opportunityId,
    toStage: 'WON',
  });
  const stageChange = Match.value(command).pipe(
    Match.tag('ChangeOpportunityStage', ({ id, toStage }) => ({ id, toStage })),
    Match.orElse(() => null),
  );
  expect(stageChange).toEqual({ id: opportunityId, toStage: 'WON' });
});

it('rejects a command whose opportunity id is not a UUID', () => {
  expect(() =>
    Schema.decodeUnknownSync(SalesPipelineCommandSchema)({
      _tag: 'ChangeOpportunityStage',
      id: 'not-a-uuid',
      toStage: 'WON',
    }),
  ).toThrow();
});
