import { Context, Crypto, DateTime, Effect, FileSystem, Layer, Match, Path, Redacted, Schema } from 'effect';

import { bootstrapScopesOf } from '../access/bootstrap/persistence.ts';
import { compileFullAccessRole } from '../access/bootstrap/full-access-role.ts';
import { AccessCatalogModulesSchema } from '../access/catalog/module-schema.ts';
import { AccessChangesStoreLive } from '../access/changes/persistence/drizzle-store.ts';
import { AccessChangesStore } from '../access/changes/persistence/store.ts';
import { makeAccessProjectionCompiler, makeAccessProjectionTransport } from '../access/compiler/spice-db-compiler.ts';
import {
  AssignmentIncarnationIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../access/ids.ts';
import type { AccessScopeId, AssignmentIncarnationId, PrincipalId, TenantId } from '../access/ids.ts';
import type { Assignment, Holder } from '../access/model.ts';
import {
  AccessCatalogSnapshotWriter,
  AccessCatalogSnapshotWriterLive,
} from '../access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../access/intent/memberships.ts';
import { AccessPeopleStore, AccessPeopleStoreLive } from '../access/intent/people-store.ts';
import { AccessProjectionCompiler } from '../access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../access/lifecycle/persistence/journal-store.ts';
import { CoreDatabase, makeCoreDatabase } from '../db/client.ts';
import { DatabaseIdentityEnrollmentContext, defineDatabaseIdentityEnrollment } from '../db/database-identities.ts';
import { parseDatabaseConfig } from '../db/config.ts';
import { stageScopeOf } from '../install/stage-context-bootstrap.ts';
import type { TestTenantAccessTarget } from './tenant-access.ts';

const catalogUrl = new URL('../../../../topology/authorization-catalog.json', import.meta.url);

const readCatalogModules = Effect.fn('TestTenantAccessRoles.catalogModules')(function* readCatalogModules() {
  const [filesystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  const { modules } = yield* path.fromFileUrl(catalogUrl).pipe(
    Effect.flatMap((catalogPath) => filesystem.readFileString(catalogPath)),
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ modules: AccessCatalogModulesSchema }))),
    ),
  );
  return modules;
});

/** One active assignment of the role in each scope, held by the principal. */
const assignmentWrites = (
  crypto: Crypto.Crypto,
  input: {
    readonly at: Date;
    readonly principalId: PrincipalId;
    readonly roleId: Assignment['roleId'];
    readonly roleRevisionId: Assignment['roleRevisionId'];
    readonly scopeIds: readonly AccessScopeId[];
    readonly tenantId: TenantId;
  },
) =>
  Effect.forEach(
    input.scopeIds,
    (scopeId) =>
      crypto.randomUUIDv4().pipe(
        Effect.map((incarnationId) => ({
          _tag: 'RecordAssignment' as const,
          assignment: {
            assignedAt: input.at,
            assignedBy: input.principalId,
            holder: { _tag: 'Principal' as const, principalId: input.principalId },
            incarnationId: AssignmentIncarnationIdSchema.make(incarnationId),
            roleId: input.roleId,
            roleRevisionId: input.roleRevisionId,
            scopeId,
            status: 'active' as const,
            tenantId: input.tenantId,
            validFrom: input.at,
          },
        })),
      ),
    { concurrency: 1 },
  );

const isHeldBy = (holder: Holder, principalId: PrincipalId) =>
  Match.value(holder).pipe(
    Match.tag('Principal', (principal) => principal.principalId === principalId),
    Match.orElse(() => false),
  );

/**
 * The Core writers a suite changes one principal's v2 access intent through after the Tenant is set up: the
 * people store and the single projection writer that reconciles the result, over one database and SpiceDB,
 * built into the caller's scope. The principal already holds its memberships in every scope.
 *
 * `capabilityRole` records a role of exactly the named capabilities and `roleWithout` one of every release
 * capability except the named ones; `grant` assigns either in every scope and `revoke` ends those assignments.
 * `endHeldRoles` ends every role the principal holds while its memberships (and an owner's structural
 * administration) stay. Each write is followed by one reconcile, so a decision changes only because the
 * access intent did.
 */
export const makeTestTenantRoleAccess = Effect.fn('TestTenantAccessRoles.make')(function* makeTestTenantRoleAccess(
  input: TestTenantAccessTarget & {
    readonly legalEntityIds: readonly [string, ...string[]];
    readonly principalId: string;
    readonly tenantId: string;
  },
) {
  const databaseConfiguration = yield* parseDatabaseConfig({
    DATABASE_URL: Redacted.value(input.adminConnectionString),
  });
  const database = Context.make(CoreDatabase, yield* makeCoreDatabase(databaseConfiguration));
  const transport = yield* Effect.acquireRelease(
    Effect.sync(() => makeAccessProjectionTransport(input.spiceDb)),
    (opened) => Effect.sync(() => opened.close()),
  );
  const platform = Context.add(
    Context.add(database, AccessProjectionCompiler, makeAccessProjectionCompiler(transport)),
    DatabaseIdentityEnrollmentContext,
    defineDatabaseIdentityEnrollment([]),
  );
  const stores = Context.merge(
    platform,
    yield* Layer.build(
      Layer.mergeAll(
        TenantIntentLoaderLive,
        AccessWriteJournalStoreLive,
        AccessChangesStoreLive,
        AccessMembershipStoreLive,
        AccessPeopleStoreLive,
      ),
    ).pipe(Effect.provideContext(platform)),
  );
  const writers = Context.merge(
    stores,
    yield* Layer.build(Layer.mergeAll(AccessCatalogSnapshotWriterLive, AccessProjectionWriterLive)).pipe(
      Effect.provideContext(stores),
    ),
  );
  const changes = Context.get(writers, AccessChangesStore);
  const people = Context.get(writers, AccessPeopleStore);
  const writer = Context.get(writers, AccessProjectionWriter);
  const tenantId = TenantIdSchema.make(input.tenantId);
  const principalId = PrincipalIdSchema.make(input.principalId);
  const modules = yield* readCatalogModules();
  const release = yield* Context.get(writers, AccessCatalogSnapshotWriter).ensureInitialRelease({
    installedModuleKeys: modules.map(({ moduleId }) => moduleId),
    modules,
  });
  const { cells: releaseCells } = yield* Effect.fromResult(compileFullAccessRole(release));
  const scopeIds = bootstrapScopesOf(
    tenantId,
    input.legalEntityIds.map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId)),
  ).map(({ scopeId }) => scopeId);
  const crypto = yield* Crypto.Crypto;
  const scope = yield* stageScopeOf({ principalId, tenantId });
  const reconcile = writer.reconcileTenant({ scope });

  const roleOf = Effect.fn('TestTenantAccessRoles.role')(function* roleOf(cells: typeof releaseCells) {
    const [roleUuid, roleRevisionUuid] = yield* Effect.all([crypto.randomUUIDv4(), crypto.randomUUIDv4()], {
      concurrency: 2,
    });
    const roleId = RoleIdSchema.make(roleUuid);
    const roleRevisionId = RoleRevisionIdSchema.make(roleRevisionUuid);
    const recordedAt = DateTime.toDateUtc(yield* DateTime.now);
    yield* changes.recordRole({
      revision: {
        catalogSnapshotId: release.id,
        cells,
        createdAt: recordedAt,
        createdBy: principalId,
        id: roleRevisionId,
        provenance: 'manual',
        revision: 1,
        roleId,
        tenantId,
      },
      role: { createdAt: recordedAt, createdBy: principalId, id: roleId, name: `Test role ${roleId}`, tenantId },
      scope,
    });
    let assigned: readonly AssignmentIncarnationId[] = [];
    const grant = Effect.gen(function* grantRole() {
      const writes = yield* assignmentWrites(crypto, {
        at: DateTime.toDateUtc(yield* DateTime.now),
        principalId,
        roleId,
        roleRevisionId,
        scopeIds,
        tenantId,
      });
      yield* people.applyPeopleChange(scope, { writes });
      assigned = writes.map(({ assignment }) => assignment.incarnationId);
      yield* reconcile;
    }).pipe(Effect.orDie);
    const revoke = Effect.gen(function* revokeRole() {
      const writes = assigned.map((incarnationId) => ({ _tag: 'EndAssignment' as const, incarnationId }));
      yield* people.applyPeopleChange(scope, { writes });
      assigned = [];
      yield* reconcile;
    }).pipe(Effect.orDie);
    return { grant: () => grant, revoke: () => revoke };
  }, Effect.orDie);

  const capabilityRole = (capabilityKeys: readonly [string, ...string[]]) =>
    roleOf(releaseCells.filter(({ capabilityKey }) => capabilityKeys.includes(capabilityKey)));
  const roleWithout = (capabilityKeys: readonly string[]) =>
    roleOf(releaseCells.filter(({ capabilityKey }) => !capabilityKeys.includes(capabilityKey)));
  const endHeldRoles = Effect.fn('TestTenantAccessRoles.endHeldRoles')(function* endHeldRoles() {
    const { assignments } = yield* people.loadTenantPeople(scope);
    const writes = assignments
      .filter(({ holder, status }) => status === 'active' && isHeldBy(holder, principalId))
      .map(({ incarnationId }) => ({ _tag: 'EndAssignment' as const, incarnationId }));
    yield* people.applyPeopleChange(scope, { writes });
    yield* reconcile;
  }, Effect.orDie);
  return { capabilityRole, endHeldRoles, roleWithout };
}, Effect.orDie);

/** One role of `makeTestTenantRoleAccess`: assign it in every scope, or end those assignments. */
export type TestTenantRole = Effect.Success<
  ReturnType<Effect.Success<ReturnType<typeof makeTestTenantRoleAccess>>['capabilityRole']>
>;
