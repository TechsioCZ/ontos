// @rstest-environment node
import { AgentModuleKeySchema } from '@app/shared-contracts/agent-proposals';
import {
  ContextAccess,
  OAuthAuthenticationAudit,
  OAuthAuthenticationAuditUnavailable,
  OAuthConnectionCompanies,
  OAuthGrantModulesSchema,
  OAuthGrantRegistry,
  ReadPermissionDenied,
  ReadRuntime,
} from '@app/core-runtime';
import type { ContextAccessResult, OAuthGrantRecord, ReadRuntimeService } from '@app/core-runtime';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import {
  AgentAccessGrantIdSchema,
  CONNECTION_STATUSES,
  ConnectionSummarySchema as AdminConnectionSummarySchema,
} from '@app/shared-contracts/agent-access';
import type { AgentModuleGrant } from '@app/shared-contracts/agent-access';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeModuleContractFixture } from '../../../../../packages/core-runtime/src/testing/module-contract.ts';
import { OAuthCredentials } from '../../../api/auth/db/oauth-credentials.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../../api/modules/installed-module-catalog.ts';
import { GrantAdminLive } from '../../../api/oauth-connections-admin/grant-port-live.ts';
import type { GrantAdminRequest } from '../../../api/oauth-connections-admin/grant-port-live.ts';
import { GrantAdmin } from '../../../api/oauth-connections-admin/ports.ts';
import { OAuthGrantOwnersLive } from '../../../api/oauth-connections/grant-store.ts';
import { OAuthFlow } from '../../../api/oauth-connections/oauth-flow.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';
import { grantRegistryFixture, retainedGrant } from '../oauth-connections/grant-registry-fixture.ts';

const principal: GrantAdminRequest['principal'] = {
  authBindingId: '00000000-0000-4000-8000-000000000007',
  authContextRef: 'better-auth-session:grant-admin',
  authenticationNamespaceId: 'test.staff.better-auth.v1',
  authMethod: 'session',
  legalEntityId: retainedGrant.legalEntityId,
  principalId: retainedGrant.userPrincipalId,
  tenantId: retainedGrant.tenantId,
};
const transport = { audience: 'shell-admin', correlationId: 'grant-admin', traceId: 'original-trace' };
const request: GrantAdminRequest = { principal, transport };
const filter = { legalEntityId: principal.legalEntityId, statuses: CONNECTION_STATUSES, tenantId: principal.tenantId };
const revoked: OAuthGrantRecord = { ...retainedGrant, revokedAt: retainedGrant.createdAt, status: 'revoked' };
const noteDenied = new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'retained owner denied' });
const auditDenied = new OAuthAuthenticationAuditUnavailable({ cause: 'audit failed', reason: 'observer unavailable' });

interface FixtureOptions {
  readonly auditFails?: boolean;
  readonly notesFail?: boolean;
  readonly readableModules?: readonly string[];
  readonly request?: GrantAdminRequest;
  readonly rows?: readonly OAuthGrantRecord[];
}

const fixture = (options: FixtureOptions = {}) =>
  Effect.gen(function* grantAdminFixture() {
    const rows = [...(options.rows ?? [retainedGrant])];
    const rowIndices = new Map(rows.map((row, index) => [row.grantId, index]));
    const events: string[] = [];
    const noteRequests: unknown[] = [];
    const selections: unknown[] = [];
    const authorityReads: string[] = [];
    let activeReads = 0;
    let maxReads = 0;
    const registry = grantRegistryFixture({
      findGrant: (grantId) => Effect.succeed(Option.fromUndefinedOr(rows.find((row) => row.grantId === grantId))),
      listGrants: (input) =>
        Effect.sync(() => {
          selections.push(input);
          return rows;
        }),
      loadBindingStatus: () => Effect.succeed(Option.some('active')),
      loadPrincipals: (_tenantId, ids) =>
        Effect.succeed(new Map(ids.map((id) => [id, { displayName: id, kind: 'human', status: 'active' }]))),
      owners: ({ grantIds, legalEntityId, tenantId }) =>
        Effect.succeed(
          rows.filter(
            (row) => grantIds.includes(row.grantId) && row.legalEntityId === legalEntityId && row.tenantId === tenantId,
          ),
        ),
      setGrantBindingStatus: () =>
        Effect.sync(() => {
          events.push('binding-disabled');
        }),
      setGrantStatus: (input) =>
        Effect.sync(() => {
          events.push('grant-disabled');
          const index = rowIndices.get(input.grantId) ?? -1;
          const row = rows[index];
          if (row === undefined) {
            return Option.none();
          }
          const updated = { ...row, status: input.status };
          rows[index] = updated;
          return Option.some(updated);
        }),
      updateGrantAccess: (input) =>
        Effect.sync(() => {
          events.push('access-updated');
          const index = rowIndices.get(input.grantId) ?? -1;
          const row = rows[index];
          if (row === undefined) {
            return Option.none();
          }
          const updated = { ...row, modules: input.modules, writePolicy: input.writePolicy };
          rows[index] = updated;
          return Option.some(updated);
        }),
    });
    const reads: ReadRuntimeService = {
      runRead: (input) => {
        noteRequests.push(input);
        return options.notesFail === true
          ? Effect.fail(noteDenied)
          : Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)({
              notes: rows
                .filter((row) => row.status === 'revoked')
                .map((row) => ({ grantId: row.grantId, note: 'Reason' })),
            }).pipe(Effect.orDie);
      },
    };
    const owners = Layer.merge(Layer.succeed(OAuthGrantRegistry, registry), Layer.succeed(ReadRuntime, reads));
    const readableModules = options.readableModules ?? [];
    const installed = yield* makeInstalledModuleCatalogLoader(
      makeCompositionSnapshot(
        readableModules.map((moduleId) =>
          makeModuleContractFixture({ appId: moduleId.replaceAll('.', '-'), moduleId }),
        ),
      ),
    );
    const dependencies = Layer.mergeAll(
      owners,
      OAuthGrantOwnersLive.pipe(Layer.provide(owners)),
      Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Layer.succeed(ContextAccess, {
        legalEntities: ({ legalEntityIds }) =>
          Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
        modules: ({ legalEntityId, moduleIds, principalId, tenantId }) => {
          const inScope = rows.some(
            (row) =>
              row.actingPrincipalId === principalId && row.legalEntityId === legalEntityId && row.tenantId === tenantId,
          );
          return Effect.gen(function* authorityRead() {
            authorityReads.push(principalId);
            activeReads += 1;
            maxReads = Math.max(maxReads, activeReads);
            yield* Effect.yieldNow;
            activeReads -= 1;
            const decisions: ContextAccessResult[] = [];
            for (const key of moduleIds) {
              decisions.push({ decision: inScope && readableModules.includes(key) ? 'allowed' : 'denied', key });
            }
            return decisions;
          });
        },
        resources: () => Effect.die('Unexpected resource check'),
        tenants: () => Effect.die('Unexpected tenant check'),
      }),
      Layer.succeed(ActionAuthority, {
        checkActionAuthorities: () => Effect.succeed([]),
        checkActionProposalPermission: () => Effect.die('Unexpected single Action check'),
      }),
      Layer.succeed(OAuthConnectionCompanies, {
        names: (_tenantId, ids) => Effect.succeed(new Map(ids.map((id) => [id, 'Company']))),
      }),
      Layer.succeed(OAuthCredentials, {
        loadRefresh: () => Effect.die('Unexpected refresh lookup'),
        loadUserAccount: () => Effect.succeed(Option.some({ banned: false, emailVerified: true, name: 'Person' })),
        revokeFamily: () => Effect.die('Unexpected refresh revocation'),
      }),
      Layer.succeed(OAuthFlow, {
        deleteGrantTokens: () =>
          Effect.sync(() => {
            events.push('tokens-deleted');
          }),
        findClient: () => Effect.die('Unexpected client lookup'),
        verifyQuery: () => Effect.die('Unexpected query verification'),
      }),
      Layer.succeed(OAuthAuthenticationAudit, {
        record: () =>
          Effect.sync(() => {
            events.push('audit');
          }).pipe(Effect.andThen(options.auditFails === true ? Effect.fail(auditDenied) : Effect.void)),
      }),
    );
    const grants = yield* GrantAdmin.pipe(
      Effect.provide(GrantAdminLive(options.request ?? request).pipe(Layer.provide(dependencies))),
    );
    return { authorityReads, dependencies, events, grants, maxReads: () => maxReads, noteRequests, selections };
  });

it.effect(
  'the native Layer captures real selection and Read producers without running operations during construction',
  () =>
    Effect.gen(function* nativeOwnership() {
      const test = yield* fixture({ rows: [revoked] });
      expect(test.selections).toEqual([]);
      expect(test.noteRequests).toEqual([]);
      const result = yield* test.grants
        .list(filter)
        .pipe(
          Effect.provideService(
            OAuthGrantRegistry,
            grantRegistryFixture({ loadPrincipals: () => Effect.succeed(new Map()) }),
          ),
          Effect.provideService(ReadRuntime, { runRead: () => Effect.die('Must use the captured Read producer') }),
          Effect.provide(test.dependencies),
        );
      expect(result).toHaveLength(1);
      expect(
        result[0] === undefined ? result[0] : Schema.encodeSync(AdminConnectionSummarySchema)(result[0]),
      ).toMatchObject({
        client: { logoUri: null },
        createdAt: '2026-10-25T10:00:00.000Z',
        delegatedBy: null,
        lastUsedAt: null,
      });
      expect(test.selections).toEqual([filter]);
      expect(test.noteRequests).toHaveLength(1);
    }),
);

it.effect(
  'unknown and draft grants are None; every canonical management status is retained and drafts are omitted',
  () =>
    Effect.gen(function* canonicalStatuses() {
      const draft = { ...retainedGrant, grantId: AgentAccessGrantIdSchema.make('draft'), status: 'draft' as const };
      const rows = CONNECTION_STATUSES.map((status, index) => ({
        ...retainedGrant,
        grantId: `00000000-0000-4000-8000-00000000001${index}`,
        status,
      }));
      const test = yield* fixture({ rows: [...rows, draft] });
      const unknown = yield* test.grants.get('missing');
      const hidden = yield* test.grants.get(draft.grantId);
      const listed = yield* test.grants.list(filter);
      expect(Option.isNone(unknown)).toBe(true);
      expect(Option.isNone(hidden)).toBe(true);
      expect(listed.map((row) => row.status)).toEqual(CONNECTION_STATUSES);
      expect(test.noteRequests).toHaveLength(1);
    }),
);

it.effect('retains granted authority separately from effective modules and fresh live limits', () =>
  Effect.gen(function* grantedAndLive() {
    const requested: OAuthGrantRecord = {
      ...retainedGrant,
      modules: yield* Schema.decodeUnknownEffect(OAuthGrantModulesSchema)([
        { access: 'write', moduleId: AgentModuleKeySchema.make('work.tasks') },
      ]),
    };
    const test = yield* fixture({ rows: [requested] });
    const result = yield* test.grants.get(requested.grantId);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.granted).toEqual({ modules: requested.modules, writePolicy: 'direct' });
      expect(result.value.modules).toEqual([]);
      expect(result.value.limits).toEqual({ maxWritePolicy: 'direct', modules: [] });
      expect(result.value.allModules).toBe(false);
    }
    expect(test.noteRequests).toEqual([]);
  }),
);

it.effect(
  'passes the untouched original principal and full OperationalScopeRequest to the governed retained-owner read',
  () =>
    Effect.gen(function* originalIngress() {
      const test = yield* fixture({ rows: [revoked] });
      const result = yield* test.grants.get(revoked.grantId);
      expect(Option.isSome(result) && Option.getOrNull(result.value.revokeNote)).toBe('Reason');
      expect(test.noteRequests).toMatchObject([{ input: { grantIds: [revoked.grantId] }, principal, transport }]);
      const [observed] = test.noteRequests;
      expect(Predicate.hasProperty(observed, 'principal') && observed.principal).toBe(principal);
      expect(Predicate.hasProperty(observed, 'transport') && observed.transport).toBe(transport);
    }),
);

it.effect('rejects cross-company and cross-tenant revoked rows before the note read', () =>
  Effect.gen(function* exactCompanyNotes() {
    for (const row of [
      { ...revoked, legalEntityId: 'other-company' },
      { ...revoked, tenantId: 'other-tenant' },
    ]) {
      const test = yield* fixture({ rows: [row] });
      const failure = yield* test.grants.get(row.grantId).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'ConnectionsUnavailable')).toBe(true);
      expect(test.noteRequests).toEqual([]);
    }
  }),
);

it.effect('never turns a denied retained-owner audit read into an empty successful note set', () =>
  Effect.gen(function* noteFailure() {
    const test = yield* fixture({ notesFail: true, rows: [revoked] });
    const failure = yield* test.grants.get(revoked.grantId).pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'ConnectionsUnavailable')).toBe(true);
    // The public boundary retains the typed owner failure, including the governed Read cause.
    expect(failure).toMatchObject({ cause: { cause: noteDenied } });
  }),
);

it.effect('keeps request-bound native services isolated across companies and transport carriers', () =>
  Effect.gen(function* isolatedRequests() {
    const otherRequest: GrantAdminRequest = {
      principal: { ...principal, legalEntityId: 'other-company' },
      transport: { correlationId: 'other-request', traceId: 'other-trace' },
    };
    const first = yield* fixture({ rows: [revoked] });
    const second = yield* fixture({ request: otherRequest, rows: [{ ...revoked, legalEntityId: 'other-company' }] });
    yield* second.grants.get(revoked.grantId);
    yield* first.grants.get(revoked.grantId);
    expect(first.noteRequests).toMatchObject([{ principal, transport }]);
    expect(second.noteRequests).toMatchObject([otherRequest]);
  }),
);

it.effect('retains native authority, catalog, credentials and mutation owners from construction', () =>
  Effect.gen(function* retainedMethodDependencies() {
    const first = yield* fixture({ readableModules: ['work.tasks'] });
    const second = yield* fixture({ auditFails: true });
    const found = yield* first.grants.get(retainedGrant.grantId).pipe(Effect.provide(second.dependencies));
    expect(Option.isSome(found) && found.value.modules.map((module) => module.moduleId)).toEqual(['work.tasks']);
    yield* first.grants
      .update({
        actorPrincipalId: principal.principalId,
        grantId: retainedGrant.grantId,
        modules: [{ access: 'read', moduleId: AgentModuleKeySchema.make('work.tasks') }],
        writePolicy: 'read_only',
      })
      .pipe(Effect.provide(second.dependencies));
    yield* first.grants
      .revoke({
        actorPrincipalId: principal.principalId,
        grantId: retainedGrant.grantId,
        reasonCode: 'admin',
        reasonText: 'Removed by administrator',
      })
      .pipe(Effect.provide(second.dependencies));
    expect(first.events).toEqual([
      'access-updated',
      'audit',
      'grant-disabled',
      'binding-disabled',
      'tokens-deleted',
      'audit',
    ]);
    expect(second.events).toEqual([]);
    expect(second.authorityReads).toEqual([]);
  }),
);

it.effect('deduplicates authority by acting principal and company and bounds independent reads to two', () =>
  Effect.gen(function* boundedReads() {
    const rows: readonly OAuthGrantRecord[] = ['a', 'b', 'c', 'a'].map((actingPrincipalId, index) => ({
      ...retainedGrant,
      actingPrincipalId,
      grantId: `grant-${index}`,
      status: 'superseded',
    }));
    const test = yield* fixture({ rows });
    const result = yield* test.grants.list(filter);
    expect(result).toHaveLength(4);
    expect(test.authorityReads.toSorted()).toEqual(['a', 'b', 'c']);
    expect(test.maxReads()).toBe(2);
  }),
);

it.effect('rejects empty, unoffered and write requests beyond the native read authority before mutation', () =>
  Effect.gen(function* nativeModuleCeiling() {
    const test = yield* fixture({ readableModules: ['work.tasks'] });
    const deniedModules: readonly (readonly AgentModuleGrant[])[] = [
      [],
      [{ access: 'read', moduleId: AgentModuleKeySchema.make('other.module') }],
      [{ access: 'write', moduleId: AgentModuleKeySchema.make('work.tasks') }],
    ];
    for (const modules of deniedModules) {
      const failure = yield* test.grants
        .update({
          actorPrincipalId: principal.principalId,
          grantId: retainedGrant.grantId,
          modules,
          writePolicy: 'read_only',
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ cause: { _tag: 'ConnectionForbidden', code: 'modules_forbidden' } });
      expect(test.events).toEqual([]);
    }
  }),
);

it.effect('encodes both module snapshots before the native update can mutate the grant', () =>
  Effect.gen(function* encodingBeforeMutation() {
    const modules = yield* Schema.decodeUnknownEffect(OAuthGrantModulesSchema.members[1])([
      { access: 'read', moduleId: AgentModuleKeySchema.make('work.tasks') },
    ]);
    const row: OAuthGrantRecord = {
      ...retainedGrant,
      modules: Array.from({ length: 101 }, () => modules).flat(),
    };
    const test = yield* fixture({ readableModules: ['work.tasks'], rows: [row] });
    const failure = yield* test.grants
      .update({
        actorPrincipalId: principal.principalId,
        grantId: row.grantId,
        modules: modules.map((module) => ({ ...module, moduleId: AgentModuleKeySchema.make(module.moduleId) })),
        writePolicy: 'read_only',
      })
      .pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'ConnectionsUnavailable')).toBe(true);
    expect(failure).toMatchObject({ cause: { cause: { _tag: 'SchemaError' } } });
    expect(test.events).toEqual([]);
  }),
);

it.effect('propagates native update audit failure after mutation instead of returning success', () =>
  Effect.gen(function* updateAuditFailure() {
    const test = yield* fixture({ auditFails: true, readableModules: ['work.tasks'] });
    const failure = yield* test.grants
      .update({
        actorPrincipalId: principal.principalId,
        grantId: retainedGrant.grantId,
        modules: [{ access: 'read', moduleId: AgentModuleKeySchema.make('work.tasks') }],
        writePolicy: 'read_only',
      })
      .pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'ConnectionsUnavailable')).toBe(true);
    expect(failure).toMatchObject({ cause: { cause: auditDenied } });
    expect(test.events).toEqual(['access-updated', 'audit']);
  }),
);

it.effect('preserves revoke disablement, credential cleanup and failing native audit ordering', () =>
  Effect.gen(function* revokeAuditFailure() {
    const test = yield* fixture({ auditFails: true });
    const failure = yield* test.grants
      .revoke({
        actorPrincipalId: principal.principalId,
        grantId: retainedGrant.grantId,
        reasonCode: 'admin',
        reasonText: 'Removed by administrator',
      })
      .pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'ConnectionsUnavailable')).toBe(true);
    expect(failure).toMatchObject({ cause: { cause: auditDenied } });
    expect(test.events).toEqual(['grant-disabled', 'binding-disabled', 'tokens-deleted', 'audit']);
  }),
);
