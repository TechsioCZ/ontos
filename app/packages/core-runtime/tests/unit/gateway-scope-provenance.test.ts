import { Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  isTrustedSystemPrincipalContext,
  isVerifiedGatewayPrincipalContext,
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
  trustResolvedSystemPrincipalContext,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const assertionValue = 'header.payload.signature-value';
const compositionRevision = 'b'.repeat(64);
const context = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:gateway-scope-provenance',
  authMethod: 'session',
  principalId: '10000000-0000-4000-8000-000000000001',
  tenantId: '20000000-0000-4000-8000-000000000001',
});

it('carries the redeemed assertion only inside the module-private provenance store', () => {
  const trusted = trustVerifiedGatewayPrincipalContext(context, compositionRevision, {
    assertion: Redacted.make(assertionValue),
    audience: 'party-registry',
  });
  const preserved = preserveSystemPrincipalContextTrust(trusted, Object.freeze({ ...trusted, correlationId: 'c-1' }));

  for (const carrier of [trusted, preserved]) {
    const scopeAssertion = readVerifiedGatewayScopeAssertion(carrier);
    expect(scopeAssertion?.audience).toBe('party-registry');
    expect(scopeAssertion === undefined ? undefined : Redacted.value(scopeAssertion.assertion)).toBe(assertionValue);
    expect(readVerifiedGatewayCompositionRevision(carrier)).toBe(compositionRevision);
    expect(Object.keys(carrier).some((key) => key.includes('assertion'))).toBe(false);
    const serialized = encodeJson(carrier);
    expect(serialized).not.toContain(assertionValue);
    expect(serialized).not.toContain('party-registry');
  }
  expect(Object.keys(preserved).toSorted()).toEqual([...Object.keys(context), 'correlationId'].toSorted());
});

it('a gateway context verified without an assertion carries no scope assertion', () => {
  const trusted = trustVerifiedGatewayPrincipalContext(context, compositionRevision);
  expect(readVerifiedGatewayCompositionRevision(trusted)).toBe(compositionRevision);
  expect(readVerifiedGatewayScopeAssertion(trusted)).toBeUndefined();
  expect(readVerifiedGatewayScopeAssertion({ ...trusted })).toBeUndefined();
});

it('trusts only the exact carrier: copies and forged provenance properties carry nothing', () => {
  const trusted = trustVerifiedGatewayPrincipalContext(context, compositionRevision, {
    assertion: Redacted.make(assertionValue),
    audience: 'party-registry',
  });
  const forgedAccess = () => ({
    compositionRevision,
    scopeAssertion: { assertion: Redacted.make('forged'), audience: 'party-registry' },
  });
  // SAFETY: widening `Object.create`'s `any` to `unknown`; every reader below accepts any value.
  const inheritingCarrier = Object.create(trusted) as unknown;
  const forgeries: readonly unknown[] = [
    { ...trusted },
    structuredClone({ ...trusted }),
    Object.defineProperty({ ...context }, '__ontosCorePrincipalContextProvenanceAccess', { value: forgedAccess }),
    // An object that inherits every field from the carrier is still a different object.
    inheritingCarrier,
  ];
  for (const forgery of forgeries) {
    expect(isVerifiedGatewayPrincipalContext(forgery)).toBe(false);
    expect(readVerifiedGatewayScopeAssertion(forgery)).toBeUndefined();
    expect(readVerifiedGatewayCompositionRevision(forgery)).toBeUndefined();
  }
  const system = trustResolvedSystemPrincipalContext(
    Schema.decodeSync(TrustedPrincipalContextSchema)({
      authContextRef: 'job:gateway-scope-provenance:run:run-1',
      authMethod: 'system',
      principalId: '10000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    }),
  );
  expect(isTrustedSystemPrincipalContext(system)).toBe(true);
  expect(isTrustedSystemPrincipalContext({ ...system })).toBe(false);
  expect(isVerifiedGatewayPrincipalContext(system)).toBe(false);
});
