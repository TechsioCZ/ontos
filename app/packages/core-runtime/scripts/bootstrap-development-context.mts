import { and, eq, inArray } from 'drizzle-orm';
import { NodeServices } from '@effect/platform-node';
import { Config, Console, DateTime, Effect, FileSystem, Layer, Match, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../src/auth/staff-authentication-namespace.ts';
import { CoreDatabase, CoreDatabaseLive } from '../src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig, parseDatabaseConnectionPair } from '../src/db/config.ts';
import type { DatabaseConfigError, DatabaseConfigValue } from '../src/db/config.ts';
import type { DatabaseConnectionError } from '../src/db/connection-error.ts';
import {
  DatabaseIdentityEnrollmentContext,
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
} from '../src/db/database-identities.ts';
import {
  tenants,
  legalEntities,
  principals,
  principalAuthBindings,
  principalCompanyMemberships,
  tenantModuleStates,
  searchIndexEntries,
  searchProjectionGenerations,
  searchProjectionRebuilds,
} from '../src/db/schema.ts';
import { AccessCatalogModulesSchema } from '../src/access/catalog/index.ts';
import {
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CatalogSnapshotIdSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  RoleTemplateKeySchema,
  TenantIdSchema,
} from '../src/access/ids.ts';
import type { AccessScopeId, LegalEntityId, PrincipalId, RoleId, RoleRevisionId, TenantId } from '../src/access/ids.ts';
import type { Cell, Holder } from '../src/access/model.ts';
import { legalEntityScopeId, tenantContextScopeId } from '../src/access/bootstrap/persistence.ts';
import { AccessPeopleCommands, AccessPeopleCommandsLive } from '../src/access/lifecycle/people-service.ts';
import {
  AccessCatalogSnapshotWriter,
  AccessCatalogSnapshotWriterLive,
} from '../src/access/intent/catalog-snapshot-writer.ts';
import { AccessChangesStore, writeRoleCreation } from '../src/access/changes/role-revision.ts';
import {
  AccessMembershipIdSchema,
  AccessMembershipStore,
  AccessMembershipStoreLive,
} from '../src/access/intent/memberships.ts';
import type { MembershipKind } from '../src/access/intent/memberships.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../src/access/intent/projection-writer.ts';
import { writeWorkloadBindings } from '../src/access/workloads/binding-store.ts';
import { writeWorkloadCompanyBindings } from '../src/access/workloads/company-bindings.ts';
import { AccessWorkloadCompanyBindingIdSchema } from '../src/access/workloads/company-store.ts';
import { AccessWorkloadBindingIdSchema } from '../src/access/workloads/store.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../src/access/bootstrap/bootstrap-tenant-access.ts';
import type { BootstrapScope } from '../src/access/bootstrap/persistence.ts';
import { stableUuid } from '../src/access/catalog/stable-id.ts';
import { WorkloadKeySchema } from '../src/authorization/access-declaration.ts';
import type { OperationalScope } from '../src/operations/context.ts';
import { AccessChangesStoreLive } from '../src/access/changes/persistence/drizzle-store.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../src/access/compiler/spice-db-compiler.ts';
import { AccessPeopleStoreLive } from '../src/access/intent/people-store.ts';
import { AccessProjectionCompiler } from '../src/access/intent/projection-compiler.ts';
import { AccessTeamStoreLive } from '../src/access/intent/teams.ts';
import { TenantIntentLoaderLive } from '../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../src/access/lifecycle/persistence/journal-store.ts';
import { installedModuleKeysOf } from '../src/install/installation-runtime.ts';
import type { InstallationRuntime } from '../src/install/installation-runtime.ts';
import { parseSpiceDbConfig } from '../src/permissions/config.ts';
import type { SpiceDbConfigValue } from '../src/permissions/config.ts';

import { stageScopeOf } from '../src/install/stage-context-bootstrap.ts';

import {
  CoreSearchProjectionDocumentSchema,
  coreSearchReplacementFingerprint,
  decodeCoreSearchProjectionReplacement,
} from '../src/search/projection.ts';

import type { Crypto } from 'effect';
import type { CoreTransaction } from '../src/db/types.ts';
import type { CoreSearchProjectionDocument } from '../src/search/projection.ts';

const partyModuleId = 'party.registry';
const partyResourceType = 'party.registry.party';
const counterpartyResourceType = 'party.registry.counterparty';
const searchResourceTypes = [partyResourceType, counterpartyResourceType];
const Uuid = Schema.String.check(Schema.isUUID());
const Text = Schema.Trim.check(Schema.isNonEmpty());
const AuthBindingIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoAuthBindingId')));
const AuthUserIdSchema = Schema.toEncoded(Text.pipe(Schema.brand('DemoAuthUserId')));
const FixtureLegalEntityIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoLegalEntityId')));
const ModuleIdSchema = Schema.toEncoded(Text.pipe(Schema.brand('DemoModuleId')));
const StateIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoStateId')));
const FixtureTenantIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoTenantId')));
const FixturePrincipalIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoPrincipalId')));

/**
 * The canonical intent one deployment seed applies: Roles with the exact cells they grant, Assignments,
 * memberships and machine workloads. It carries no SpiceDB tuple and no policy vocabulary: a caller that
 * owns policy (a demo matrix, a stage accounts file) compiles the cells and hands them here, and this port
 * writes them through the one Core path. Core stays owner-neutral — it names no capability of its own.
 */
const FixtureCellSchema = Schema.Struct({
  capabilityKey: CapabilityKeySchema,
  mode: Schema.Literals(['run', 'propose', 'approve']),
  selector: Schema.Literals(['all', 'assigned', 'entrusted', 'team']),
});
const AccessFixtureSchema = Schema.Struct({
  assignments: Schema.Array(
    Schema.Struct({
      legalEntityId: Schema.optionalKey(FixtureLegalEntityIdSchema),
      principalId: FixturePrincipalIdSchema,
      roleKey: RoleTemplateKeySchema,
    }),
  ),
  /**
   * The companies the tenant installs; each gets its own scope, so a Role in one never reaches another. The
   * primary legal entity of the fixture is always one of them.
   */
  legalEntityIds: Schema.Array(FixtureLegalEntityIdSchema),
  memberships: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(['member', 'owner', 'access_admin']),
      legalEntityId: Schema.optionalKey(FixtureLegalEntityIdSchema),
      principalId: FixturePrincipalIdSchema,
    }),
  ),
  /** The declarations of every module the running composition serves (O69). */
  modules: AccessCatalogModulesSchema,
  roles: Schema.Array(
    Schema.Struct({
      /** The exact capability, mode and selector slots the Role grants; never a wildcard or a module name. */
      cells: Schema.Array(FixtureCellSchema),
      /** The reviewed recipe key derives the Role identity; it does not invent template provenance. */
      key: RoleTemplateKeySchema,
      label: Text,
      /** The company a company Role belongs to; absent names the tenant context. */
      legalEntityId: Schema.optionalKey(FixtureLegalEntityIdSchema),
    }),
  ),
  /**
   * The registered machine workloads (O73). `legalEntityId` registers the binding for the one company the
   * workload acts for (D6); a standalone workload is admitted on a company-scoped call only for that company.
   */
  workloads: Schema.Array(
    Schema.Struct({
      legalEntityId: Schema.optionalKey(FixtureLegalEntityIdSchema),
      principalId: FixturePrincipalIdSchema,
      workloadKey: WorkloadKeySchema,
    }),
  ),
});

/** The SQL company memberships the demo seed writes; a role assignment never creates one. */
const CompanyMembershipSchema = Schema.Struct({
  affiliation: Schema.Literals(['employee', 'external']),
  legalEntityId: FixtureLegalEntityIdSchema,
  principalId: FixturePrincipalIdSchema,
});

const FixtureSchema = Schema.Struct({
  access: AccessFixtureSchema,
  accounts: Schema.Array(
    Schema.Struct({
      authBindingId: AuthBindingIdSchema,
      authUserId: AuthUserIdSchema,
      displayName: Text,
      principalId: FixturePrincipalIdSchema,
    }),
  ),
  companyMemberships: Schema.optionalKey(Schema.Array(CompanyMembershipSchema)),
  legalEntity: Schema.Struct({
    legalEntityId: FixtureLegalEntityIdSchema,
    legalName: Text,
    registrationCountry: Text,
    registrationNumber: Text,
  }),
  modules: Schema.Array(Schema.Struct({ moduleId: ModuleIdSchema, stateId: StateIdSchema })),
  searchDocuments: Schema.optionalKey(Schema.Array(CoreSearchProjectionDocumentSchema)),
  tenant: Schema.Struct({ defaultLocale: Text, displayName: Text, slug: Text, tenantId: FixtureTenantIdSchema }),
});
class DevelopmentBootstrapError extends Schema.TaggedError<DevelopmentBootstrapError>()('DevelopmentBootstrapError', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
}) {}

const loadInput = (fixturePath: string) =>
  Effect.gen(function* bootstrapDevelopmentContext() {
    yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const fs = yield* FileSystem.FileSystem;
    const input = yield* fs
      .readFileString(fixturePath)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))));
    if (input.searchDocuments !== undefined) {
      const docs = input.searchDocuments;
      const demoTenant = '70000000-0000-4000-8000-000000000020';
      const demoLegal = '71000000-0000-4000-8000-000000000020';
      const partyDocs = docs.filter((row) => row.ref.resourceType === partyResourceType);
      const counterpartyDocs = docs.filter((row) => row.ref.resourceType === counterpartyResourceType);
      if (
        input.tenant.tenantId !== demoTenant ||
        input.legalEntity.legalEntityId !== demoLegal ||
        partyDocs.length !== 6 ||
        counterpartyDocs.length !== 5 ||
        docs.length !== 11 ||
        new Set(docs.map((row) => row.ref.resourceId)).size !== 11 ||
        docs.some(
          (row) =>
            row.ref.tenantId !== demoTenant ||
            row.ref.moduleId !== partyModuleId ||
            row.archived ||
            (row.aliases?.length ?? 0) > 0 ||
            row.matchedRef !== undefined ||
            row.matchedSubjectRef !== undefined ||
            row.facets.length !== 0 ||
            row.metadata.length !== 0 ||
            (row.temporalSearchableText?.length ?? 0) > 0,
        ) ||
        partyDocs.some((row) => row.selectedLegalEntityId !== undefined || row.subjectRef !== undefined) ||
        counterpartyDocs.some(
          (row) =>
            row.selectedLegalEntityId !== demoLegal ||
            row.subjectRef?.tenantId !== demoTenant ||
            row.subjectRef.moduleId !== partyModuleId ||
            row.subjectRef.resourceType !== partyResourceType ||
            !partyDocs.some((party) => party.ref.resourceId === row.subjectRef?.resourceId),
        )
      ) {
        return yield* new DevelopmentBootstrapError({
          reason:
            'Search fixtures must contain exactly six Nájempark Parties and five Counterparties in the fixed tenant and legal entity',
        });
      }
      for (const resourceType of searchResourceTypes) {
        yield* Effect.try({
          catch: (cause) => new DevelopmentBootstrapError({ cause, reason: 'Search fixture projection is invalid' }),
          try: () =>
            decodeCoreSearchProjectionReplacement({
              documents: docs.filter((row) => row.ref.resourceType === resourceType),
              moduleId: partyModuleId,
              rebuildVersion: '1',
              resourceType,
              tenantId: demoTenant,
            }),
        });
      }
    }
    return input;
  });
type SeedSearchDocumentPayload = {
  -readonly [
    Key in keyof Pick<
      CoreSearchProjectionDocument,
      'archived' | 'facets' | 'metadata' | 'subjectRef' | 'temporalFacets'
    >
  ]: CoreSearchProjectionDocument[Key];
} & { readonly schemaVersion: '1' };
const bootstrapSearchDocuments = Effect.fn('DevelopmentBootstrap.searchDocuments')(function* installSearchDocuments(
  transaction: CoreTransaction,
  documents: readonly CoreSearchProjectionDocument[],
  tenantId: string,
) {
  const moduleId = partyModuleId;
  const generationScope = and(
    eq(searchProjectionGenerations.tenantId, tenantId),
    eq(searchProjectionGenerations.sourceModuleKey, moduleId),
  );
  yield* transaction
    .insert(searchProjectionGenerations)
    .values({ generation: 1n, sourceModuleKey: moduleId, tenantId })
    .onConflictDoNothing();
  const [current] = yield* transaction
    .select({ generation: searchProjectionGenerations.generation })
    .from(searchProjectionGenerations)
    .where(generationScope)
    .for('update');
  if (current === undefined) {
    return yield* new DevelopmentBootstrapError({ reason: 'Search generation unavailable' });
  }
  const version = current.generation + 1n;
  const now = yield* DateTime.nowAsDate;
  yield* transaction
    .update(searchProjectionGenerations)
    .set({ generation: version, updatedAt: now })
    .where(generationScope);
  yield* transaction
    .delete(searchIndexEntries)
    .where(
      and(
        eq(searchIndexEntries.tenantId, tenantId),
        eq(searchIndexEntries.sourceModuleKey, moduleId),
        inArray(searchIndexEntries.sourceResourceType, searchResourceTypes),
      ),
    );
  for (const document of documents) {
    const facetsJson: SeedSearchDocumentPayload = {
      archived: document.archived,
      facets: document.facets,
      metadata: document.metadata,
      schemaVersion: '1',
    };
    if (document.subjectRef !== undefined) {
      facetsJson.subjectRef = document.subjectRef;
    }
    if (document.temporalFacets !== undefined) {
      facetsJson.temporalFacets = document.temporalFacets;
    }
    const values = {
      bodyText: [document.title, ...document.searchableText]
        .map((value) => value.normalize('NFKC').toLocaleLowerCase('und'))
        .join('\n'),
      deleted: false,
      facetsJson,
      legalEntityId: document.selectedLegalEntityId ?? null,
      projectionVersion: version,
      sourceModuleKey: document.ref.moduleId,
      sourceResourceId: document.ref.resourceId,
      sourceResourceType: document.ref.resourceType,
      tenantId: document.ref.tenantId,
      title: document.title,
      updatedAt: now,
    };
    yield* transaction.insert(searchIndexEntries).values(values);
  }
  for (const resourceType of searchResourceTypes) {
    const replacement = yield* Effect.try({
      catch: (cause) => new DevelopmentBootstrapError({ cause, reason: 'Search projection generation is invalid' }),
      try: () =>
        decodeCoreSearchProjectionReplacement({
          documents: documents
            .filter((row) => row.ref.resourceType === resourceType)
            .map((row) => ({ ...row, projectionVersion: String(version) })),
          moduleId,
          rebuildVersion: String(version),
          resourceType,
          tenantId,
        }),
    });
    const fingerprint = coreSearchReplacementFingerprint(replacement);
    yield* transaction
      .insert(searchProjectionRebuilds)
      .values({
        fingerprint,
        rebuildVersion: version,
        sourceModuleKey: moduleId,
        sourceResourceType: resourceType,
        tenantId,
      })
      .onConflictDoUpdate({
        set: { fingerprint, rebuildVersion: version, updatedAt: now },
        target: [
          searchProjectionRebuilds.tenantId,
          searchProjectionRebuilds.sourceModuleKey,
          searchProjectionRebuilds.sourceResourceType,
        ],
      });
  }

  return yield* Effect.void;
});
/** The local SpiceDB of a development seed; a non-loopback endpoint is refused before anything is written. */
const loadDevelopmentSpiceDb = Effect.gen(function* loadDevelopmentSpiceDbEffect() {
  const values = yield* Config.all({
    ca: Config.String('SPICEDB_CA_CERT'),
    endpoint: Config.String('SPICEDB_ENDPOINT'),
    environment: Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    key: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  });
  const configuration = yield* parseSpiceDbConfig({
    SPICEDB_CA_CERT: values.ca,
    SPICEDB_ENDPOINT: values.endpoint,
    SPICEDB_PRESHARED_KEY: Redacted.value(values.key),
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: values.environment,
  }).pipe(Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: cause.reason })));
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/u.test(configuration.endpoint)) {
    return yield* new DevelopmentBootstrapError({ reason: 'Development bootstrap requires local SpiceDB' });
  }
  return configuration;
});

/**
 * The access writers and the engine transport of one development seed run (CUTOVER-PLAN §3.1). The run
 * owns the *runtime* pool: every scope it installs is a session-setting scope, and the enrollment it is
 * handed names that role. The identity rows beside it are written by the administrative pool the caller
 * provides, exactly as the migrator and the operator roots split the two.
 */
type DevelopmentAccessRuntime =
  | InstallationRuntime
  | AccessPeopleCommands
  | AccessChangesStore
  | AccessCatalogSnapshotWriter
  | DatabaseIdentityEnrollmentContext;

const developmentInstallationRuntime = (
  spiceDb: SpiceDbConfigValue,
  database: Layer.Layer<CoreDatabase, DatabaseConnectionError>,
): Layer.Layer<DevelopmentAccessRuntime, DatabaseConnectionError, Crypto.Crypto> => {
  const engine = Layer.effect(
    AccessProjectionCompiler,
    Effect.acquireRelease(
      Effect.sync(() => makeAccessProjectionTransport(spiceDb)),
      (transport) => Effect.sync(() => transport.close()),
    ).pipe(Effect.map((transport) => makeAccessProjectionCompiler(transport))),
  );
  const enrollment = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));
  const platform = Layer.mergeAll(database, engine, enrollment);
  const stores = Layer.mergeAll(
    TenantIntentLoaderLive,
    AccessWriteJournalStoreLive,
    AccessChangesStoreLive,
    AccessMembershipStoreLive,
    AccessPeopleStoreLive,
    AccessTeamStoreLive,
  ).pipe(Layer.provide(platform));
  const catalog = AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores));
  const writer = AccessProjectionWriterLive.pipe(Layer.provide(Layer.mergeAll(stores, platform)));
  const bootstrap = TenantAccessBootstrapLive.pipe(Layer.provide(Layer.mergeAll(stores, platform, catalog, writer)));
  const people = AccessPeopleCommandsLive.pipe(Layer.provide(Layer.mergeAll(stores, writer)));
  return Layer.mergeAll(bootstrap, writer, catalog, stores, platform, people);
};

/** The identifiers a re-run resumes: each is derived from what it names, so a second seed collides with itself. */
const fixtureRoleId = (tenantId: TenantId, key: string): RoleId =>
  RoleIdSchema.make(stableUuid(['ontos.development.access.role', tenantId, key].join(':')));
const fixtureRoleRevisionId = (tenantId: TenantId, key: string): RoleRevisionId =>
  RoleRevisionIdSchema.make(stableUuid(['ontos.development.access.role-revision', tenantId, key, '1'].join(':')));
const fixtureAssignmentIncarnationId = (
  tenantId: TenantId,
  scopeId: AccessScopeId,
  roleId: RoleId,
  principalId: PrincipalId,
): string => stableUuid(['ontos.development.access.assignment', tenantId, scopeId, roleId, principalId].join(':'));
const fixtureMembershipId = (
  tenantId: TenantId,
  scopeId: AccessScopeId,
  kind: MembershipKind,
  principalId: PrincipalId,
): string => stableUuid(['ontos.development.access.membership', tenantId, scopeId, kind, principalId].join(':'));
const fixtureWorkloadBindingId = (tenantId: TenantId, principalId: PrincipalId, workloadKey: string): string =>
  stableUuid(['ontos.development.access.workload-binding', tenantId, principalId, workloadKey].join(':'));
const fixtureWorkloadCompanyId = (tenantId: TenantId, bindingId: string, legalEntityId: string, part: string) =>
  stableUuid(['ontos.development.access.workload-company', part, tenantId, bindingId, legalEntityId].join(':'));

/** The company a reviewed membership names, or the tenant context when it names none. */
const fixtureMembershipScope = (tenantId: TenantId, legalEntityId: LegalEntityId | undefined): BootstrapScope =>
  legalEntityId === undefined
    ? { _tag: 'TenantContext', scopeId: tenantContextScopeId(tenantId) }
    : { _tag: 'LegalEntity', legalEntityId, scopeId: legalEntityScopeId(tenantId, legalEntityId) };

/** The principal a holder names; a holder is either a person or an agent, and never both. */
const holderPrincipalId = (holder: Holder): string | undefined =>
  Match.value(holder).pipe(
    Match.tag('Principal', ({ principalId }) => Option.some(principalId)),
    Match.tag('Agent', () => Option.none<string>()),
    Match.exhaustive,
    Option.getOrUndefined,
  );

interface DevelopmentSeedOutcome {
  readonly assignments: number;
  readonly memberships: number;
  readonly roles: number;
  readonly scopes: number;
  readonly workloads: number;
}

/**
 * Applies the fixture's canonical intent through the one Core path: bootstrap, roles, memberships,
 * assignments, workloads, then one reconcile. Every step is idempotent, so a repeated seed resumes the
 * rows it wrote instead of duplicating them, and no step writes a SpiceDB relationship by hand.
 *
 * A cell naming a capability the published release does not declare is refused before the Role is
 * written: a Role that silently lost a cell would lock its people out of a capability the composition
 * serves, and the caller would only see an empty grant.
 */
const applyReviewedAccess = (
  access: typeof AccessFixtureSchema.Type,
  installedModuleKeys: readonly string[],
  scope: OperationalScope,
  ownerPrincipalId: PrincipalId,
  at: Date,
): Effect.Effect<DevelopmentSeedOutcome, DevelopmentBootstrapError, DevelopmentAccessRuntime> =>
  Effect.gen(function* applyReviewedAccessEffect() {
    const tenantId = TenantIdSchema.make(scope.tenantId);
    const bootstrap = yield* TenantAccessBootstrap;
    const catalogWriter = yield* AccessCatalogSnapshotWriter;
    const changes = yield* AccessChangesStore;
    const memberships = yield* AccessMembershipStore;
    const people = yield* AccessPeopleCommands;
    const projection = yield* AccessProjectionWriter;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    const { executor } = yield* CoreDatabase;

    const bootstrapped = yield* bootstrap
      .bootstrapTenantAccess({
        legalEntityIds: access.legalEntityIds.map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId)),
        modules: access.modules,
        scope,
      })
      .pipe(
        Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` })),
      );
    const release = yield* catalogWriter
      .ensureInitialRelease({
        installedModuleKeys: installedModuleKeys.map((moduleKey) => ModuleKeySchema.make(moduleKey)),
        modules: access.modules,
      })
      .pipe(
        Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` })),
      );
    const declaredKeys: ReadonlySet<string> = new Set(release.entries.map((entry) => entry.key));

    const existingRoles = yield* changes
      .loadTenantChanges(scope)
      .pipe(
        Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` })),
      );
    const roleIds = new Map<string, { readonly roleId: RoleId; readonly roleRevisionId: RoleRevisionId }>();
    for (const role of access.roles) {
      const roleId = fixtureRoleId(tenantId, role.key);
      const roleRevisionId = fixtureRoleRevisionId(tenantId, role.key);
      roleIds.set(role.key, { roleId, roleRevisionId });
      const cells: readonly Cell[] = role.cells.map((cell) => ({
        capabilityKey: CapabilityKeySchema.make(cell.capabilityKey),
        mode: cell.mode,
        selector: { _tag: cell.selector },
      }));
      for (const cell of cells) {
        if (!declaredKeys.has(cell.capabilityKey)) {
          return yield* new DevelopmentBootstrapError({
            reason: `Role ${role.key} names ${cell.capabilityKey}, which the pinned release does not declare`,
          });
        }
      }
      if (existingRoles.roles.some((existing) => existing.role.id === roleId)) {
        continue;
      }
      const creation = {
        catalogSnapshotId: CatalogSnapshotIdSchema.make(release.id),
        cells,
        decidedAt: at,
        name: role.label,
        scope,
        targetRevisionId: roleRevisionId,
        targetRoleId: roleId,
      };
      const request =
        role.legalEntityId === undefined
          ? creation
          : { ...creation, legalEntityId: LegalEntityIdSchema.make(role.legalEntityId) };
      yield* writeRoleCreation(request).pipe(
        Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` })),
      );
    }

    const existingMemberships = yield* memberships
      .loadTenantMemberships(scope)
      .pipe(
        Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` })),
      );
    const presentMemberships = new Set(
      existingMemberships.map((row) =>
        [row.scopeId, row.kind, holderPrincipalId(row.holder) ?? row.holder._tag].join(':'),
      ),
    );
    const membershipRows = access.memberships.flatMap((membership) => {
      const principalId = PrincipalIdSchema.make(membership.principalId);
      const entry = fixtureMembershipScope(
        tenantId,
        membership.legalEntityId === undefined ? undefined : LegalEntityIdSchema.make(membership.legalEntityId),
      );
      const key = [entry.scopeId, membership.kind, principalId].join(':');
      if (presentMemberships.has(key)) {
        return [];
      }
      return [
        {
          createdAt: at,
          holder: { _tag: 'Principal' as const, principalId },
          id: AccessMembershipIdSchema.make(fixtureMembershipId(tenantId, entry.scopeId, membership.kind, principalId)),
          kind: membership.kind,
          recordedBy: ownerPrincipalId,
          scopeId: entry.scopeId,
          status: 'active' as const,
          tenantId,
          validFrom: at,
        },
      ];
    });
    if (membershipRows.length > 0) {
      yield* memberships
        .recordMemberships(scope, { memberships: membershipRows })
        .pipe(
          Effect.mapError(
            (cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` }),
          ),
        );
    }

    const view = yield* people
      .read(scope)
      .pipe(
        Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` })),
      );
    const presentAssignments = new Set(
      view.assignments
        .filter((assignment) => assignment.status === 'active')
        .map((assignment) =>
          [assignment.scopeId, assignment.roleId, holderPrincipalId(assignment.holder) ?? assignment.holder._tag].join(
            ':',
          ),
        ),
    );
    let assignments = 0;
    for (const assignment of access.assignments) {
      const role = roleIds.get(assignment.roleKey);
      if (role === undefined) {
        return yield* new DevelopmentBootstrapError({ reason: `Assignment names unknown Role ${assignment.roleKey}` });
      }
      const principalId = PrincipalIdSchema.make(assignment.principalId);
      const scopeId =
        assignment.legalEntityId === undefined
          ? tenantContextScopeId(tenantId)
          : legalEntityScopeId(tenantId, LegalEntityIdSchema.make(assignment.legalEntityId));
      if (presentAssignments.has([scopeId, role.roleId, principalId].join(':'))) {
        continue;
      }
      yield* people
        .assignRole(scope, {
          incarnationId: AssignmentIncarnationIdSchema.make(
            fixtureAssignmentIncarnationId(tenantId, scopeId, role.roleId, principalId),
          ),
          principalId,
          roleId: role.roleId,
          roleRevisionId: role.roleRevisionId,
          scopeId,
        })
        .pipe(
          Effect.mapError(
            (cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` }),
          ),
        );
      assignments += 1;
    }

    if (access.workloads.length > 0) {
      yield* writeWorkloadBindings({ enrollment, executor }, scope, {
        bindings: access.workloads.map((workload) => {
          const principalId = PrincipalIdSchema.make(workload.principalId);
          return {
            bindingId: AccessWorkloadBindingIdSchema.make(
              fixtureWorkloadBindingId(tenantId, principalId, workload.workloadKey),
            ),
            createdAt: at,
            incarnation: AccessWorkloadBindingIdSchema.make(
              fixtureWorkloadBindingId(tenantId, principalId, `${workload.workloadKey}:incarnation`),
            ),
            principalId,
            tenantId,
            workloadKey: WorkloadKeySchema.make(workload.workloadKey),
          };
        }),
      }).pipe(
        Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` })),
      );
    }
    const registered = access.workloads.flatMap((workload) =>
      workload.legalEntityId === undefined ? [] : [{ ...workload, legalEntityId: workload.legalEntityId }],
    );
    if (registered.length > 0) {
      yield* writeWorkloadCompanyBindings({ enrollment, executor }, scope, {
        bindings: registered.map((workload) => {
          const bindingId = fixtureWorkloadBindingId(
            tenantId,
            PrincipalIdSchema.make(workload.principalId),
            workload.workloadKey,
          );
          return {
            companyBindingId: AccessWorkloadCompanyBindingIdSchema.make(
              fixtureWorkloadCompanyId(tenantId, bindingId, workload.legalEntityId, 'binding'),
            ),
            createdAt: at,
            incarnation: AccessWorkloadCompanyBindingIdSchema.make(
              fixtureWorkloadCompanyId(tenantId, bindingId, workload.legalEntityId, 'incarnation'),
            ),
            legalEntityId: LegalEntityIdSchema.make(workload.legalEntityId),
            tenantId,
            workloadBindingId: AccessWorkloadBindingIdSchema.make(bindingId),
          };
        }),
      }).pipe(
        Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` })),
      );
    }

    yield* projection
      .reconcileTenant({ scope })
      .pipe(
        Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: `${cause.code}: ${cause.reason}` })),
      );

    return {
      assignments,
      memberships: membershipRows.length,
      roles: roleIds.size,
      scopes: bootstrapped.scopes.length,
      workloads: access.workloads.length,
    };
  });

const initializeDevelopmentContext = (input: typeof FixtureSchema.Type) =>
  Effect.gen(function* bootstrapDevelopmentContext() {
    const { executor } = yield* CoreDatabase;
    const accountPrincipalIds = input.accounts.map((account) => account.principalId);
    const currentPrincipals = yield* executor.transaction((transaction) =>
      Effect.gen(function* bootstrapContextRows() {
        yield* transaction
          .insert(tenants)
          .values({ ...input.tenant, name: input.tenant.displayName, status: 'active' })
          .onConflictDoNothing();
        yield* transaction
          .insert(legalEntities)
          .values({ ...input.legalEntity, status: 'active', tenantId: input.tenant.tenantId })
          .onConflictDoNothing();
        for (const account of input.accounts) {
          yield* transaction
            .insert(principals)
            .values({
              displayName: account.displayName,
              kind: 'human',
              principalId: account.principalId,
              status: 'active',
              tenantId: input.tenant.tenantId,
            })
            .onConflictDoNothing();
          yield* transaction
            .insert(principalAuthBindings)
            .values({
              authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
              principalAuthBindingId: account.authBindingId,
              principalId: account.principalId,
              provider: 'better_auth',
              providerSubjectId: account.authUserId,
              status: 'active',
              subjectType: 'user',
              tenantId: input.tenant.tenantId,
            })
            .onConflictDoNothing();
        }
        // Explicit reviewed SQL memberships; a Role assignment never creates one (D27). Insert-only, so a
        // rerun never reactivates or reclassifies an actor.
        for (const membership of input.companyMemberships ?? []) {
          yield* transaction
            .insert(principalCompanyMemberships)
            .values({
              affiliation: membership.affiliation,
              legalEntityId: membership.legalEntityId,
              principalId: membership.principalId,
              status: 'active',
              tenantId: input.tenant.tenantId,
            })
            .onConflictDoNothing();
        }
        for (const module of input.modules) {
          yield* transaction
            .insert(tenantModuleStates)
            .values({
              moduleKey: module.moduleId,
              state: 'active',
              tenantId: input.tenant.tenantId,
              tenantModuleStateId: module.stateId,
            })
            .onConflictDoNothing();
        }
        if (input.searchDocuments !== undefined) {
          yield* bootstrapSearchDocuments(transaction, input.searchDocuments, input.tenant.tenantId);
        }
        return yield* transaction
          .select({
            kind: principals.kind,
            principalId: principals.principalId,
            status: principals.status,
            tenantId: principals.tenantId,
            tenantStatus: tenants.status,
          })
          .from(principals)
          .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
          .where(
            and(eq(principals.tenantId, input.tenant.tenantId), inArray(principals.principalId, accountPrincipalIds)),
          );
      }),
    );
    const owner = currentPrincipals.find((actor) => actor.principalId === input.accounts[0]?.principalId);
    if (owner === undefined) {
      return yield* new DevelopmentBootstrapError({ reason: 'Development bootstrap needs its owner account' });
    }
    const scope = yield* stageScopeOf({ principalId: owner.principalId, tenantId: input.tenant.tenantId }).pipe(
      Effect.mapError((cause) => new DevelopmentBootstrapError({ cause, reason: cause.reason })),
    );
    const spiceDb = yield* loadDevelopmentSpiceDb;
    const at = yield* DateTime.nowAsDate;
    return { at, ownerPrincipalId: PrincipalIdSchema.make(owner.principalId), scope, spiceDb };
  });

/**
 * The administrative identity's configuration: the pool the identity rows are written with. The
 * connection pair is read as a plain effect rather than a layer, so the database layer the command builds
 * is provided one already-resolved `DatabaseConfig` and its error channel stays the pool's own.
 */
const adminDatabaseConfig: Effect.Effect<
  DatabaseConfigValue,
  Config.ConfigError | DatabaseConfigError | DevelopmentBootstrapError
> = Effect.gen(function* adminDatabaseConfiguration() {
  yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
  const pair = yield* Config.all({
    DATABASE_ADMIN_URL: Config.Redacted('DATABASE_ADMIN_URL'),
    DATABASE_URL: Config.Redacted('DATABASE_URL'),
  }).pipe(
    Effect.flatMap((urls) =>
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: Redacted.value(urls.DATABASE_ADMIN_URL),
        DATABASE_URL: Redacted.value(urls.DATABASE_URL),
      }),
    ),
  );
  if (
    ![pair.admin.host, pair.runtime.host].every(
      (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]',
    )
  ) {
    return yield* new DevelopmentBootstrapError({ reason: 'Development bootstrap requires local PostgreSQL' });
  }
  return pair.admin;
});

/**
 * The pool the access seed itself connects with: the runtime identity. Its enrollment names the
 * session-setting role every installed scope is verified against, so the seed never installs a scope on an
 * identity the enrollment does not carry.
 */
const developmentRuntimeDatabaseConfig: Effect.Effect<
  DatabaseConfigValue,
  Config.ConfigError | DatabaseConfigError | DevelopmentBootstrapError
> = Effect.gen(function* developmentRuntimeDatabaseConfiguration() {
  yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
  const configuration = yield* Config.Redacted('DATABASE_URL').pipe(
    Effect.flatMap((url) => parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) })),
  );
  if (!['localhost', '127.0.0.1', '[::1]'].includes(configuration.host)) {
    return yield* new DevelopmentBootstrapError({ reason: 'Development bootstrap requires local PostgreSQL' });
  }
  return configuration;
});

const logSeedOutcome = (seeded: DevelopmentSeedOutcome) =>
  Console.log(
    `Development identity and authorization context initialized: ${String(seeded.roles)} role(s), ${String(seeded.assignments)} assignment(s), ${String(seeded.memberships)} membership(s), ${String(seeded.workloads)} workload(s) over ${String(seeded.scopes)} scope(s)`,
  );

const developmentAccessFailure = (
  cause: Config.ConfigError | DatabaseConfigError | DatabaseConnectionError | DevelopmentBootstrapError,
) =>
  Schema.is(DevelopmentBootstrapError)(cause)
    ? cause
    : new DevelopmentBootstrapError({
        cause,
        reason: 'Development access seed failed; no relationship was written by hand',
      });

/** The CLI owns both Layer builds; their independent memo maps keep the two database identities separate. */
const runDevelopmentFixture = (input: typeof FixtureSchema.Type) =>
  Effect.scoped(
    Effect.gen(function* runDevelopmentFixtureEffect() {
      const adminConfig = yield* adminDatabaseConfig;
      const admin = CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, adminConfig)));
      const installedModules = installedModuleKeysOf(
        input.modules.map(({ moduleId }) => moduleId),
        input.access.modules,
      );
      const program = Effect.gen(function* initializeAndSeed() {
        const { at, ownerPrincipalId, scope, spiceDb } = yield* initializeDevelopmentContext(input);
        yield* Effect.scoped(
          Effect.gen(function* runAccessSeed() {
            const runtimeConfig = yield* developmentRuntimeDatabaseConfig;
            const seed = applyReviewedAccess(input.access, installedModules, scope, ownerPrincipalId, at).pipe(
              Effect.flatMap(logSeedOutcome),
            );
            const access = developmentInstallationRuntime(
              spiceDb,
              CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, runtimeConfig))),
            );
            // This is a second database identity, not a second use of the administrative service.
            // A root memo map prevents the nested build from inheriting the admin pool's entry.
            const accessMemoMap = yield* Layer.makeMemoMap;
            const accessScope = yield* Effect.scope;
            yield* Layer.buildWithMemoMap(
              Layer.effectDiscard(seed).pipe(Layer.provide(access)),
              accessMemoMap,
              accessScope,
            );
          }),
        ).pipe(Effect.mapError(developmentAccessFailure));
      });
      yield* Layer.build(Layer.effectDiscard(program).pipe(Layer.provide(admin)));
    }),
  );

const command = Command.make(
  'demo-fixture',
  { fixture: Flag.String('fixture'), validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)) },
  ({ fixture, validateOnly }) =>
    loadInput(fixture).pipe(
      Effect.flatMap((input) =>
        validateOnly
          ? Console.log('Development fixture and search scope validated; no data changed')
          : runDevelopmentFixture(input),
      ),
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DevelopmentBootstrapError)(failure)
            ? `Fixture port failed: ${failure._tag}: ${failure.reason}`
            : `Fixture port failed: ${failure._tag}`,
        ),
      ),
    ),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(NodeServices.layer),
);
await Effect.runPromise(Effect.scoped(Layer.build(runtimeLive)));
