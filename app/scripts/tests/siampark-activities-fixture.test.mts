import { RelationshipsStateSchema } from '@app/crm-activities/contracts/records';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { rentalDemoCompany } from '../../packages/core-runtime/src/install/demo-company-profiles.ts';
import { demoLegalEntityId, demoOwnerPorts, demoOwnerStates, demoTenantId } from '../siampark/fixtures.mts';

const activitiesScript = 'verticals/crm-activities/scripts/reset-demo.mts';
const FixtureSchema = Schema.Struct({
  legalEntityId: Schema.Literals([demoLegalEntityId, rentalDemoCompany.legalEntityId]),
  state: Schema.toEncoded(RelationshipsStateSchema),
  tenantId: Schema.Literal(demoTenantId),
});

it.effect(
  'keeps the baseline Activities fixture and emits a second empty rental fixture through the same owner port',
  () =>
    Effect.gen(function* activitiesOwnerPorts() {
      const ports = yield* demoOwnerPorts;
      const activities = ports.filter(({ script }) => script === activitiesScript);
      expect(activities).toHaveLength(2);
      const fixtures: (typeof FixtureSchema.Type)[] = [];
      for (const { encodedFixture } of activities) {
        fixtures.push(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FixtureSchema))(encodedFixture));
      }
      expect(fixtures).toEqual([
        { legalEntityId: demoLegalEntityId, state: demoOwnerStates['crm-activities'], tenantId: demoTenantId },
        { legalEntityId: rentalDemoCompany.legalEntityId, state: { activities: [] }, tenantId: demoTenantId },
      ]);
      expect(demoLegalEntityId).toBe('71000000-0000-4000-8000-000000000020');
      expect(fixtures[0]?.state.activities.map(({ ref, summary }) => ({ id: ref.resourceId, summary }))).toEqual([
        { id: '76000000-0000-4000-8000-000000000036', summary: 'Nájem A102 potvrzen' },
        { id: '76000000-0000-4000-8000-000000000037', summary: 'Připravit prodloužení B201' },
        { id: '76000000-0000-4000-8000-000000000038', summary: 'Přiřazená návštěva B201' },
      ]);
      expect(ports).toHaveLength(7);
    }),
);
