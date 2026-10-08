import {
  ActionRuntime,
  ActiveApplicationCompositionService,
  ContextAccess,
  ModuleEntrypointGateway,
  ModuleStateGate,
  OperationalScopeResolver,
  TrustedPrincipalContextSchema,
  makeActionRuntimeLive,
  toBusinessPermissionAccessKey,
  toBusinessPermissionAccessObjectId,
} from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { Context, DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';

import { ActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import type { ActionRepositoryService } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { ActionPermission } from '../../../../packages/core-runtime/src/permissions/service.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { openModuleStateGate } from '../../../../packages/core-runtime/tests/support/open-module-state-gate.ts';

import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { createTaxRuleAction } from '../../src/actions/create-tax-rule.action.ts';

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

/** SpiceDB stand-in: a principal holds `tax.rule.manage` only on the exact Selling Legal Entity objects granted. */
const spiceDbContextAccess = (grantedSellers: readonly string[]): ContextAccessService => {
  const granted = new Set(
    grantedSellers.map((legalEntityId) =>
      toBusinessPermissionAccessObjectId('tax.rule.manage', {
        kind: 'tax_selling_legal_entity',
        legalEntityId,
        tenantId,
      }),
    ),
  );
  return {
    businessPermissions: ({ principal, targets }) =>
      Effect.succeed(
        targets.map((target) => ({
          decision:
            principal.principalId === principalId &&
            granted.has(toBusinessPermissionAccessObjectId(target.permission, target.target))
              ? ('allowed' as const)
              : ('denied' as const),
          key: toBusinessPermissionAccessKey(target),
        })),
      ),
    legalEntities: ({ legalEntityIds }) =>
      Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
    modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
    resources: ({ resources }) =>
      Effect.succeed(resources.map((resource) => ({ decision: 'denied' as const, key: resource.resourceId }))),
    tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'denied' as const, key }))),
  };
};

const sqlFailure = (cause: unknown) => new SqlError({ reason: new ConnectionError({ cause }) });

/**
 * Uses the same `makeActionRuntimeLive` composition as `api/index.ts`, with no
 * `OwnerAuthorizationOverlay`. PostgreSQL, SpiceDB, the Application Composition source and the
 * Core runtime support services are scripted.
 */
const makeProductionComposition = Effect.fn('TaxProductionRuntimeTest.make')(function* makeProductionComposition(
  grantedSellers: readonly string[],
) {
  const snapshot = yield* makeApplicationCompositionSnapshotFixture(
    [ultramodernDeliveryUnit.appId],
    ultramodernDeliveryUnit.buildMarker,
  );
  const ownerStatements: string[] = [];
  const permissionDenials: string[] = [];
  let installed = { legalEntityId: '', tenantId: '' };
  let invocation = {
    actionInvocationId: 'invocation-1',
    completedAt: null,
    requestHash: '',
    status: 'received' as const,
  };
  const query = Effect.fn('TaxProductionRuntimeTest.query')(function* scriptedQuery(
    statement: string,
    values: readonly unknown[],
  ) {
    const text = statement.toLowerCase();
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
      return [{ isolation: 'read committed' }];
    }
    if (text.includes('current_setting')) {
      return [{ legal_entity_id: installed.legalEntityId, tenant_id: installed.tenantId }];
    }
    if (text.includes('transaction_timestamp')) {
      return [{ operation_at: DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2027-01-02T00:00:00.000Z'))) }];
    }
    if (text.startsWith('select') && !text.includes('pg_advisory')) {
      return [{ authBindingId }];
    }
    return [];
  });
  const database = { executor: yield* makeTestDatabase(query) };
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
  const actionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
        Layer.succeed(CoreDatabase, database),
        Layer.succeed(ActionRepository, repository),
        Layer.succeed(ActionPermission, { checkActionPermission: () => Effect.succeed('allowed' as const) }),
        Layer.succeed(ContextAccess, spiceDbContextAccess(grantedSellers)),
        Layer.succeed(ModuleStateGate, openModuleStateGate),
        Layer.succeed(ModuleEntrypointGateway, openModuleEntrypointGateway),
        Layer.succeed(OperationalScopeResolver, testOperationalScopeResolver),
      ),
    ),
  );
  const runtime = Context.get(yield* Effect.scoped(Layer.build(actionRuntimeLive)), ActionRuntime);
  return { ownerStatements, permissionDenials, runtime };
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

it.effect(
  'runs a TAX Action through the production runtime composition only with a seller-bound permission',
  Effect.fn(function* taxActionThroughProductionComposition() {
    const permitted = yield* makeProductionComposition([sellerA]);
    const permittedFailure = yield* createTaxRule(permitted, sellerA);
    // Authorization passed and the TAX handler reached its owner persistence; the scripted
    // database then refuses owner SQL, which surfaces as a TAX domain failure, not an authz one.
    expect(permitted.ownerStatements.length).toBeGreaterThan(0);
    expect(permitted.permissionDenials).toEqual([]);
    expect(Predicate.isTagged(permittedFailure, 'TaxGovernancePersistenceUnavailable')).toBe(true);

    const ungranted = yield* makeProductionComposition([]);
    expect(Predicate.isTagged(yield* createTaxRule(ungranted, sellerA), 'ActionPermissionDenied')).toBe(true);
    expect(ungranted.ownerStatements).toEqual([]);

    const otherSeller = yield* makeProductionComposition([sellerA]);
    expect(Predicate.isTagged(yield* createTaxRule(otherSeller, sellerB), 'ActionPermissionDenied')).toBe(true);
    expect(otherSeller.ownerStatements).toEqual([]);
  }),
);
