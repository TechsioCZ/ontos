import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { decodeDemoFixture } from '../../scripts/reset-demo.mts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const baselineLegalEntityId = '71000000-0000-4000-8000-000000000020';
const rentalLegalEntityId = '71000000-0000-4000-8000-000000000021';
const otherId = '90000000-0000-4000-8000-000000000001';
const encodeFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const activity = {
  contextRefs: [],
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '76000000-0000-4000-8000-000000000016',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: '2026-10-05T09:00:00.000Z',
  followUpTaskRef: {
    moduleId: 'work.tasks',
    resourceId: '76000000-0000-4000-8000-000000000033',
    resourceType: 'work.tasks.task',
    tenantId,
  },
  kind: 'EMAIL',
  occurredAt: '2026-10-05T09:00:00.000Z',
  ownerPrincipalRef: { principalId: '72000000-0000-4000-8000-000000000022', tenantId },
  partyRef: {
    moduleId: 'party.registry',
    resourceId: '76000000-0000-4000-8000-000000000010',
    resourceType: 'party.registry.party',
    tenantId,
  },
  ref: {
    moduleId: 'crm.activities',
    resourceId: '76000000-0000-4000-8000-000000000037',
    resourceType: 'crm.activities.activity',
    tenantId,
  },
  summary: 'Připravit prodloužení B201',
};

it.effect('accepts exactly the baseline and rental demo scopes without replacing the supplied company', () =>
  Effect.gen(function* supportedDemoScopes() {
    for (const legalEntityId of [baselineLegalEntityId, rentalLegalEntityId]) {
      const fixture = { legalEntityId, state: { activities: [] }, tenantId };
      expect(yield* decodeDemoFixture(encodeFixture(fixture))).toEqual(fixture);
    }
    for (const legalEntityId of [
      '71000000-0000-4000-8000-000000000022',
      '71000000-0000-4000-8000-000000000023',
      '71000000-0000-4000-8000-000000000024',
      otherId,
    ]) {
      expect(
        yield* decodeDemoFixture(encodeFixture({ legalEntityId, state: { activities: [] }, tenantId })).pipe(
          Effect.isFailure,
        ),
      ).toBe(true);
    }
  }),
);

it.effect('refuses a foreign tenant for either supported demo company', () =>
  Effect.gen(function* fixedDemoTenant() {
    for (const legalEntityId of [baselineLegalEntityId, rentalLegalEntityId]) {
      expect(
        yield* decodeDemoFixture(encodeFixture({ legalEntityId, state: { activities: [] }, tenantId: otherId })).pipe(
          Effect.isFailure,
        ),
      ).toBe(true);
    }
  }),
);

it.effect('preserves baseline references and rejects every foreign-tenant activity reference in both scopes', () =>
  Effect.gen(function* fixedReferenceTenant() {
    for (const legalEntityId of [baselineLegalEntityId, rentalLegalEntityId]) {
      const fixture = { legalEntityId, state: { activities: [activity] }, tenantId };
      const decoded = yield* decodeDemoFixture(encodeFixture(fixture));
      expect(decoded.legalEntityId).toBe(legalEntityId);
      expect(decoded.state.activities[0]?.ref).toEqual(activity.ref);
      for (const key of ['ref', 'ownerPrincipalRef', 'partyRef', 'counterpartyRef', 'followUpTaskRef'] as const) {
        const failure = yield* decodeDemoFixture(
          encodeFixture({
            ...fixture,
            state: { activities: [{ ...activity, [key]: { ...activity[key], tenantId: otherId } }] },
          }),
        ).pipe(Effect.flip);
        expect(failure).toMatchObject({ reason: 'Fixture references must match the fixed demo tenant' });
      }
    }
  }),
);
