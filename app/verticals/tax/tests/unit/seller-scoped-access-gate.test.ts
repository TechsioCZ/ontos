import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { declareSellerVatRegimeAction } from '../../src/actions/declare-seller-vat-regime.action.ts';
import { makeSellerScopedAccessGate } from '../support/scoped-access-gate.ts';

const seller = '30000000-0000-4000-8000-000000000001';
const foreignSeller = '30000000-0000-4000-8000-000000000002';
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'session:tax-scripted-gate',
    authMethod: 'session',
    legalEntityId: seller,
    principalId: '20000000-0000-4000-8000-000000000001',
    tenantId: '10000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'tax-scripted-gate',
};

it.effect('keeps the scripted seller gate bound without claiming persisted authority preparation', () =>
  Effect.gen(function* scriptedSellerGate() {
    const gate = makeSellerScopedAccessGate([seller]);
    expect(gate.bound.prepare).toBeUndefined();
    const question = {
      carrier: { accessDeclaration: declareSellerVatRegimeAction.descriptor.accessDeclaration },
      legalEntityScope: 'required' as const,
      now: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z')),
      scope,
    };
    expect((yield* gate.bound.decide(question)).outcome).toBe('ALLOWED');
    const denied = yield* gate.bound.decide({ ...question, scope: { ...scope, legalEntityId: foreignSeller } });
    expect(denied.outcome).toBe('DENIED');
    expect(denied.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');
    gate.revoke(seller);
    expect((yield* gate.bound.decide(question)).outcome).toBe('DENIED');
    gate.restore(seller);
    expect((yield* gate.bound.decide(question)).outcome).toBe('ALLOWED');
    expect(gate.askedDecisions).toHaveLength(4);
  }),
);
