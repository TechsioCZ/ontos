import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CounterpartyCustomerOnboardPayloadSchema,
  CounterpartyCustomerOnboardResultSchema,
} from '../../shared/actions/counterparty-customer-onboard.ts';
import { counterpartyCustomerOnboardAction } from '../../src/actions/counterparty-customer-onboard.action.ts';

const partyRef = {
  moduleId: 'party.registry',
  resourceId: '11111111-1111-4111-8111-111111111111',
  resourceType: 'party.registry.party',
  tenantId: '22222222-2222-4222-8222-222222222222',
} as const;

const legalEntityRef = {
  moduleId: 'core.identity',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'core.identity.legal-entity',
  tenantId: partyRef.tenantId,
} as const;

const payload = {
  counterpartyProvenance: {
    evidenceReference: 'contract:customer-1',
    method: 'SIGNED_CONTRACT',
    reason: 'Signed customer agreement',
    source: 'operator',
  },
  customerEvidence: {
    evidenceReference: 'order:customer-1',
    method: 'BINDING_ORDER',
    reason: 'Binding order proves purchasing relationship',
    source: 'order-service',
  },
  partyRef,
  validFrom: '2026-09-01T00:00:00.000Z',
  validTo: '2026-12-01T00:00:00.000Z',
} as const;

it.effect('declares required legal-entity permission and composed onboarding result flags', () =>
  Effect.gen(function* contract() {
    expect(counterpartyCustomerOnboardAction.descriptor.legalEntityScope).toBe('required');
    expect(counterpartyCustomerOnboardAction.descriptor.legalEntityPermission).toBe('manage_counterparty');
    expect(counterpartyCustomerOnboardAction.descriptor.idempotency).toBe('required');
    const decoded = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)(payload);
    expect(decoded.customerEvidence.method).toBe('BINDING_ORDER');
    const result = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardResultSchema)({
      counterpartyCreated: true,
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'party.registry.counterparty',
        tenantId: partyRef.tenantId,
      },
      legalEntityRef,
      partyRef,
      rolePeriodCreated: false,
      rolePeriodRef: {
        moduleId: 'party.registry',
        resourceId: '55555555-5555-4555-8555-555555555555',
        resourceType: 'party.registry.counterparty-role-period',
        tenantId: partyRef.tenantId,
      },
      roleType: 'CUSTOMER',
      validFrom: payload.validFrom,
      validTo: payload.validTo,
    });
    expect(result.roleType).toBe('CUSTOMER');
    expect(result.counterpartyCreated).toBe(true);
    expect(result.rolePeriodCreated).toBe(false);
  }),
);

it.effect('rejects a role period whose end precedes its start', () =>
  Effect.gen(function* invalidPeriod() {
    const result = yield* Effect.result(
      Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)({
        ...payload,
        validFrom: '2026-12-01T00:00:00.000Z',
        validTo: '2026-09-01T00:00:00.000Z',
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
  }),
);
