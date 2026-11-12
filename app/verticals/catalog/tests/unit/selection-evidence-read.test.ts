import { NodeCrypto } from '@effect/platform-node';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessPrincipalKind } from '@app/core-runtime/access/enforcement';
import {
  LegalEntityIdSchema,
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  GrantIncarnationIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
} from '@app/core-runtime/access/ids';
import {
  preserveSystemPrincipalContextTrust,
  trustResolvedSystemPrincipalContext,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SelectionEvidenceRequestSchema } from '../../shared/apis/selection-evidence.ts';
import type { SelectionEvidenceResponse } from '../../shared/apis/selection-evidence.ts';
import { CatalogSelectionInjectedOwnerEvidenceSchema } from '../../shared/domain/catalog-selection-owner-contract.ts';
import type { CatalogSelectionInjectedOwnerEvidence } from '../../shared/domain/catalog-selection-owner-contract.ts';
import { readSelectionEvidence, selectionEvidenceRead } from '../../src/api/selection-evidence.read.ts';
import type { SelectionEvidenceServices } from '../../src/api/selection-evidence.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const selection = {
  productRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'commerce.catalog.product' as const,
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
};
const unavailableResponse: SelectionEvidenceResponse = {
  evidence: { kind: 'UNAVAILABLE', reason: 'Owner Current basis is unavailable' },
  missingRoles: [],
};

describe('Catalog selection-evidence read owner routing', () => {
  it.effect('assesses PRICING from Catalog owner-local evidence without reading Cart evidence', () =>
    Effect.gen(function* pricingOwnerLocalEvidence() {
      const request = Schema.decodeSync(SelectionEvidenceRequestSchema)({ purpose: 'PRICING', selection });
      let cartReads = 0;
      let receivedOwnerEvidence: CatalogSelectionInjectedOwnerEvidence | 'not-called' | undefined = 'not-called';
      const services: SelectionEvidenceServices = {
        assess: (_input, ownerEvidence) => {
          receivedOwnerEvidence = ownerEvidence;
          return Effect.succeed(unavailableResponse);
        },
        readCartEvidence: () => {
          cartReads += 1;
          return Effect.die('PRICING must not request Cart evidence');
        },
      };

      const result = yield* readSelectionEvidence(request, tenantId, services);

      expect(result).toEqual(unavailableResponse);
      expect(receivedOwnerEvidence).toBeUndefined();
      expect(cartReads).toBe(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('preserves injected Cart evidence for non-PRICING purposes', () =>
    Effect.gen(function* cartQualifiedEvidence() {
      const request = Schema.decodeSync(SelectionEvidenceRequestSchema)({ purpose: 'CART_VALIDATION', selection });
      const ownerEvidence = Schema.decodeSync(CatalogSelectionInjectedOwnerEvidenceSchema)({
        evidenceId: 'cart-selection-evidence-v1',
        observedAt: '2026-09-27T10:00:00.000Z',
        owner: 'CART',
        ownerRevision: {
          moduleId: 'commerce.cart',
          resourceId: 'cart-1',
          resourceType: 'commerce.cart.cart',
          revision: 1,
          tenantId,
        },
        purpose: 'CART_VALIDATION',
        selection,
      });
      let receivedOwnerEvidence: CatalogSelectionInjectedOwnerEvidence | undefined;
      const services: SelectionEvidenceServices = {
        assess: (_input, evidence) => {
          receivedOwnerEvidence = evidence;
          return Effect.succeed(unavailableResponse);
        },
        readCartEvidence: () => Effect.succeed(ownerEvidence),
      };

      const result = yield* readSelectionEvidence(request, tenantId, services);

      expect(result).toEqual(unavailableResponse);
      expect(receivedOwnerEvidence).toEqual(ownerEvidence);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

const selectionWorkload = 'commerce.catalog.symmy-product-read';
const principalId = '44444444-4444-4444-8444-444444444444';
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T12:00:00Z'));
const actorScope = (caller?: string, system = false): OperationalScope => {
  const context = Schema.decodeSync(TrustedPrincipalContextSchema)(
    system
      ? {
          authContextRef: 'job:catalog-selection-test:run:1',
          authMethod: 'system',
          principalId,
          tenantId,
        }
      : {
          authBindingId: '55555555-5555-4555-8555-555555555555',
          authContextRef: 'catalog-selection-session',
          authMethod: 'session',
          principalId,
          tenantId,
        },
  );
  const trusted = system
    ? trustResolvedSystemPrincipalContext(context)
    : trustVerifiedGatewayPrincipalContext(
        context,
        'c'.repeat(64),
        undefined,
        caller === undefined
          ? undefined
          : {
              appId: caller,
              buildMarker: 'catalog-selection-caller-build',
              principalId: '66666666-6666-4666-8666-666666666666',
            },
      );
  return preserveSystemPrincipalContextTrust(trusted, { ...trusted, correlationId: 'catalog-selection-gate-test' });
};
const selectionGate = (input: {
  readonly boundKeys?: readonly string[];
  readonly grants?: boolean;
  readonly kind: AccessPrincipalKind;
}) =>
  makeAccessDecisionService({
    authorityFor: () => ({
      readCells: (query) =>
        Effect.succeed(
          input.grants === false
            ? []
            : [
                {
                  assignedAt: operationTime,
                  assignedBy: PrincipalIdSchema.make(principalId),
                  assignmentIncarnationId: AssignmentIncarnationIdSchema.make('77777777-7777-4777-8777-777777777777'),
                  capabilityKey: query.capabilityKey,
                  grantIncarnationId: GrantIncarnationIdSchema.make('88888888-8888-4888-8888-888888888888'),
                  holder: query.holder,
                  mode: query.mode,
                  roleId: RoleIdSchema.make('99999999-9999-4999-8999-999999999999'),
                  roleRevisionId: RoleRevisionIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
                  selector: { _tag: 'all' },
                },
              ],
        ),
      readConnection: () => Effect.succeed(Option.none()),
      readScope: (query) =>
        Effect.succeed(
          Option.some({
            deadlines: [],
            holderDeadlines: [],
            scope: { _tag: 'TenantContext', tenantId: query.tenantId },
            scopeId: AccessScopeIdSchema.make('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
            tenantId: query.tenantId,
          }),
        ),
      readTeamIds: () => Effect.succeed([]),
    }),
    check: { checkBulk: (items) => Effect.succeed(items.map(() => ({ permissionship: 'has' }))) },
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed([]) },
    principalKinds: { readKind: () => Effect.succeed(Option.some(input.kind)) },
    workloadBindings: {
      readActiveWorkloadKeys: (query) =>
        Effect.succeed(
          new Set(query.principalId === principalId && query.tenantId === tenantId ? (input.boundKeys ?? []) : []),
        ),
      readCompanyDeclaration: (query) =>
        Effect.succeed({
          activeCompanyIds: new Set(
            query.scope.legalEntityId === undefined ? [] : [LegalEntityIdSchema.make(query.scope.legalEntityId)],
          ),
          pinned: true,
        }),
    },
  });
const decideSelection = (gate: ReturnType<typeof selectionGate>, scope: OperationalScope) =>
  gate.decide({
    carrier: selectionEvidenceRead.descriptor,
    legalEntityScope: selectionEvidenceRead.descriptor.legalEntityScope,
    now: operationTime,
    scope,
  });

describe('Catalog selection-evidence exact workload authorization', () => {
  it.effect('retains direct human declaration grants and refuses a human without that grant', () =>
    Effect.gen(function* humanReadAuthorization() {
      const allowed = yield* decideSelection(selectionGate({ kind: 'human' }), actorScope());
      const denied = yield* decideSelection(selectionGate({ grants: false, kind: 'human' }), actorScope());
      expect(allowed.outcome).toBe('ALLOWED');
      expect(denied.outcome).toBe('DENIED');
      expect(selectionEvidenceRead.descriptor.accessDeclaration?.key).toBe('commerce.catalog.selection-evidence.read');
      expect(selectionEvidenceRead.descriptor.legalEntityScope).toBe('forbidden');
    }),
  );
  it.effect('retains the existing Pricing actor identity path for a current human', () =>
    Effect.gen(function* pricingHumanIdentity() {
      const result = yield* decideSelection(selectionGate({ grants: false, kind: 'human' }), actorScope('pricing'));
      expect(result.outcome).toBe('ALLOWED');
      expect(result.reasons.map(({ code }) => code)).toEqual(['allow.actor_identity']);
    }),
  );
  it.effect('admits only the bound Product read workload through the exact Pricing actor', () =>
    Effect.gen(function* pricingIntegrationRead() {
      const gate = selectionGate({ boundKeys: [selectionWorkload], grants: false, kind: 'integration' });
      const allowed = yield* decideSelection(gate, actorScope('pricing'));
      const foreign = yield* decideSelection(gate, actorScope('foreign-module'));
      const revoked = yield* decideSelection(
        selectionGate({ boundKeys: [], kind: 'integration' }),
        actorScope('pricing'),
      );
      expect(allowed.outcome).toBe('ALLOWED');
      expect(foreign.outcome).toBe('DENIED');
      expect(foreign.reasons.map(({ code }) => code)).toContain('deny.actor_unbound');
      expect(revoked.outcome).toBe('DENIED');
    }),
  );
  it.effect('admits a registered current system read workload and refuses the write workload', () =>
    Effect.gen(function* directSystemRead() {
      const scope = actorScope(undefined, true);
      const allowed = yield* decideSelection(selectionGate({ boundKeys: [selectionWorkload], kind: 'system' }), scope);
      const wrongKey = yield* decideSelection(
        selectionGate({ boundKeys: ['commerce.catalog.symmy-product-import'], kind: 'system' }),
        scope,
      );
      expect(allowed.outcome).toBe('ALLOWED');
      expect(wrongKey.outcome).toBe('DENIED');
      expect(wrongKey.reasons.map(({ code }) => code)).toContain('deny.workload_unbound');
    }),
  );
});
