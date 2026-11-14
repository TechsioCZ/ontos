import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Layer, Schema } from 'effect';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'effect-rstest';
import { getActionAccessTargetResolver } from '@app/core-runtime';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import {
  accessScopeFences,
  accessScopes,
  actionInvocations,
  coreRelations,
  legalEntities,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  openActionRuntimeOptions,
  allowTenantPermissions,
} from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import {
  prepareDefinePriceOriginalRequestIdentity,
  prepareRevisePriceOriginalRequestIdentity,
} from '../../shared/source-request-identity.ts';
import { DefinePricePayloadSchema } from '../../shared/actions/define-price.ts';
import { RevisePricePayloadSchema } from '../../shared/actions/revise-price.ts';
import { definePriceAction } from '../../src/actions/define-price.action.ts';
import { revisePriceAction } from '../../src/actions/revise-price.action.ts';
import { pricingRegistration } from '../../vertical.registration.ts';
import { ExternalPriceInputBoundaryFactoryLive } from '../../src/services/external-price-input-boundary.service.ts';

const originalPriceRequestIdentityEffect = Effect.scoped(
  Effect.gen(function* originalPriceRequestIdentity() {
    const crypto = yield* Crypto.Crypto;
    const nextId = crypto.randomUUIDv4();
    const tenantId = yield* nextId;
    const legalEntityId = yield* nextId;
    const principalId = yield* nextId;
    const authBindingId = yield* nextId;
    const scopeId = yield* nextId;
    const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
    const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
    const database = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
    const cleanup = () =>
      admin.transaction((transaction) =>
        Effect.gen(function* cleanupDeniedNativeRequests() {
          yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
          yield* transaction.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
          yield* transaction.delete(principals).where(eq(principals.tenantId, tenantId));
          yield* transaction.delete(accessScopeFences).where(eq(accessScopeFences.tenantId, tenantId));
          yield* transaction.delete(accessScopes).where(eq(accessScopes.tenantId, tenantId));
          yield* transaction.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId));
          yield* transaction.delete(tenants).where(eq(tenants.tenantId, tenantId));
        }),
      );
    yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
    yield* admin.insert(tenants).values({
      defaultLocale: 'en',
      name: 'INTERNAL native Pricing fingerprint fixture',
      slug: `price-request-${tenantId}`,
      status: 'active',
      tenantId,
    });
    yield* admin.insert(legalEntities).values({
      legalEntityId,
      legalName: 'INTERNAL request fingerprint company',
      registrationCountry: 'CZ',
      registrationNumber: yield* nextId,
      status: 'active',
      tenantId,
    });
    yield* admin.insert(accessScopes).values({ scopeId, tenantContextId: tenantId, tenantId });
    yield* admin.insert(accessScopeFences).values({ revision: 1, scopeId, state: 'Ready', tenantId });
    yield* admin.insert(principals).values({
      displayName: 'INTERNAL denied source operator',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    yield* admin.insert(principalAuthBindings).values({
      authenticationNamespaceId: 'internal.price-request-identity.v1',
      principalAuthBindingId: authBindingId,
      principalId,
      provider: 'better_auth',
      providerSubjectId: `price-request-${principalId}`,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });
    const principal = {
      authBindingId,
      authContextRef: `better-auth-session:${authBindingId}`,
      authenticationNamespaceId: 'internal.price-request-identity.v1',
      authMethod: 'session' as const,
      legalEntityId,
      principalId,
      tenantId,
    };
    const runtime = makeActionRuntime(
      { executor: database },
      makeActionRepository(yield* Crypto.Crypto),
      { checkActionPermission: () => Effect.succeed('allowed' as const) },
      testOperationalScopeResolver,
      {
        ...openActionRuntimeOptions,
        accessDecision: makeScriptedBoundAccessGate('denied').bound,
        contextAccess: allowTenantPermissions,
        ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
        ownerRegistration: pricingRegistration,
      },
    );
    const unitRef = {
      moduleId: 'commerce.catalog',
      resourceId: yield* nextId,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    };
    const priceRef = {
      moduleId: 'commerce.pricing',
      resourceId: yield* nextId,
      resourceType: 'commerce.pricing.price',
      tenantId,
    };
    const sourceAssertion = {
      lineage: { kind: 'INITIAL' },
      mapping: { mappingContractRef: 'internal-native-request-identity', mappingContractVersion: '1' },
      originalAssertion: {
        monetaryAmount: { amount: '25.000000000', currencyCode: 'CZK' },
        monetaryBoundary: 'PRE_TAX',
        unitBasis: { quantity: '1', unitRef },
      },
      sourceAssertionId: yield* nextId,
      sourceAuthority: { sourceAuthorityRef: 'internal-pricing-owner-authority', sourceAuthorityVersion: '1' },
      sourceRecord: {
        sourceChangeCorrelation: 'internal-rejected-original-request',
        sourceRecordRef: 'internal-price-row',
        sourceRecordVersion: '1',
        sourceSystem: {
          ownerModuleId: 'external.internal-fixture',
          sourceSystemRef: 'internal-request-identity-source',
        },
      },
      timing: {
        importedAt: '2026-11-07T10:00:00.000Z',
        ownerBusinessEffectiveAt: '2026-11-07T10:00:00.000Z',
        sourceEffectiveAt: '2026-11-07T10:00:00.000Z',
      },
    };
    const define = yield* Schema.decodeUnknownEffect(DefinePricePayloadSchema)({
      effectiveFrom: sourceAssertion.timing.ownerBusinessEffectiveAt,
      identityKey: {
        catalogSelection: {
          productRef: {
            moduleId: 'commerce.catalog',
            resourceId: yield* nextId,
            resourceType: 'commerce.catalog.product',
            tenantId,
          },
          variantRef: {
            moduleId: 'commerce.catalog',
            resourceId: yield* nextId,
            resourceType: 'commerce.catalog.variant',
            tenantId,
          },
        },
        commercialScope: { channelId: 'B2C', marketId: 'internal-market', sellingLegalEntityId: legalEntityId },
        currencyCode: 'CZK',
        priceGroupSelector: { kind: 'NO_GROUP' },
        unitBasis: { quantity: '1', unitRef },
      },
      monetaryAmount: { amount: '25.000000000', currencyCode: 'CZK' },
      priceRef,
      reason: 'INTERNAL denied native DefinePrice fingerprint proof.',
      sourceAssertion,
    });
    const revise = yield* Schema.decodeUnknownEffect(RevisePricePayloadSchema)({
      expectedCurrent: {
        effectivePeriod: { effectiveFrom: define.effectiveFrom, effectiveTo: null },
        priceRef,
        revision: 1,
        revisionId: yield* nextId,
        scheduleRevision: 1,
      },
      intent: 'VALUE_ONLY_CURRENT',
      monetaryAmount: { amount: '25.000000000', currencyCode: 'CZK' },
      priceRef,
      reason: 'INTERNAL denied native RevisePrice fingerprint proof.',
      sourceAssertion,
    });
    const originalPrincipalFacts = { principalId, tenantId };
    const defineIdentity = yield* prepareDefinePriceOriginalRequestIdentity(
      define,
      originalPrincipalFacts,
      legalEntityId,
    );
    const reviseIdentity = yield* prepareRevisePriceOriginalRequestIdentity(
      revise,
      originalPrincipalFacts,
      legalEntityId,
    );
    expect(getActionAccessTargetResolver(definePriceAction)).toBeUndefined();
    expect(getActionAccessTargetResolver(revisePriceAction)).toBeUndefined();
    const defineKey = 'internal-denied-define-original';
    const reviseKey = 'internal-denied-revise-original';
    yield* runtime
      .runAction({
        payload: define,
        principal,
        registration: definePriceAction,
        transport: {
          correlationId: defineKey,
          idempotencyKey: defineKey,
          targetModuleKey: 'commerce.pricing',
          targetResourceId: priceRef.resourceId,
          targetResourceType: priceRef.resourceType,
        },
      })
      .pipe(Effect.flip);
    yield* runtime
      .runAction({
        payload: revise,
        principal,
        registration: revisePriceAction,
        transport: {
          correlationId: reviseKey,
          idempotencyKey: reviseKey,
          targetModuleKey: 'commerce.pricing',
          targetResourceId: priceRef.resourceId,
          targetResourceType: priceRef.resourceType,
        },
      })
      .pipe(Effect.flip);
    const rows = yield* admin.select().from(actionInvocations).where(eq(actionInvocations.tenantId, tenantId));
    for (const { identity, key, registration } of [
      { identity: defineIdentity, key: defineKey, registration: definePriceAction },
      { identity: reviseIdentity, key: reviseKey, registration: revisePriceAction },
    ]) {
      const row = rows.find((candidate) => candidate.idempotencyKey === key);
      expect(row).toBeDefined();
      expect(identity.actionKey).toBe(registration.descriptor.actionKey);
      expect(identity.owningModuleKey).toBe(registration.descriptor.owningModuleKey);
      expect(identity.schemaVersion).toBe(registration.descriptor.schemaVersion);
      expect(identity.target).toEqual({});
      expect(row?.requestHash).toBe(identity.requestHash);
      expect(row?.legalEntityId).toBe(legalEntityId);
      expect(row?.targetResourceId).toBeNull();
      expect(row?.status).toBe('rejected');
    }
    const differentScopeIdentity = yield* prepareDefinePriceOriginalRequestIdentity(
      define,
      originalPrincipalFacts,
      yield* nextId,
    );
    expect(differentScopeIdentity.requestHash).not.toBe(defineIdentity.requestHash);
    const differentIntentIdentity = yield* prepareRevisePriceOriginalRequestIdentity(
      { ...revise, reason: 'Another immutable native revision intent.' },
      originalPrincipalFacts,
      legalEntityId,
    );
    expect(differentIntentIdentity.requestHash).not.toBe(reviseIdentity.requestHash);
  }),
);

it.layer(Layer.mergeAll(NodeCrypto.layer, ExternalPriceInputBoundaryFactoryLive), { excludeTestServices: true })(
  (suite) =>
    suite.effect(
      'native Pricing request hashes match public normalized owner identities after write revocation',
      () => originalPriceRequestIdentityEffect,
    ),
);
