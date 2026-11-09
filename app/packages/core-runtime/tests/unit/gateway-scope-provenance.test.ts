import { organizationProcessingReadPrincipal } from '../support/organization-processing-read-principal.ts';
import { organizationGovernanceReadPrincipal } from '../support/organization-governance-read-principal.ts';
import { privacyDispatchPrincipal } from '../support/privacy-dispatch-principal.ts';
import { registeredGatewayRecoveryPrincipal } from '../support/registered-gateway-recovery.ts';
import { Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  isTrustedSystemPrincipalContext,
  isVerifiedGatewayPrincipalContext,
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayActor,
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayRecovery,
  readVerifiedGatewayPrivacyDispatch,
  readVerifiedGatewayOrganizationGovernanceRead,
  readVerifiedGatewayOrganizationProcessingRead,
  readVerifiedGatewayWorkload,
  RegisteredGatewayWorkloadSchema,
  RegisteredGatewayPrivacyDispatchSchema,
  readVerifiedGatewayScopeAssertion,
  trustResolvedSystemPrincipalContext,
  trustVerifiedGatewayPrincipalContext,
  VerifiedGatewayPrincipalContextSchema,
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
    expect(Schema.is(VerifiedGatewayPrincipalContextSchema)(carrier)).toBe(true);
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
    expect(Schema.is(VerifiedGatewayPrincipalContextSchema)(forgery)).toBe(false);
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

it('carries the calling module of a delegated assertion beside the subject, only inside provenance', () => {
  const actor = {
    appId: 'commerce-order',
    buildMarker: 'commerce-order-build',
    principalId: '30000000-0000-4000-8000-000000000009',
  };
  const trusted = trustVerifiedGatewayPrincipalContext(context, compositionRevision, undefined, actor);
  const preserved = preserveSystemPrincipalContextTrust(trusted, Object.freeze({ ...trusted, correlationId: 'c-2' }));

  expect(readVerifiedGatewayActor(trusted)).toEqual(actor);
  expect(readVerifiedGatewayActor(preserved)).toEqual(actor);
  expect(readVerifiedGatewayActor({ ...trusted })).toBeUndefined();
  expect(readVerifiedGatewayActor(context)).toBeUndefined();
  expect(Object.keys(preserved).some((key) => key.includes('actor'))).toBe(false);
  expect(encodeJson(preserved)).not.toContain('commerce-order');
});

it('keeps historical receipt recovery authority only on the exact revived worker context', () => {
  const recovered = registeredGatewayRecoveryPrincipal({
    declarationKey: 'core.shell.receipt.read',
    entrypointKey: 'core.shell.receipt',
    principalId: context.principalId,
    requestHash: 'c'.repeat(64),
    tenantId: context.tenantId,
    workloadKey: 'core.shell.receipt-recovery',
  });
  expect(readVerifiedGatewayRecovery(recovered)?.requestHash).toBe('c'.repeat(64));
  expect(isTrustedSystemPrincipalContext(recovered)).toBe(true);
  expect(readVerifiedGatewayRecovery({ ...recovered })).toBeUndefined();
  expect(isTrustedSystemPrincipalContext({ ...recovered })).toBe(false);
});

it('preserves finite Privacy dispatch metadata only with its exact original human and governance scope', () => {
  const governance = '30000000-0000-4000-8000-000000000001';
  const human = Schema.decodeSync(TrustedPrincipalContextSchema)({ ...context, legalEntityId: governance });
  const admitted = privacyDispatchPrincipal(human, 'SymmyRetention', 'c'.repeat(64));
  const scope = preserveSystemPrincipalContextTrust(admitted, { ...admitted, correlationId: 'privacy-dispatch' });
  const metadata = readVerifiedGatewayPrivacyDispatch(scope);
  expect(metadata?.operation).toBe('SymmyRetention');
  expect(metadata?.governanceLegalEntityId).toBe(governance);
  expect(Object.isFrozen(metadata)).toBe(true);
  expect(readVerifiedGatewayPrivacyDispatch({ ...scope })).toBeUndefined();
  expect(() =>
    preserveSystemPrincipalContextTrust(admitted, { ...admitted, principalId: '10000000-0000-4000-8000-000000000002' }),
  ).toThrow();
  expect(() => privacyDispatchPrincipal(context, 'SymmyRetention', 'c'.repeat(64))).toThrow();
  expect(Schema.is(RegisteredGatewayPrivacyDispatchSchema)({ ...metadata, sourceMode: 'dispatch' })).toBe(false);
  const { claimId: _claimId, ...withoutClaim } = metadata ?? {};
  expect(Schema.is(RegisteredGatewayPrivacyDispatchSchema)(withoutClaim)).toBe(false);
});

it('keeps Organization governance read provenance on the exact original human company scope only', () => {
  const human = Schema.decodeSync(TrustedPrincipalContextSchema)({
    ...context,
    authenticationNamespaceId: 'core-identity',
    legalEntityId: '30000000-0000-4000-8000-000000000001',
  });
  const principal = organizationGovernanceReadPrincipal(human, 'd'.repeat(64));
  const admitted = preserveSystemPrincipalContextTrust(principal, { ...principal, correlationId: 'organization-gov' });
  expect(readVerifiedGatewayOrganizationGovernanceRead(admitted)?.requestHash).toBe('d'.repeat(64));
  expect(Object.isFrozen(readVerifiedGatewayOrganizationGovernanceRead(admitted))).toBe(true);
  expect(readVerifiedGatewayOrganizationGovernanceRead({ ...admitted })).toBeUndefined();
  expect(() =>
    preserveSystemPrincipalContextTrust(principal, {
      ...principal,
      legalEntityId: '30000000-0000-4000-8000-000000000002',
    }),
  ).toThrow();
  expect(() => organizationGovernanceReadPrincipal(context, 'd'.repeat(64))).toThrow();
  const { authenticationNamespaceId: _namespace, ...legacyHuman } = human;
  expect(() => organizationGovernanceReadPrincipal(legacyHuman, 'd'.repeat(64))).toThrow();
});

it('restricts the sealed Organization processing marker to its exact required-company Read without recovery', () => {
  const principal = organizationProcessingReadPrincipal('c'.repeat(64));
  const metadata = readVerifiedGatewayWorkload(principal);
  expect(readVerifiedGatewayOrganizationProcessingRead(principal)?.requestHash).toBe('c'.repeat(64));
  expect(Object.isFrozen(readVerifiedGatewayOrganizationProcessingRead(principal))).toBe(true);
  expect(readVerifiedGatewayOrganizationProcessingRead({ ...principal })).toBeUndefined();
  for (const change of [
    { entrypointKey: 'integration.symmy.other-read' },
    { declarationKey: 'integration.symmy.other.read' },
    { workloadKey: 'integration.symmy.other-read' },
    { schemaVersion: '2' },
    { legalEntityScope: 'optional' },
  ]) {
    expect(Schema.is(RegisteredGatewayWorkloadSchema)({ ...metadata, ...change })).toBe(false);
  }
  const recovered = registeredGatewayRecoveryPrincipal({
    declarationKey: 'core.shell.read',
    entrypointKey: 'core.shell.read',
    principalId: context.principalId,
    requestHash: 'e'.repeat(64),
    tenantId: context.tenantId,
    workloadKey: 'core.shell.recovery',
  });
  expect(
    Schema.is(RegisteredGatewayWorkloadSchema)({ ...metadata, recovery: readVerifiedGatewayRecovery(recovered) }),
  ).toBe(false);
});
