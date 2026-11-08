import { taxRegistration } from '../../vertical.registration.ts';
import {
  ActionRuntime,
  ActiveApplicationCompositionService,
  ContextAccess,
  ModuleEntrypointGateway,
  ModuleStateGate,
  OperationalScopeResolver,
  OntosModuleDeploymentContractSchema,
  extractVerticalRuntimeSafeDescriptors,
  TrustedPrincipalContextSchema,
  makeActionRuntimeLive,
} from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { Context, DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { ActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import type { ActionRepositoryService } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { ActionPermission } from '../../../../packages/core-runtime/src/permissions/service.ts';
import { makeTaxGovernanceAccessFixture } from '../support/tax-governance-production-access.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { openModuleStateGate } from '../../../../packages/core-runtime/tests/support/open-module-state-gate.ts';

import { createTaxRuleAction } from '../../src/actions/create-tax-rule.action.ts';
import { publishedTaxComposition } from '../support/published-tax-composition.ts';

import { makeDatabaseIdentityEnrollmentLive } from '../../../../packages/core-runtime/src/db/database-identities.ts';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const authBindingId = '40000000-0000-4000-8000-000000000001';
const sellerA = '30000000-0000-4000-8000-000000000001';
const sellerB = '30000000-0000-4000-8000-000000000002';

const principalFor = (legalEntityId: string) =>
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId,
    authContextRef: 'better-auth-session:tax-production-runtime',
    authenticationNamespaceId: 'core-identity',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  });

/** The retired legacy authority: the one access gate decides a protected Tax Action (O62). */
const legacyContextAccess: ContextAccessService = {
  legalEntities: () => Effect.die('The protected Tax carrier must not consult legacy company authority'),
  modules: () => Effect.die('The protected Tax carrier must not consult legacy module authority'),
  ownerPermissions: () => Effect.die('The gate decides; no legacy owner target is checked'),
  resources: () => Effect.die('The protected Tax carrier must not consult legacy resource authority'),
  tenants: () => Effect.die('The protected Tax carrier must not consult legacy tenant authority'),
};

const sqlFailure = (cause: unknown) => new SqlError({ reason: new ConnectionError({ cause }) });

/**
 * Uses the same `makeActionRuntimeLive` composition as `api/index.ts`, with no
 * `OwnerAuthorizationOverlay`. Core's gate, intent loader, actor/evidence ports and persisted
 * currentness run against one scripted PostgreSQL connection. Only external engine answers,
 * publication input, repository, context resolution and module-state support are scripted.
 */
const makeProductionComposition = Effect.fn('TaxProductionRuntimeTest.make')(function* makeProductionComposition(
  grantedSellers: readonly string[],
  fault: 'none' | 'Changing' | 'missing' | 'engine-unavailable',
) {
  let transactionDepth = 0;
  let isolation = 'read committed';
  const access = yield* makeTaxGovernanceAccessFixture({
    fenceState: fault === 'Changing' || fault === 'missing' ? fault : 'Ready',
    grantedSellers,
    graphAnswer: fault === 'engine-unavailable' ? 'error' : 'has',
    principalId,
    sellerA,
    sellerB,
    tenantId,
    transactionOpen: () => transactionDepth !== 0,
  });
  const { deployment, snapshot } = yield* publishedTaxComposition;
  const statements: string[] = [];
  const unsupportedStatements: string[] = [];
  const ownerStatements: string[] = [];
  const permissionDenials: string[] = [];
  let installed = { legalEntityId: '', tenantId: '' };
  let invocation = {
    actionInvocationId: 'invocation-1',
    actionKey: createTaxRuleAction.descriptor.actionKey,
    completedAt: null,
    requestHash: '',
    status: 'received' as const,
  };
  const query = Effect.fn('TaxProductionRuntimeTest.query')(function* scriptedQuery(
    statement: string,
    values: readonly unknown[],
  ) {
    const text = statement.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
    statements.push(text);
    if (text.startsWith('begin')) {
      expect(transactionDepth).toBe(0);
      transactionDepth += 1;
      isolation = 'read committed';
      return [];
    }
    if (text === 'set transaction isolation level repeatable read') {
      expect(transactionDepth).toBe(1);
      expect(values).toEqual([]);
      isolation = 'repeatable read';
      return [];
    }
    if (text === 'commit' || text === 'rollback') {
      transactionDepth -= 1;
      expect(transactionDepth).toBe(0);
      return [];
    }
    if (text.includes('savepoint')) {
      return yield* Effect.die('Joined authority must not open a second transaction');
    }
    if (text.includes('"tax".')) {
      ownerStatements.push(text);
      return yield* sqlFailure(new Error('TAX owner persistence is outside this authorization test'));
    }
    if (text.includes('set_config')) {
      const [scopedTenantId, scopedLegalEntityId] = values;
      if (Predicate.isString(scopedTenantId) && Predicate.isString(scopedLegalEntityId)) {
        installed = { legalEntityId: scopedLegalEntityId, tenantId: scopedTenantId };
      }
      return [];
    }
    if (text.includes('application_composition_authority')) {
      return [{ phase: 'active', revision: snapshot.composition.revision, subscriptionsJson: [], unexpired: true }];
    }
    if (text.includes("current_setting('transaction_isolation')")) {
      return [{ isolation }];
    }
    if (text.includes('current_setting')) {
      return [{ legal_entity_id: installed.legalEntityId, role: 'ontos_runtime', tenant_id: installed.tenantId }];
    }
    if (text.includes('transaction_timestamp')) {
      return [{ operation_at: DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2027-01-02T00:00:00.000Z'))) }];
    }
    const accessRows = access.read({ params: values, scope: installed, sql: statement });
    if (Option.isSome(accessRows)) {
      return yield* accessRows.value;
    }
    if (text.includes('pg_advisory')) {
      return [];
    }
    unsupportedStatements.push(statement);
    return yield* sqlFailure(new Error(`Unscripted production runtime SQL: ${statement}`));
  });
  const database = { executor: yield* makeTestDatabase(query) };
  const accessLayer = yield* access.makeLayer({
    enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    executor: database.executor,
  });
  const repository: ActionRepositoryService = {
    createOrResolveInvocation: (_executor, input) =>
      Effect.sync(() => {
        invocation = { ...invocation, requestHash: invocation.requestHash || input.requestHash };
        return invocation;
      }),
    finalizePolicyDenial: () => Effect.succeedNone,
    flushSuccess: () => Effect.void,
    loadRecordedRejection: () =>
      Effect.succeed(permissionDenials.length > 0 ? Option.some({ stage: 'authz' as const }) : Option.none()),
    lockInvocation: () => Effect.sync(() => invocation),
    rejectPermissionDenied: (_executor, input) =>
      Effect.sync(() => {
        permissionDenials.push(input.actionInvocationId);
        return Option.none();
      }),
    resolveInvocation: () => Effect.sync(() => invocation),
    transitionInvocationToRunning: () => Effect.sync(() => invocation),
  };
  const actionRuntimeLive = makeActionRuntimeLive(deployment, taxRegistration).pipe(
    Layer.provide(
      Layer.mergeAll(
        makeDatabaseIdentityEnrollmentLive(FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
        Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
        Layer.succeed(CoreDatabase, database),
        Layer.succeed(ActionRepository, repository),
        Layer.succeed(ActionPermission, {
          checkActionPermission: () => Effect.die('The original Tax carrier must use the canonical gate'),
        }),
        Layer.succeed(ContextAccess, legacyContextAccess),
        accessLayer,
        Layer.succeed(ModuleStateGate, openModuleStateGate),
        Layer.succeed(ModuleEntrypointGateway, openModuleEntrypointGateway),
        Layer.succeed(OperationalScopeResolver, testOperationalScopeResolver),
      ),
    ),
  );
  const runtime = Context.get(yield* Effect.scoped(Layer.build(actionRuntimeLive)), ActionRuntime);
  return {
    accessDecisions: access.decisions,
    askedLegalEntities: () => access.kindQueries.map((one) => one.scope.legalEntityId ?? '<tenant>'),
    ownerStatements,
    permissionDenials,
    remoteChecks: access.remoteChecks,
    runtime,
    statements,
    transactionDepth: () => transactionDepth,
    unsupportedStatements,
  };
});

const createTaxRule = (
  composition: Effect.Success<ReturnType<typeof makeProductionComposition>>,
  legalEntityId: string,
) =>
  composition.runtime
    .runAction({
      // Wire form: Core decodes the payload with the Action's own schema.
      payload: {
        initialRevision: {
          compositionKind: 'EXCLUSIVE',
          effectiveFrom: '2027-01-01T00:00:00.000Z',
          jurisdiction: 'CZ_DOMESTIC',
          ratePercent: '21',
          taxClassificationCode: 'cz-standard-goods',
          treatmentCategory: 'TAXABLE',
        },
        meaningKind: 'VAT_RATE',
        provenanceRef: 'test:tax-production-runtime',
        reason: 'Governed tax change',
        stableCode: 'cz.standard',
      },
      principal: principalFor(legalEntityId),
      registration: createTaxRuleAction,
      transport: {
        correlationId: 'correlation-tax-production-runtime',
        idempotencyKey: 'tax-production-runtime',
        targetModuleKey: 'commerce.tax',
        targetResourceId: legalEntityId,
        targetResourceType: 'commerce.tax.tax-rule',
      },
    })
    .pipe(Effect.flip);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))('TAX production runtime fixture', (suite) => {
  suite.effect('runs a TAX Action through the production runtime composition only with a seller-bound permission', () =>
    Effect.gen(function* taxActionThroughProductionComposition() {
      yield* TestClock.setTime(Date.parse('2027-01-02T00:00:00.000Z'));
      const permitted = yield* makeProductionComposition([sellerA], 'none');
      const permittedFailure = yield* createTaxRule(permitted, sellerA);
      expect(permitted.unsupportedStatements).toEqual([]);
      // Authorization passed and the TAX handler reached its owner persistence; the scripted
      // database then refuses owner SQL, which surfaces as a TAX domain failure, not an authz one.
      expect(permittedFailure).toMatchObject({ _tag: 'TaxGovernancePersistenceUnavailable' });
      expect(permitted.ownerStatements.length).toBeGreaterThan(0);
      expect(permitted.permissionDenials).toEqual([]);
      expect(Predicate.isTagged(permittedFailure, 'TaxGovernancePersistenceUnavailable')).toBe(true);
      // The gate asked the Action's own capability in the selected Selling Legal Entity's scope (O7),
      // twice on purpose: the runner re-decides while holding the shared access fence, and both answers
      // name the same seller, so the fence never moves the decision to another scope.
      expect(permitted.askedLegalEntities()).toEqual([sellerA, sellerA]);
      expect(permitted.accessDecisions.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'ALLOWED']);
      for (const entry of permitted.accessDecisions) {
        expect(entry.scope).toMatchObject({ authBindingId, legalEntityId: sellerA, principalId, tenantId });
        expect(entry.capability.capabilityKey).toBe(createTaxRuleAction.descriptor.accessDeclaration?.key);
        expect(entry.mode).toBe('run');
        expect(entry.target).toBeUndefined();
      }
      expect(permitted.remoteChecks()).toBe(1);
      expect(permitted.transactionDepth()).toBe(0);
      expect(permitted.statements.some((sql) => sql.includes('savepoint'))).toBe(false);
      expect(permitted.statements.some((sql) => sql.includes('access_scope_fences'))).toBe(true);

      const ungranted = yield* makeProductionComposition([], 'none');
      expect(Predicate.isTagged(yield* createTaxRule(ungranted, sellerA), 'ActionPermissionDenied')).toBe(true);
      expect(ungranted.unsupportedStatements).toEqual([]);
      expect(ungranted.ownerStatements).toEqual([]);
      expect(ungranted.accessDecisions.map(({ outcome }) => outcome)).toEqual(['DENIED']);
      expect(ungranted.remoteChecks()).toBe(0);

      const otherSeller = yield* makeProductionComposition([sellerA], 'none');
      expect(Predicate.isTagged(yield* createTaxRule(otherSeller, sellerB), 'ActionPermissionDenied')).toBe(true);
      expect(otherSeller.unsupportedStatements).toEqual([]);
      expect(otherSeller.ownerStatements).toEqual([]);
      expect(otherSeller.askedLegalEntities()).toEqual([sellerB]);
      expect(otherSeller.accessDecisions.map(({ outcome }) => outcome)).toEqual(['DENIED']);
      expect(otherSeller.remoteChecks()).toBe(0);
    }),
  );
  suite.effect('projects the original Tax operation contracts and receiving deployment without build output', () =>
    Effect.gen(function* originalPublishedContracts() {
      const { deployment, snapshot } = yield* publishedTaxComposition;
      expect(deployment).toEqual({
        appId: ultramodernDeliveryUnit.appId,
        buildMarker: ultramodernDeliveryUnit.buildMarker,
      });
      const [owner] = snapshot.composition.modules;
      const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
        owner?.contractDocument,
      );
      const original = extractVerticalRuntimeSafeDescriptors(taxRegistration);
      expect(contract.deployment).toEqual(deployment);
      expect(contract.manifest.module.id).toBe(taxRegistration.moduleId);
      expect(contract.manifest.publicSurface.actions).toEqual(original.actions);
      expect(contract.manifest.publicSurface.operationContracts).toEqual(original.operationContracts);
      expect(contract.manifest.requirements).toEqual(original.requirements);
      expect(owner?.requiredCoreCapabilities).toEqual(original.requirements?.coreCapabilities ?? []);
      expect(contract.manifest.publicSurface.actions).not.toEqual([]);
    }),
  );
  for (const fault of ['Changing', 'missing', 'engine-unavailable'] as const) {
    suite.effect(`keeps ${fault} canonical authority unavailable with zero Tax owner observation`, () =>
      Effect.gen(function* unavailableAuthority() {
        yield* TestClock.setTime(Date.parse('2027-01-02T00:00:00.000Z'));
        const fixture = yield* makeProductionComposition([sellerA], fault);
        const failure = yield* createTaxRule(fixture, sellerA);
        expect(fixture.unsupportedStatements).toEqual([]);
        expect(failure).toMatchObject({ _tag: 'ActionPermissionCheckError' });
        expect(fixture.ownerStatements).toEqual([]);
        expect(fixture.permissionDenials).toEqual([]);
        expect(fixture.transactionDepth()).toBe(0);
        expect(fixture.remoteChecks()).toBe(fault === 'engine-unavailable' ? 1 : 0);
      }),
    );
  }
});
