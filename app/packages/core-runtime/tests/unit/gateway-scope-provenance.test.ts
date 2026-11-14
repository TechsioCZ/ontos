import { organizationProcessingReadPrincipal } from '../support/organization-processing-read-principal.ts';
import { organizationGovernanceReadPrincipal } from '../support/organization-governance-read-principal.ts';
import { privacyDispatchPrincipal } from '../support/privacy-dispatch-principal.ts';
import { registeredGatewayRecoveryPrincipal } from '../support/registered-gateway-recovery.ts';
import { Effect, Exit, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
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
  trustSupportRecoveryPrincipalContext,
  trustVerifiedGatewayPrincipalContext,
  VerifiedGatewayPrincipalContextSchema,
} from '../../src/auth/system-principal-context-provenance.ts';
import type { TrustedPrincipalContext } from '../../src/actions/principal-context.ts';

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

const transplantProvenance = (source: TrustedPrincipalContext, target: TrustedPrincipalContext) => {
  const property = '__ontosCorePrincipalContextProvenance';
  const descriptor = Object.getOwnPropertyDescriptor(source, property);
  expect(descriptor).toBeDefined();
  return Object.defineProperty({ ...target }, property, descriptor ?? {});
};

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

it('production mint paths reject post-seal principal and tenant mutation', () => {
  const gateway = trustVerifiedGatewayPrincipalContext(context, compositionRevision, {
    assertion: Redacted.make(assertionValue),
    audience: 'party-registry',
  });
  const system = trustResolvedSystemPrincipalContext(
    Schema.decodeSync(TrustedPrincipalContextSchema)({
      authContextRef: 'job:mutation-probe:run:run-1',
      authMethod: 'system',
      principalId: context.principalId,
      tenantId: context.tenantId,
    }),
  );
  const recovery = trustSupportRecoveryPrincipalContext(context, {});
  for (const carrier of [gateway, system, recovery]) {
    expect(Object.isFrozen(carrier)).toBe(true);
    expect(Reflect.set(carrier, 'principalId', '10000000-0000-4000-8000-000000000099')).toBe(false);
    expect(Reflect.set(carrier, 'tenantId', '20000000-0000-4000-8000-000000000099')).toBe(false);
    expect(carrier.principalId).toBe(context.principalId);
    expect(carrier.tenantId).toBe(context.tenantId);
  }
  expect(isVerifiedGatewayPrincipalContext(gateway)).toBe(true);
  expect(isTrustedSystemPrincipalContext(system)).toBe(true);
  expect(isTrustedSupportRecoveryPrincipalContext(recovery)).toBe(true);
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

it('carries the redeemed assertion of an OAuth connection context only on its exact carrier', () => {
  const grantId = '30000000-0000-4000-8000-000000000001';
  const oauthContext = Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000002',
    authContextRef: `oauth-grant:${grantId}`,
    authMethod: 'oauth_connection',
    connection: {
      clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
      clientName: 'Claude Code',
      grantId,
      modules: [{ access: 'read', moduleId: 'party.registry' }],
      writePolicy: 'approval',
    },
    delegatedByPrincipalId: '10000000-0000-4000-8000-000000000003',
    legalEntityId: '71000000-0000-4000-8000-000000000021',
    principalId: '10000000-0000-4000-8000-000000000004',
    tenantId: '20000000-0000-4000-8000-000000000001',
  });
  const trusted = trustVerifiedGatewayPrincipalContext(oauthContext, compositionRevision, {
    assertion: Redacted.make(assertionValue),
    audience: 'party-registry',
  });

  expect(isVerifiedGatewayPrincipalContext(trusted)).toBe(true);
  expect(Schema.is(VerifiedGatewayPrincipalContextSchema)(trusted)).toBe(true);
  const scopeAssertion = readVerifiedGatewayScopeAssertion(trusted);
  expect(scopeAssertion?.audience).toBe('party-registry');
  expect(scopeAssertion === undefined ? undefined : Redacted.value(scopeAssertion.assertion)).toBe(assertionValue);
  expect(readVerifiedGatewayCompositionRevision(trusted)).toBe(compositionRevision);
  expect(encodeJson(trusted)).not.toContain(assertionValue);

  for (const forgery of [{ ...trusted }, structuredClone({ ...trusted })]) {
    expect(isVerifiedGatewayPrincipalContext(forgery)).toBe(false);
    expect(readVerifiedGatewayScopeAssertion(forgery)).toBeUndefined();
  }
});

it.effect('rejects transplanted gateway seals before and after decoding or explicit preservation', () =>
  Effect.gen(function* gatewayDescriptorTransplant() {
    const trusted = trustVerifiedGatewayPrincipalContext(context, compositionRevision, {
      assertion: Redacted.make(assertionValue),
      audience: 'party-registry',
    });
    for (const changes of [
      {},
      { principalId: '10000000-0000-4000-8000-000000000002' },
      { authBindingId: '40000000-0000-4000-8000-000000000002' },
      { tenantId: '20000000-0000-4000-8000-000000000002' },
    ]) {
      const target = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({ ...context, ...changes });
      const transplanted = transplantProvenance(trusted, target);
      const decoded = yield* decodeTrustedPrincipalContext(transplanted);
      const preserved = preserveSystemPrincipalContextTrust(transplanted, target);
      for (const carrier of [transplanted, decoded, preserved]) {
        expect(isVerifiedGatewayPrincipalContext(carrier)).toBe(false);
        expect(readVerifiedGatewayCompositionRevision(carrier)).toBeUndefined();
        expect(readVerifiedGatewayScopeAssertion(carrier)).toBeUndefined();
      }
    }
    const decoded = yield* decodeTrustedPrincipalContext(trusted);
    expect(isVerifiedGatewayPrincipalContext(decoded)).toBe(true);
    expect(readVerifiedGatewayCompositionRevision(decoded)).toBe(compositionRevision);
    expect(readVerifiedGatewayScopeAssertion(decoded)).toEqual(readVerifiedGatewayScopeAssertion(trusted));
  }),
);

it.effect('rejects a transplanted gateway seal on a Storefront context during decoding', () =>
  Effect.gen(function* storefrontDescriptorTransplant() {
    const trusted = trustVerifiedGatewayPrincipalContext(
      yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
        ...context,
        legalEntityId: '30000000-0000-4000-8000-000000000001',
        trustedStorefrontId: 'storefront-a',
      }),
      compositionRevision,
    );
    const transplanted = transplantProvenance(trusted, trusted);
    expect(Exit.isFailure(yield* Effect.exit(decodeTrustedPrincipalContext(transplanted)))).toBe(true);
    expect(isVerifiedGatewayPrincipalContext(yield* decodeTrustedPrincipalContext(trusted))).toBe(true);
  }),
);

it.effect('rejects a system seal transplanted to another tenant while preserving explicit copies', () =>
  Effect.gen(function* systemDescriptorTransplant() {
    const trusted = trustResolvedSystemPrincipalContext(
      yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
        authContextRef: 'job:provenance:run:run-1',
        authMethod: 'system',
        principalId: context.principalId,
        tenantId: context.tenantId,
      }),
    );
    const target = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      ...trusted,
      tenantId: '20000000-0000-4000-8000-000000000002',
    });
    const transplanted = transplantProvenance(trusted, target);
    expect(isTrustedSystemPrincipalContext(transplanted)).toBe(false);
    expect(isTrustedSystemPrincipalContext(preserveSystemPrincipalContextTrust(transplanted, target))).toBe(false);
    expect(Exit.isFailure(yield* Effect.exit(decodeTrustedPrincipalContext(transplanted)))).toBe(true);
    const preserved = preserveSystemPrincipalContextTrust(trusted, Object.freeze({ ...trusted, correlationId: 'c-2' }));
    expect(isTrustedSystemPrincipalContext(preserved)).toBe(true);
    expect(isTrustedSystemPrincipalContext(yield* decodeTrustedPrincipalContext(preserved))).toBe(true);
    expect(isTrustedSystemPrincipalContext(trusted)).toBe(true);
  }),
);

it.effect(
  'rejects a transplanted support recovery seal while preserving its registered Action on explicit copies',
  () =>
    Effect.gen(function* recoveryDescriptorTransplant() {
      const registration = {};
      const trusted = trustSupportRecoveryPrincipalContext(context, registration);
      const target = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
        ...context,
        authBindingId: '40000000-0000-4000-8000-000000000002',
        principalId: '10000000-0000-4000-8000-000000000002',
        tenantId: '20000000-0000-4000-8000-000000000002',
      });
      const transplanted = transplantProvenance(trusted, target);
      const decoded = yield* decodeTrustedPrincipalContext(transplanted);
      const copiedForgery = preserveSystemPrincipalContextTrust(transplanted, target);
      for (const carrier of [transplanted, decoded, copiedForgery]) {
        expect(isTrustedSupportRecoveryPrincipalContext(carrier)).toBe(false);
        expect(isTrustedSupportRecoveryPrincipalContext(carrier, registration)).toBe(false);
      }
      const preserved = preserveSystemPrincipalContextTrust(
        trusted,
        Object.freeze({ ...trusted, correlationId: 'c-3' }),
      );
      const decodedCopy = yield* decodeTrustedPrincipalContext(preserved);
      for (const carrier of [trusted, preserved, decodedCopy]) {
        expect(isTrustedSupportRecoveryPrincipalContext(carrier, registration)).toBe(true);
        expect(isTrustedSupportRecoveryPrincipalContext(carrier, {})).toBe(false);
      }
    }),
);
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
  expect(Schema.is(RegisteredGatewayWorkloadSchema)({ ...metadata, schemaVersion: '2' })).toBe(true);
  for (const change of [{ legalEntityScope: 'optional' }]) {
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
