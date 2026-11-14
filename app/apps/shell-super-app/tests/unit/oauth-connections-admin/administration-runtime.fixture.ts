import type { AccessIntentError } from '../../../../../packages/core-runtime/src/access/intent/errors.ts';
import { makeOperationalScopeResolver, OperationalScopeResolver } from '@app/core-runtime';
import type { OperationalScope, TrustedPrincipalContext } from '@app/core-runtime';
import {
  AccessScopeIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import { makeAccessProjectionCompiler } from '@app/core-runtime/access/compiler/spice-db-compiler';
import { makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { AccessProjectionTransport } from '@app/core-runtime/access/compiler/spice-db-compiler';
import { AccessProjectionCompiler } from '@app/core-runtime/access/intent/projection-compiler';
import { AccessProjectionWriterLive } from '@app/core-runtime/access/intent/projection-writer';
import { TenantIntentLoader } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { AccessWriteJournalStore } from '@app/core-runtime/access/lifecycle/persistence/journal-store';
import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { v1 } from '@authzed/authzed-node';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Option } from 'effect';
import { expect } from 'effect-rstest';

interface AdministrationRequest {
  readonly principal: TrustedPrincipalContext & { readonly legalEntityId: string };
}

/** The real resolver, with current persisted identity facts and a scripted selection port. */
export const administrationScopeLayer = (request: AdministrationRequest) =>
  Layer.effect(
    OperationalScopeResolver,
    Effect.gen(function* administrationScopeResolver() {
      const namespaces = yield* AuthenticationNamespaceRegistry;
      // Answers the company question with the request's own company; every other question is denied.
      const access = makeTestAccessDecision({
        legalEntityIds: [LegalEntityIdSchema.make(request.principal.legalEntityId)],
      });
      const resolver = yield* makeOperationalScopeResolver(
        {
          load: (principal) => {
            expect(principal).toBe(request.principal);
            return Effect.succeed({
              bindingAuthenticationNamespaceId: principal.authenticationNamespaceId ?? null,
              bindingPrincipalId: principal.principalId,
              bindingRevokedAt: null,
              bindingStatus: 'active',
              bindingSubjectType: 'user',
              bindingTenantId: principal.tenantId,
              legalEntityStatus: 'active',
              legalEntityTenantId: principal.tenantId,
              principalKind: 'human',
              principalStatus: 'active',
              principalTenantId: principal.tenantId,
              tenantStatus: 'active',
            });
          },
        },
        access,
      );
      return {
        resolve: (input) =>
          resolver.resolve(input).pipe(Effect.provideService(AuthenticationNamespaceRegistry, namespaces)),
      } satisfies (typeof OperationalScopeResolver)['Service'];
    }),
  ).pipe(
    Layer.provide(
      Layer.merge(NodeCrypto.layer, staffAuthenticationNamespaceRegistryLayer(['shell-admin', 'shell-super-app'])),
    ),
  );

type JournalStore = (typeof AccessWriteJournalStore)['Service'];
type Fence = Effect.Success<ReturnType<JournalStore['acquireFence']>>['fence'];
type Journal = Parameters<JournalStore['writeJournal']>[1];
type IntentLoader = (typeof TenantIntentLoader)['Service'];

/**
 * Real projection writer and compiler over isolated in-memory I/O ports. No database or live engine
 * is opened, and no role, agent connection or grant is provisioned by this fixture.
 */
export const administrationProjectionLayer = (
  request: AdministrationRequest,
  reconciled: string[],
  scopes: OperationalScope[],
  observe: (scope: OperationalScope) => Effect.Effect<void, AccessIntentError> = () => Effect.void,
) => {
  const tenantId = TenantIdSchema.make(request.principal.tenantId);
  const principalId = PrincipalIdSchema.make(request.principal.principalId);
  const legalEntityId = LegalEntityIdSchema.make(request.principal.legalEntityId);
  const tenantScopeId = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000008');
  const companyScopeId = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000009');
  const journals = new Map<string, Journal>();
  let fence: Fence = { revision: 0, scopeId: tenantScopeId, state: 'Ready', tenantId };
  const assertScope = (scope: OperationalScope) => {
    expect(scope.principalId).toBe(request.principal.principalId);
    expect(scope.authBindingId).toBe(request.principal.authBindingId);
    expect(scope.authContextRef).toBe(request.principal.authContextRef);
    expect(scope.authenticationNamespaceId).toBe(request.principal.authenticationNamespaceId);
    expect(scope.tenantId).toBe(tenantId);
    expect(scope.legalEntityId).toBe(request.principal.legalEntityId);
  };
  const journal: JournalStore = {
    acquireFence: (scope, command) =>
      Effect.sync(() => {
        assertScope(scope);
        expect(command.scopeId).toBe(tenantScopeId);
        expect(command.tenantId).toBe(tenantId);
        if (fence.state !== 'Ready' || fence.revision !== command.expectedRevision) {
          return { _tag: 'Conflict', fence };
        }
        fence = {
          owningOperationId: command.operationId,
          revision: fence.revision + 1,
          scopeId: tenantScopeId,
          state: 'Changing',
          tenantId,
        };
        return { _tag: 'Acquired', fence };
      }),
    readFence: (scope, command) =>
      Effect.sync(() => {
        assertScope(scope);
        expect(command.tenantId).toBe(tenantId);
        return Option.some(
          command.scopeId === tenantScopeId
            ? fence
            : { revision: 0, scopeId: companyScopeId, state: 'Ready' as const, tenantId },
        );
      }),
    readJournal: (scope, command) =>
      Effect.sync(() => {
        assertScope(scope);
        expect(command.tenantId).toBe(tenantId);
        return Option.fromUndefinedOr(journals.get(command.operationId));
      }),
    releaseFence: (scope, command) =>
      Effect.sync(() => {
        assertScope(scope);
        if (fence.owningOperationId !== command.operationId || fence.revision !== command.expectedRevision) {
          return { _tag: 'Conflict', fence };
        }
        fence = { revision: fence.revision + 1, scopeId: tenantScopeId, state: 'Ready', tenantId };
        return { _tag: 'Released', fence };
      }),
    writeJournal: (scope, entry) =>
      Effect.sync(() => {
        assertScope(scope);
        expect(entry.tenantId).toBe(tenantId);
        expect(entry.scopeId).toBe(tenantScopeId);
        journals.set(entry.operationId, entry);
      }),
  };
  const holder = { _tag: 'Principal' as const, principalId };
  const emptyScope = { assignments: [], connections: [], delegations: [], installations: [], roleRevisions: [] };
  const intent: Effect.Success<ReturnType<IntentLoader['loadProjection']>> = {
    catalogEntries: [],
    coverage: 'complete',
    legalEntities: [{ accessAdmins: [], legalEntityId, members: [{ holder }], suspended: [] }],
    members: [{ holder }],
    owners: [principalId],
    principals: [{ kind: 'human', principalId }],
    scopes: [
      { ...emptyScope, scope: { id: tenantScopeId, scope: { _tag: 'TenantContext', tenantId } } },
      { ...emptyScope, scope: { id: companyScopeId, scope: { _tag: 'LegalEntity', legalEntityId, tenantId } } },
    ],
    suspended: [],
    tenantId,
  };
  const loader: IntentLoader = {
    loadAuthorityCells: () => Effect.die('Unexpected authority read'),
    loadAuthorityCellsMany: () => Effect.die('Unexpected authority read'),
    loadConfigureBases: () => Effect.die('Unexpected configuration read'),
    loadConnection: () => Effect.die('Unexpected connection read'),
    loadProjection: (scope) =>
      Effect.gen(function* loadProjection() {
        assertScope(scope);
        // The writer reads the intent twice per reconcile: before it takes the fence, and again under it to see any
        // intent written in between. Only the first read starts a reconcile, so only it is observed and recorded.
        if (fence.state === 'Changing') {
          return intent;
        }
        yield* observe(scope);
        reconciled.push(scope.tenantId);
        scopes.push(scope);
        return intent;
      }),
    loadScope: () => Effect.die('Unexpected decision scope read'),
    loadTeamIds: () => Effect.die('Unexpected team read'),
    loadTenantContextScopeId: (scope) =>
      Effect.sync(() => {
        assertScope(scope);
        return Option.some(tenantScopeId);
      }),
  };
  const relationships = new Map<string, v1.Relationship>();
  let revision = 0;
  const transport: AccessProjectionTransport = {
    close: () => relationships.clear(),
    readRelationships: (input) =>
      Effect.sync(() => {
        const filter = input.relationshipFilter;
        expect(filter).toBeDefined();
        if (filter === undefined) {
          return [];
        }
        return [...relationships.values()]
          .filter(
            (relationship) =>
              relationship.resource?.objectType === filter.resourceType &&
              relationship.relation === filter.optionalRelation &&
              relationship.resource.objectId.startsWith(filter.optionalResourceIdPrefix),
          )
          .map((relationship) => v1.ReadRelationshipsResponse.create({ relationship }));
      }),
    writeRelationships: (input) =>
      Effect.sync(() => {
        for (const update of input.updates) {
          const { relationship } = update;
          expect(relationship).toBeDefined();
          if (relationship === undefined) {
            continue;
          }
          const key = JSON.stringify(relationship);
          if (update.operation === v1.RelationshipUpdate_Operation.DELETE) {
            relationships.delete(key);
          } else {
            relationships.set(key, relationship);
          }
        }
        revision += 1;
        return v1.WriteRelationshipsResponse.create({ writtenAt: { token: `fixture-projection-${revision}` } });
      }),
  };
  return AccessProjectionWriterLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(AccessProjectionCompiler, makeAccessProjectionCompiler(transport)),
        Layer.succeed(AccessWriteJournalStore, journal),
        Layer.succeed(TenantIntentLoader, loader),
      ),
    ),
  );
};
