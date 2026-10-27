import { v1 } from '@authzed/authzed-node';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { makeTestDatabase } from '../support/database.ts';
import {
  activeAssignmentMember,
  AssigneeIneligible,
  AssignablePrincipalsUnavailable,
  loadAssignablePrincipalDirectory,
  makeAssignablePrincipals,
} from '../../src/auth/assignable-principals.ts';
import type { AssignablePrincipalDirectory, AssignmentDirectoryMember } from '../../src/auth/assignable-principals.ts';
import { spiceDbPermissionClientError } from '../../src/permissions/client.ts';
import type { SpiceDbPermissionClient } from '../../src/permissions/client.ts';
import { toContextPermissionAccessObjectId, toModuleAccessObjectId } from '../../src/permissions/context-access.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const permission = { moduleId: 'work.tasks', permission: 'module.access' };
const member = (id: number, changes: Partial<AssignmentDirectoryMember> = {}): AssignmentDirectoryMember => ({
  displayName: `Principal ${id}`,
  membershipStatus: 'active',
  principalRef: { principalId: `30000000-0000-4000-8000-${String(id).padStart(12, '0')}`, tenantId },
  principalStatus: 'active',
  ...changes,
});
const directory = (members: readonly AssignmentDirectoryMember[]): AssignablePrincipalDirectory => ({
  legalEntityId,
  members,
  tenantId,
});
const selectedCompany = { legalEntityId };
const operationalScope = (company: { readonly legalEntityId?: string } = selectedCompany): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:assignment-directory',
    authMethod: 'session',
    principalId: member(1).principalRef.principalId,
    tenantId,
    ...company,
  }),
  correlationId: 'assignment-directory',
});

const loadDirectory = (
  installed: OperationalScope,
  requested: OperationalScope,
  rows: Effect.Effect<readonly object[], SqlError> = Effect.succeed([]),
) =>
  Effect.gen(function* scriptedDirectory() {
    const queries: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
    const database = yield* makeTestDatabase((sql, params) => {
      if (sql.includes('principal_company_memberships')) {
        queries.push({ params, sql });
        return rows;
      }
      return Effect.succeed([
        { legal_entity_id: installed.legalEntityId ?? '', role: 'ontos_runtime', tenant_id: installed.tenantId },
      ]);
    });
    const result = yield* Effect.result(
      database.transaction((transaction) =>
        installOperationalScope(transaction, installed, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
          Effect.flatMap((scoped) => loadAssignablePrincipalDirectory(scoped, requested)),
        ),
      ),
    );
    return { queries, result };
  });

for (const [name, installed, requested] of [
  ['no selected company', operationalScope({}), operationalScope({})],
  ['no selected company against a company snapshot', operationalScope(), operationalScope({})],
  ['a tenant mismatch', { ...operationalScope(), tenantId: legalEntityId }, operationalScope()],
  ['a company mismatch', operationalScope({ legalEntityId: tenantId }), operationalScope()],
  ['a missing installed company', operationalScope({}), operationalScope()],
] as const) {
  it.effect(`rejects ${name} before querying the assignment directory`, () =>
    Effect.gen(function* rejectsScope() {
      const { queries, result } = yield* loadDirectory(installed, requested);
      expect(Result.isFailure(result) && Schema.is(AssignablePrincipalsUnavailable)(result.failure)).toBe(true);
      expect(queries).toEqual([]);
    }),
  );
}

it.effect('loads the same-snapshot directory without exposing operational scope metadata', () =>
  Effect.gen(function* loadsDirectory() {
    const target = member(2, { membershipStatus: 'departed', principalStatus: 'disabled' });
    const { queries, result } = yield* loadDirectory(
      operationalScope(),
      operationalScope(),
      Effect.succeed([
        {
          displayName: target.displayName,
          membershipStatus: target.membershipStatus,
          principalId: target.principalRef.principalId,
          principalStatus: target.principalStatus,
          tenantId,
        },
      ]),
    );
    expect(Result.isSuccess(result) && result.success).toEqual(directory([target]));
    expect(queries).toHaveLength(1);
    expect(queries[0]?.params).toEqual([tenantId, legalEntityId]);
    expect(queries[0]?.sql).toContain('"principal_company_memberships"."tenant_id" = $1');
    expect(queries[0]?.sql).toContain('"principal_company_memberships"."legal_entity_id" = $2');
    expect(queries[0]?.sql).toContain(
      'order by "core"."principals"."display_name", "core"."principals"."principal_id"',
    );
  }),
);

it.effect('keeps assignment directory SQL failures unavailable instead of returning an empty directory', () =>
  Effect.gen(function* directoryUnavailable() {
    const { queries, result } = yield* loadDirectory(
      operationalScope(),
      operationalScope(),
      Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'controlled outage' }) })),
    );
    expect(Result.isFailure(result) && Schema.is(AssignablePrincipalsUnavailable)(result.failure)).toBe(true);
    expect(queries).toHaveLength(1);
  }),
);

const has = v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
const none = v1.CheckPermissionResponse_Permissionship.NO_PERMISSION;
const response = (
  request: v1.CheckBulkPermissionsRequest,
  decisions: readonly v1.CheckPermissionResponse_Permissionship[],
) =>
  v1.CheckBulkPermissionsResponse.create({
    pairs: request.items.map((item, index) => ({
      request: item,
      response: { item: { permissionship: decisions[index] ?? has }, oneofKind: 'item' },
    })),
  });
const client = (overrides: Partial<SpiceDbPermissionClient> = {}): SpiceDbPermissionClient => ({
  checkBulkPermissions: (request) => Effect.succeed(response(request, [])),
  checkPermission: () => Effect.succeed(v1.CheckPermissionResponse.create({ permissionship: has })),
  close: () => {},
  ...overrides,
});

it.effect('offers humans and agents by active company membership and exact permission, never kind or affiliation', () =>
  Effect.gen(function* eligiblePrincipals() {
    const human = member(1, { displayName: 'Human' });
    const agent = member(2, { displayName: 'Agent' });
    const denied = member(3);
    const inactive = member(4, { principalStatus: 'disabled' });
    const departed = member(5, { membershipStatus: 'departed' });
    const invited = member(6, { membershipStatus: 'invited' });
    const otherTenant = member(7, { principalRef: { ...member(7).principalRef, tenantId: legalEntityId } });
    const calls: v1.CheckBulkPermissionsRequest[] = [];
    const service = makeAssignablePrincipals(
      client({
        checkBulkPermissions: (request) =>
          Effect.sync(() => {
            calls.push(request);
            return response(request, [has, has, none]);
          }),
      }),
    );
    expect(
      yield* service.read(directory([human, agent, denied, inactive, departed, invited, otherTenant]), permission),
    ).toEqual([human, agent].map(({ displayName, principalRef }) => ({ displayName, principalRef })));
    expect(calls).toHaveLength(1);
    const [request] = calls;
    expect(request?.consistency?.requirement.oneofKind).toBe('fullyConsistent');
    expect(request?.items.map((item) => item.subject?.object?.objectId)).toEqual(
      [human, agent, denied].map(({ principalRef }) => principalRef.principalId),
    );
    expect(
      request?.items.every(
        (item) =>
          item.permission === 'access' &&
          item.resource?.objectType === 'module_access' &&
          item.resource.objectId === toModuleAccessObjectId(tenantId, legalEntityId, permission.moduleId),
      ),
    ).toBe(true);
  }),
);

it.effect('preserves named context permission targets instead of treating them as module entrypoints', () =>
  Effect.gen(function* namedPermission() {
    const calls: v1.CheckBulkPermissionsRequest[] = [];
    const target = { moduleId: 'work.tasks', permission: 'read_all' };
    const service = makeAssignablePrincipals(
      client({
        checkBulkPermissions: (request) =>
          Effect.sync(() => {
            calls.push(request);
            return response(request, []);
          }),
      }),
    );
    expect(yield* service.read(directory([member(1)]), target)).toHaveLength(1);
    expect(calls[0]?.items[0]?.resource?.objectType).toBe('context_permission');
    expect(calls[0]?.items[0]?.resource?.objectId).toBe(
      toContextPermissionAccessObjectId(tenantId, legalEntityId, target),
    );
  }),
);

it.effect('pages native bulk checks with a bounded batch size', () =>
  Effect.gen(function* boundedPages() {
    const sizes: number[] = [];
    const service = makeAssignablePrincipals(
      client({
        checkBulkPermissions: (request) =>
          Effect.sync(() => {
            sizes.push(request.items.length);
            return response(request, []);
          }),
      }),
    );
    expect(
      yield* service.read(directory(Array.from({ length: 503 }, (_, index) => member(index + 1))), permission),
    ).toHaveLength(503);
    expect(sizes).toEqual([250, 250, 3]);
  }),
);

it.effect('correlates reversed native responses by full target and subject rather than position', () =>
  Effect.gen(function* correlated() {
    const service = makeAssignablePrincipals(
      client({
        checkBulkPermissions: (request) => {
          const result = response(request, [has, none]);
          result.pairs.reverse();
          return Effect.succeed(result);
        },
      }),
    );
    expect(yield* service.read(directory([member(1), member(2)]), permission)).toEqual([
      { displayName: member(1).displayName, principalRef: member(1).principalRef },
    ]);
  }),
);

const firstPair = (result: v1.CheckBulkPermissionsResponse) => {
  const [pair] = result.pairs;
  if (pair === undefined) {
    throw new TypeError('The fixture must contain a native bulk pair');
  }
  return pair;
};

it.effect('fails closed on missing, duplicate, wrong-target, and conditional bulk results', () =>
  Effect.gen(function* malformed() {
    const mutations = [
      (result: v1.CheckBulkPermissionsResponse) => {
        result.pairs.pop();
      },
      (result: v1.CheckBulkPermissionsResponse) => {
        result.pairs.splice(1, 1, firstPair(result));
      },
      (result: v1.CheckBulkPermissionsResponse) => {
        const { request } = firstPair(result);
        if (request === undefined) {
          throw new TypeError('The native bulk fixture must contain its request');
        }
        request.permission = 'write_all';
      },
      (result: v1.CheckBulkPermissionsResponse) => {
        firstPair(result).response = {
          item: v1.CheckBulkPermissionsResponseItem.create({
            permissionship: v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION,
          }),
          oneofKind: 'item',
        };
      },
    ];
    for (const mutate of mutations) {
      const service = makeAssignablePrincipals(
        client({
          checkBulkPermissions: (request) => {
            const result = response(request, []);
            mutate(result);
            return Effect.succeed(result);
          },
        }),
      );
      const result = yield* Effect.result(service.read(directory([member(1), member(2)]), permission));
      expect(Result.isFailure(result) && Schema.is(AssignablePrincipalsUnavailable)(result.failure)).toBe(true);
    }
  }),
);

it.effect('a native transport failure is unavailable, not an empty candidate list', () =>
  Effect.gen(function* unavailable() {
    const service = makeAssignablePrincipals(
      client({
        checkBulkPermissions: () => Effect.fail(spiceDbPermissionClientError()),
      }),
    );
    const result = yield* Effect.result(service.read(directory([member(1)]), permission));
    expect(Result.isFailure(result) && Schema.is(AssignablePrincipalsUnavailable)(result.failure)).toBe(true);
  }),
);

it.effect('resolves a target with one fresh exact native permission check', () =>
  Effect.gen(function* targetCheck() {
    const calls: v1.CheckPermissionRequest[] = [];
    const target = member(1);
    const service = makeAssignablePrincipals(
      client({
        checkPermission: (request) =>
          Effect.sync(() => {
            calls.push(request);
            return v1.CheckPermissionResponse.create({ permissionship: has });
          }),
      }),
    );
    expect(yield* service.resolveAssignee(directory([target]), target.principalRef, permission)).toEqual({
      displayName: target.displayName,
      principalRef: target.principalRef,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.resource?.objectType).toBe('module_access');
    expect(calls[0]?.resource?.objectId).toBe(toModuleAccessObjectId(tenantId, legalEntityId, permission.moduleId));
    expect(calls[0]?.subject?.object?.objectId).toBe(target.principalRef.principalId);
    expect(calls[0]?.consistency?.requirement.oneofKind).toBe('fullyConsistent');
  }),
);

it.effect('rejects denied, inactive, departed, missing, and cross-tenant assignment targets', () =>
  Effect.gen(function* rejectsTargets() {
    const active = member(1);
    const service = makeAssignablePrincipals(
      client({
        checkPermission: () => Effect.succeed(v1.CheckPermissionResponse.create({ permissionship: none })),
      }),
    );
    const targets = [
      [directory([active]), active.principalRef],
      [directory([member(1, { principalStatus: 'archived' })]), active.principalRef],
      [directory([member(1, { membershipStatus: 'departed' })]), active.principalRef],
      [directory([]), active.principalRef],
      [directory([active]), { ...active.principalRef, tenantId: legalEntityId }],
    ] as const;
    for (const [snapshot, principal] of targets) {
      const result = yield* Effect.result(service.resolveAssignee(snapshot, principal, permission));
      expect(Result.isFailure(result) && Schema.is(AssigneeIneligible)(result.failure)).toBe(true);
    }
  }),
);

it.effect('the commit-time membership recheck rejects a departure after preflight', () =>
  Effect.gen(function* departedSincePreflight() {
    const target = member(1);
    const service = makeAssignablePrincipals(client());
    yield* service.resolveAssignee(directory([target]), target.principalRef, permission);
    const result = yield* Effect.result(
      activeAssignmentMember(directory([{ ...target, membershipStatus: 'departed' }]), target.principalRef),
    );
    expect(Result.isFailure(result) && Schema.is(AssigneeIneligible)(result.failure)).toBe(true);
  }),
);
