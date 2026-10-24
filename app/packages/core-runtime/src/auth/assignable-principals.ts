import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { Array as Arr, Context, Effect, Option } from 'effect';
import { AssigneeIneligible } from './assignee-ineligible.ts';
import { AssignablePrincipalsUnavailable } from './assignable-principals-unavailable.ts';

import { CoreDatabase } from '../db/client.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import { principalCompanyMemberships, principals } from '../db/schema.ts';
import type { PrincipalStatus } from '../db/schema.ts';
import type { CompanyMembershipStatus } from '../permissions/company-membership.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import {
  acquireSpiceDbClientResource,
  createSpiceDbPermissionClient,
  fullyConsistent,
  SPICEDB_CHECK_TIMEOUT_MS,
} from '../permissions/client.ts';
import type { SpiceDbPermissionClient } from '../permissions/client.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import { toContextPermissionAccessObjectId, toModuleAccessObjectId } from '../permissions/context-access.ts';
import type { ContextPermissionAccessTarget } from '../permissions/context-access.ts';
import type { PrincipalRef } from '../permissions/principal-ref.ts';

export { AssigneeIneligible } from './assignee-ineligible.ts';
export { AssignablePrincipalsUnavailable } from './assignable-principals-unavailable.ts';

export interface AssignmentCompanyScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

export interface AssignablePrincipal {
  readonly displayName: string;
  readonly principalRef: PrincipalRef;
}

export interface AssignmentDirectoryMember extends AssignablePrincipal {
  readonly membershipStatus: CompanyMembershipStatus;
  readonly principalStatus: PrincipalStatus;
}

/** Core-owned SQL snapshot. Kind and affiliation are deliberately absent: neither grants rights. */
export interface AssignablePrincipalDirectory extends AssignmentCompanyScope {
  readonly members: readonly AssignmentDirectoryMember[];
}

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new AssignablePrincipalsUnavailable({ reason: 'Assignment authorization is unavailable' }),
    'cause',
    { enumerable: false, value: cause },
  );
const ineligible = () => new AssigneeIneligible({ reason: 'The target is not an eligible company principal' });

/** Runs inside the caller's trusted scoped transaction; performs no remote I/O. */
export const loadAssignablePrincipalDirectory = Effect.fn('Core.loadAssignablePrincipalDirectory')(
  function* loadAssignablePrincipalDirectory(transaction: ScopedTransactionExecutor, scope: AssignmentCompanyScope) {
    if (transaction.scope.tenantId !== scope.tenantId || transaction.scope.legalEntityId !== scope.legalEntityId) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .select({
        displayName: principals.displayName,
        membershipStatus: principalCompanyMemberships.status,
        principalId: principals.principalId,
        principalStatus: principals.status,
        tenantId: principals.tenantId,
      })
      .from(principalCompanyMemberships)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, principalCompanyMemberships.tenantId),
          eq(principals.principalId, principalCompanyMemberships.principalId),
        ),
      )
      .where(
        and(
          eq(principalCompanyMemberships.tenantId, scope.tenantId),
          eq(principalCompanyMemberships.legalEntityId, scope.legalEntityId),
        ),
      )
      .orderBy(principals.displayName, principals.principalId)
      .pipe(Effect.mapError(unavailable));
    return {
      ...scope,
      members: rows.map(({ displayName, membershipStatus, principalId, principalStatus, tenantId }) => ({
        displayName,
        membershipStatus,
        principalRef: { principalId, tenantId },
        principalStatus,
      })),
    } satisfies AssignablePrincipalDirectory;
  },
);

/** Short Core-owned preflight transaction. The owner's callback receives read-only scoped SQL. */
export const loadAssignmentPreflightSnapshot = Effect.fn('Core.loadAssignmentPreflightSnapshot')(
  function* assignmentPreflightSnapshot<A, E>(
    scope: OperationalScope & AssignmentCompanyScope,
    loadOwner: (transaction: Pick<ScopedTransactionExecutor, 'select'>) => Effect.Effect<A, E>,
  ) {
    const database = yield* Effect.serviceOption(CoreDatabase);
    if (Option.isNone(database)) {
      return yield* unavailable();
    }
    return yield* database.value.executor
      .transaction(
        Effect.fn('Core.assignmentPreflightTransaction')(function* preflight(transaction) {
          const scoped = yield* installOperationalScope(transaction, scope).pipe(Effect.mapError(unavailable));
          return yield* Effect.all(
            {
              directory: loadAssignablePrincipalDirectory(scoped, scope),
              value: loadOwner({ select: scoped.select }),
            },
            { concurrency: 1 },
          );
        }),
      )
      .pipe(Effect.mapError(unavailable));
  },
);

/** Recheck this inside the write transaction after a pre-transaction permission check. */
export const activeAssignmentMember = (
  directory: AssignablePrincipalDirectory,
  principal: PrincipalRef,
): Effect.Effect<AssignablePrincipal, AssigneeIneligible> => {
  const member = directory.members.find(
    ({ principalRef }) =>
      principalRef.tenantId === directory.tenantId &&
      principalRef.tenantId === principal.tenantId &&
      principalRef.principalId === principal.principalId,
  );
  return member?.membershipStatus === 'active' && member.principalStatus === 'active'
    ? Effect.succeed({ displayName: member.displayName, principalRef: member.principalRef })
    : Effect.fail(ineligible());
};

const resourceFor = (directory: AssignmentCompanyScope, requiredPermission: ContextPermissionAccessTarget) => {
  // Core treats module.access as the module entrypoint alias, not a named context permission.
  const moduleAccess = requiredPermission.permission === 'module.access';
  const objectId = moduleAccess
    ? toModuleAccessObjectId(directory.tenantId, directory.legalEntityId, requiredPermission.moduleId)
    : toContextPermissionAccessObjectId(directory.tenantId, directory.legalEntityId, requiredPermission);
  return objectId === undefined
    ? undefined
    : v1.ObjectReference.create({ objectId, objectType: moduleAccess ? 'module_access' : 'context_permission' });
};
const subjectFor = (principalId: string) =>
  v1.SubjectReference.create({ object: v1.ObjectReference.create({ objectId: principalId, objectType: 'principal' }) });
const isActive = (directory: AssignablePrincipalDirectory, member: AssignmentDirectoryMember) =>
  member.principalRef.tenantId === directory.tenantId &&
  member.principalStatus === 'active' &&
  member.membershipStatus === 'active';
const batchSize = 250;

const checkAssignmentPage = Effect.fn('Core.checkAssignmentPage')(function* checkAssignmentPage(
  client: SpiceDbPermissionClient,
  resource: v1.ObjectReference,
  page: readonly AssignmentDirectoryMember[],
) {
  const request = v1.CheckBulkPermissionsRequest.create({
    consistency: fullyConsistent,
    items: page.map(({ principalRef }) => ({
      permission: 'access',
      resource,
      subject: subjectFor(principalRef.principalId),
    })),
  });
  const response = yield* client.checkBulkPermissions(request).pipe(Effect.mapError(unavailable));
  const expected = new Set(page.map(({ principalRef }) => principalRef.principalId));
  const allowed = new Set<string>();
  if (response.pairs.length !== expected.size) {
    return yield* unavailable();
  }
  yield* Effect.forEach(
    response.pairs,
    Effect.fn('Core.assignmentPermissionPair')(function* assignmentPermissionPair(pair) {
      const item = pair.request;
      const id = item?.subject?.object?.objectId;
      if (
        id === undefined ||
        !expected.delete(id) ||
        item?.subject?.object?.objectType !== 'principal' ||
        item.subject.optionalRelation !== '' ||
        item.permission !== 'access' ||
        item.resource?.objectId !== resource.objectId ||
        item.resource.objectType !== resource.objectType ||
        pair.response.oneofKind !== 'item'
      ) {
        return yield* unavailable();
      }
      const { permissionship } = pair.response.item;
      if (permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION) {
        allowed.add(id);
      } else if (permissionship !== v1.CheckPermissionResponse_Permissionship.NO_PERMISSION) {
        return yield* unavailable();
      }
      return id;
    }),
    { concurrency: 1 },
  );
  return page.flatMap(({ displayName, principalRef }) =>
    allowed.has(principalRef.principalId) ? [{ displayName, principalRef }] : [],
  );
});

/** Native SpiceDB adapter. Call after SQL commits; the transport enforces that boundary. */
export const makeAssignablePrincipals = (client: SpiceDbPermissionClient) => ({
  read: Effect.fn('Core.readAssignablePrincipals')(function* read(
    directory: AssignablePrincipalDirectory,
    requiredPermission: ContextPermissionAccessTarget,
  ) {
    const resource = resourceFor(directory, requiredPermission);
    if (resource === undefined) {
      return yield* unavailable();
    }
    const members = directory.members.filter((member) => isActive(directory, member));
    const pages = yield* Effect.forEach(
      Arr.chunksOf(members, batchSize),
      (page) => checkAssignmentPage(client, resource, page),
      { concurrency: 1 },
    );
    return pages.flat();
  }),
  resolveAssignee: Effect.fn('Core.resolveAssignee')(function* resolveAssignee(
    directory: AssignablePrincipalDirectory,
    principal: PrincipalRef,
    requiredPermission: ContextPermissionAccessTarget,
  ) {
    const member = yield* activeAssignmentMember(directory, principal);
    const resource = resourceFor(directory, requiredPermission);
    if (resource === undefined) {
      return yield* unavailable();
    }
    const response = yield* client
      .checkPermission(
        v1.CheckPermissionRequest.create({
          consistency: fullyConsistent,
          permission: 'access',
          resource,
          subject: subjectFor(principal.principalId),
        }),
      )
      .pipe(Effect.mapError(unavailable));
    if (response.permissionship === v1.CheckPermissionResponse_Permissionship.NO_PERMISSION) {
      return yield* ineligible();
    }
    if (response.permissionship !== v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION) {
      return yield* unavailable();
    }
    return member;
  }),
});

export class AssignablePrincipals extends Context.Service<
  AssignablePrincipals,
  ReturnType<typeof makeAssignablePrincipals>
>()('@app/core-runtime/auth/assignable-principals/AssignablePrincipals') {}

const withClient = <A, E>(run: (service: ReturnType<typeof makeAssignablePrincipals>) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* assignmentClient() {
      const injected = yield* Effect.serviceOption(AssignablePrincipals);
      if (Option.isSome(injected)) {
        return yield* run(injected.value);
      }
      const config = yield* loadSpiceDbConfig().pipe(Effect.mapError(unavailable));
      const client = yield* acquireSpiceDbClientResource(
        () => createSpiceDbPermissionClient(config, SPICEDB_CHECK_TIMEOUT_MS),
        unavailable,
      );
      return yield* run(makeAssignablePrincipals(client));
    }),
  );

export const readAssignablePrincipals = (
  directory: AssignablePrincipalDirectory,
  requiredPermission: ContextPermissionAccessTarget,
) => withClient((service) => service.read(directory, requiredPermission));

export const resolveAssignee = (
  directory: AssignablePrincipalDirectory,
  principal: PrincipalRef,
  requiredPermission: ContextPermissionAccessTarget,
) => withClient((service) => service.resolveAssignee(directory, principal, requiredPermission));
