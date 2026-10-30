#!/usr/bin/env node
/** Local-only reviewed legacy cutover. LEAD owns execution, sealed admission and runtime restarts. */
import { createHash } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { inArray, sql } from 'drizzle-orm';
import { Reactivity } from 'effect/reactivity';
import {
  Array as EffectArray,
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Order,
  Redacted,
  Result,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import type { CoreTransaction } from '../../packages/core-runtime/src/db/types.ts';
import { PrincipalRefSchema } from '../../packages/core-runtime/src/permissions/principal-ref.ts';
import { ConfigureAgentPayloadSchema } from '../../packages/core-runtime/src/modules/actions/configure-agent.action.ts';
import { CoreAdminDatabaseLive, CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { withPostgresSessionAdvisoryLock } from '../../packages/core-runtime/src/db/session-advisory-lock.ts';
import {
  legalEntities,
  principalCompanyMemberships,
  principals,
  tenants,
} from '../../packages/core-runtime/src/db/schema.ts';
import {
  BootstrapCompanyMembershipSchema,
  installBootstrapCompanyMemberships,
} from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { currentAgentProfileRelationships } from '../../packages/core-runtime/src/permissions/agent-profile-lifecycle.ts';
import { buildPrincipalSelfCredentialUpdates } from '../../packages/core-runtime/src/permissions/action-authorization-lifecycle.ts';
import { buildApplicationCompositionCatalog } from '../../packages/core-runtime/src/modules/application-composition-catalog.ts';
import { agentNamedPermissionScopeRelationships } from '../../packages/core-runtime/src/install/agent-scoped-role-policy.ts';
import { foldAgentActionMigrationProfiles } from '../../packages/core-runtime/src/install/agent-action-policy-migration.ts';
import {
  applyPeopleModelTransitionSealedGraph,
  PeopleModelTransitionError,
  planPeopleModelTransition,
  reviewedTransitionAgentNamedPermissions,
  reviewedTransitionAgentProfiles,
  reviewedTransitionReplayAgents,
  verifyPeopleModelTransitionGraph,
} from '../../packages/core-runtime/src/install/people-model-transition.ts';
import type {
  PeopleModelTransitionInput,
  PeopleModelTransitionSnapshot,
} from '../../packages/core-runtime/src/install/people-model-transition.ts';
import {
  buildActionAuthorizationRelationships,
  buildIntrinsicSelfCredentialRelationships,
  deriveScopedActionAuthorization,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { fullyConsistent } from '../../packages/core-runtime/src/permissions/client.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import { ActiveApplicationCompositionConfigLive } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { loadCurrentActionAuthorizationComposition } from '../provision-current-action-authorization.mts';
import {
  runApplicationCompositionMigration,
  withApplicationCompositionPublicationLock,
} from '../application-composition-authority-publication.mts';
import { peopleModelTransitionFixtureRelationships } from './people-model-transition-fixture.mts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';
import { readReviewedAgentProfiles, reviewedProfileInputs, runAgentProfileSetup } from './agent-profile-setup.mts';

import {
  admitPostBaselineRelationships,
  ReviewedPeopleInventorySchema,
  reviewedPeopleInventorySha256,
  reviewedInvitationMembershipEvidenceSql,
  retailEnrollmentEvidenceSql,
} from '../people-model-post-baseline.mts';
import type { RetailEnrollment, ReviewedInvitationMembership } from '../people-model-post-baseline.mts';

const TenantIdSchema = PrincipalRefSchema.fields.tenantId;
const PrincipalIdSchema = PrincipalRefSchema.fields.principalId;
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('LegalEntityId'),
  Schema.decodeTo(Schema.String),
);
const AuditEventIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('AuditEventId'),
  Schema.decodeTo(Schema.String),
);
const RoleKeySchema = Schema.NonEmptyString.pipe(Schema.brand('ScopedRoleKey'), Schema.decodeTo(Schema.String));
const ModuleIdSchema = Schema.NonEmptyString.pipe(Schema.brand('ModuleId'), Schema.decodeTo(Schema.String));
const RelationshipSchema = Schema.Struct({
  relation: Schema.String,
  resourceId: Schema.String.pipe(Schema.brand('GraphResourceId'), Schema.decodeTo(Schema.String)),
  resourceType: Schema.String,
  subjectId: Schema.String.pipe(Schema.brand('GraphSubjectId'), Schema.decodeTo(Schema.String)),
  subjectRelation: Schema.optionalKey(Schema.String),
  subjectType: Schema.String,
});
const RoleSchema = Schema.Struct({
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  roleKey: RoleKeySchema,
  tenantId: TenantIdSchema,
});
const ProfileSchema = Schema.Struct({
  auditEventId: Schema.optionalKey(AuditEventIdSchema),
  description: ConfigureAgentPayloadSchema.fields.description,
  legalEntityId: LegalEntityIdSchema,
  modules: Schema.Array(Schema.Struct({ access: Schema.Literals(['read', 'write']), moduleId: ModuleIdSchema })),
  ownerPrincipalId: ConfigureAgentPayloadSchema.fields.ownerPrincipalId,
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
  writePolicy: Schema.Literals(['read_only', 'approval', 'direct']),
});
const LegacyProfileMetadataSchema = Schema.Struct({
  actionKey: Schema.Literal('core.identity.manage-demo-account'),
  description: ProfileSchema.fields.description,
  operation: Schema.Literal('create-agent'),
  ownerPrincipalId: ProfileSchema.fields.ownerPrincipalId,
});
const MembershipFileSchema = Schema.Struct({
  compositionRevision: Schema.String,
  fixtureRelationships: Schema.Array(RelationshipSchema),
  mode: Schema.Literal('reviewed_transition_input'),
  preservedUnadmittedAgents: Schema.Array(Schema.Struct({ principalId: PrincipalIdSchema, tenantId: TenantIdSchema })),
  rows: Schema.Array(
    Schema.Struct({
      affiliation: Schema.OptionFromNullOr(Schema.Literals(['employee', 'external'])),
      approvedAgentProfile: Schema.optionalKey(ProfileSchema),
      kind: Schema.Literals(['human', 'agent']),
      legalEntityId: LegalEntityIdSchema,
      principalId: PrincipalIdSchema,
      scopedRoles: Schema.Array(RoleSchema),
      status: Schema.Literal('active'),
      tenantId: TenantIdSchema,
    }),
  ),
  schemaVersion: Schema.Literal(2),
});
const MembershipStateSchema = Schema.Struct({
  affiliation: Schema.OptionFromNullOr(Schema.String),
  legalEntityId: LegalEntityIdSchema,
  principalId: PrincipalIdSchema,
  revision: Schema.Number,
  status: Schema.String,
  tenantId: TenantIdSchema,
});
const encodeMembershipState = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(MembershipStateSchema)));
const fail = (reason: string, cause?: unknown) => new PeopleModelTransitionError({ cause, reason });
const relationship = (row: {
  relation: string;
  resourceId: string;
  resourceType: string;
  subjectId: string;
  subjectRelation?: string;
  subjectType: string;
}) =>
  v1.Relationship.create({
    relation: row.relation,
    resource: { objectId: row.resourceId, objectType: row.resourceType },
    subject: {
      object: { objectId: row.subjectId, objectType: row.subjectType },
      optionalRelation: row.subjectRelation ?? '',
    },
  });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const graphFailure = (cause: unknown) =>
  fail('Native local graph operation failed; admission must remain sealed', cause);
type GraphClient = ReturnType<typeof newSpiceDbGrpcClient>;
const readGraph = (client: GraphClient) =>
  Effect.gen(function* snapshotGraph() {
    const schema = yield* Effect.tryPromise({
      catch: graphFailure,
      try: async () => await client.promises.readSchema(v1.ReadSchemaRequest.create({})),
    });
    const types = [...schema.schemaText.matchAll(/definition\s+(?<type>[a-z_]+)\s*\{/gu)].map(
      (match) => match.groups?.type ?? '',
    );
    if (types.length === 0 || types.includes('')) {
      return yield* fail('Cannot enumerate native graph schema definitions');
    }
    const groups = yield* Effect.forEach(
      types,
      (resourceType) =>
        Effect.tryPromise({
          catch: graphFailure,
          try: async () =>
            await client.promises.readRelationships(
              v1.ReadRelationshipsRequest.create({
                consistency: fullyConsistent,
                relationshipFilter: { resourceType },
              }),
            ),
        }),
      { concurrency: 1 },
    );
    const relationships = yield* Effect.forEach(
      groups.flat(),
      (row) =>
        row.relationship === undefined
          ? Effect.fail(fail('Incomplete native graph evidence'))
          : Effect.succeed(row.relationship),
      { concurrency: 1 },
    );
    return { relationships, schema: schema.schemaText } satisfies PeopleModelTransitionSnapshot;
  });
const writeRelationships = (client: GraphClient, request: v1.WriteRelationshipsRequest) =>
  Effect.tryPromise({
    catch: graphFailure,
    try: async () => await client.promises.writeRelationships(request),
  });
const writeSchema = (client: GraphClient, request: v1.WriteSchemaRequest) =>
  Effect.tryPromise({
    catch: graphFailure,
    try: async () => await client.promises.writeSchema(request),
  });
const verifySchema = (client: GraphClient) =>
  Effect.gen(function* verifyNativeSchema() {
    const diff = yield* Effect.tryPromise({
      catch: graphFailure,
      try: async () =>
        await client.promises.diffSchema(
          v1.DiffSchemaRequest.create({ comparisonSchema: ONTOS_SPICEDB_SCHEMA, consistency: fullyConsistent }),
        ),
    });
    if (diff.diffs.length !== 0) {
      return yield* fail('Native schema differs from the exact canonical policy');
    }
    return yield* Effect.void;
  });
const readReviewedMemberships = (file: string, sha256: string) =>
  Effect.gen(function* readReviewed() {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs.readFile(file);
    if (hash(bytes) !== sha256) {
      return yield* fail('Reviewed membership file fingerprint mismatch');
    }
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(MembershipFileSchema))(
      Buffer.from(bytes).toString('utf-8'),
    );
    return {
      ...decoded,
      rows: decoded.rows.map((row) => ({ ...row, affiliation: Option.getOrNull(row.affiliation) })),
    };
  });
type MembershipDocument = Effect.Success<ReturnType<typeof readReviewedMemberships>>;
const readMemberships = (tx: CoreTransaction, tenantIds: readonly string[]) =>
  tx
    .select({
      affiliation: principalCompanyMemberships.affiliation,
      legalEntityId: principalCompanyMemberships.legalEntityId,
      principalId: principalCompanyMemberships.principalId,
      revision: principalCompanyMemberships.revision,
      status: principalCompanyMemberships.status,
      tenantId: principalCompanyMemberships.tenantId,
    })
    .from(principalCompanyMemberships)
    .where(inArray(principalCompanyMemberships.tenantId, tenantIds));
const validateSavedMemberships = (
  document: MembershipDocument,
  rows: Effect.Success<ReturnType<typeof readMemberships>>,
  complete: boolean,
) =>
  Effect.gen(function* validateSaved() {
    for (const saved of rows) {
      const reviewed = document.rows.find(
        (row) =>
          row.tenantId === saved.tenantId &&
          row.legalEntityId === saved.legalEntityId &&
          row.principalId === saved.principalId,
      );
      if (reviewed === undefined || saved.status !== reviewed.status || saved.affiliation !== reviewed.affiliation) {
        return yield* fail('Existing membership is extra/offboarded/reclassified; never overwrite it during cutover');
      }
    }
    if (complete && rows.length !== document.rows.length) {
      return yield* fail('SQL memberships differ from the exact reviewed target');
    }
    return yield* Effect.void;
  });
const readSqlInventory = (document: MembershipDocument, mode: 'dry-run' | 'apply' | 'verify') =>
  Effect.gen(function* sqlInventory() {
    const database = yield* CoreDatabase;
    const tenantIds = [...new Set(document.rows.map((row) => row.tenantId))];
    return yield* database.executor.transaction(
      (tx) =>
        Effect.gen(function* readOnlyInventory() {
          const actorRows = yield* tx
            .select({
              createdAt: principals.createdAt,
              kind: principals.kind,
              principalId: principals.principalId,
              status: principals.status,
              tenantId: principals.tenantId,
            })
            .from(principals)
            .where(inArray(principals.tenantId, tenantIds));
          const companyRows = yield* tx
            .select({
              legalEntityId: legalEntities.legalEntityId,
              status: legalEntities.status,
              tenantId: legalEntities.tenantId,
            })
            .from(legalEntities)
            .where(inArray(legalEntities.tenantId, tenantIds));
          const tenantRows = yield* tx
            .select({ status: tenants.status, tenantId: tenants.tenantId })
            .from(tenants)
            .where(inArray(tenants.tenantId, tenantIds));
          const present = yield* tx.execute<{ present: boolean }>(
            sql`select to_regclass('core.principal_company_memberships') is not null as present`,
            'objects',
          );
          const membershipsPresent = present[0]?.present;
          const membershipRows = membershipsPresent ? yield* readMemberships(tx, tenantIds) : [];
          if (mode !== 'dry-run' && !membershipsPresent) {
            return yield* fail('Owner migrations must create company memberships before apply/verify');
          }
          const auditRows = yield* tx.execute<{
            auditEventId: string;
            eventType: string;
            evidenceJson: unknown;
            legalEntityId: string | null;
            occurredAtEpochMicrosecondsText: string;
            outcome: string;
            tenantId: string;
          }>(
            sql`select audit_event_id as "auditEventId",event_type as "eventType",
      jsonb_strip_nulls(jsonb_build_object('actionKey',evidence_json->'actionKey','operation',evidence_json->'operation',
      'targetPrincipalId',evidence_json->'targetPrincipalId','legalEntityId',evidence_json->'legalEntityId',
      'modulesJson',evidence_json->'modulesJson','modules',evidence_json->'modules','writePolicy',evidence_json->'writePolicy',
      'revision',evidence_json->'revision','description',evidence_json->'description',
      'ownerPrincipalId',evidence_json->'ownerPrincipalId')) as "evidenceJson",legal_entity_id as "legalEntityId",
      (extract(epoch from occurred_at)*1000000)::bigint::text as "occurredAtEpochMicrosecondsText",outcome,tenant_id as "tenantId"
      from core.audit_events where event_type='action.executed' and outcome='succeeded' and evidence_json->>'actionKey'
      in ('core.identity.manage-demo-account','core.identity.configure-agent') order by occurred_at,audit_event_id`,
            'objects',
          );
          const retailEnrollments =
            mode === 'verify'
              ? yield* tx.execute<RetailEnrollment>(sql.raw(retailEnrollmentEvidenceSql), 'objects')
              : [];
          const reviewedInvitationMemberships =
            mode === 'verify'
              ? yield* tx.execute<ReviewedInvitationMembership>(
                  sql.raw(reviewedInvitationMembershipEvidenceSql),
                  'objects',
                )
              : [];
          return {
            actorRows,
            auditRows,
            companyRows,
            membershipRows,
            membershipsPresent,
            retailEnrollments,
            reviewedInvitationMemberships,
            tenantRows,
          };
        }),
      { accessMode: 'read only', isolationLevel: 'repeatable read' },
    );
  });
const planCutoverMode = 'plan-cutover';
const applyCutoverMode = 'apply-cutover';
const planReplayMode = 'plan-replay';
const applyReplayMode = 'apply-replay';
const TransitionModeSchema = Schema.Literals([
  planCutoverMode,
  applyCutoverMode,
  planReplayMode,
  applyReplayMode,
  'verify',
]);
type TransitionMode = typeof TransitionModeSchema.Type;
type SqlInventory = Effect.Success<ReturnType<typeof readSqlInventory>>;
const validateIdentityInventory = (document: MembershipDocument, inventory: SqlInventory) =>
  Effect.gen(function* validateIdentities() {
    for (const row of document.rows) {
      const actor = inventory.actorRows.find((p) => p.principalId === row.principalId && p.tenantId === row.tenantId);
      if (
        actor?.kind !== row.kind ||
        actor.status !== 'active' ||
        !inventory.companyRows.some(
          (c) => c.tenantId === row.tenantId && c.legalEntityId === row.legalEntityId && c.status === 'active',
        ) ||
        !inventory.tenantRows.some((t) => t.tenantId === row.tenantId && t.status === 'active')
      ) {
        return yield* fail('Reviewed membership no longer matches active native identity/scope');
      }
    }
    yield* validateSavedMemberships(document, inventory.membershipRows, false);
    return yield* Effect.void;
  });
const sameProfile = (
  left: {
    readonly modules: readonly { readonly access: string; readonly moduleId: string }[];
    readonly writePolicy: string;
  },
  right: {
    readonly modules: readonly { readonly access: string; readonly moduleId: string }[];
    readonly writePolicy: string;
  },
) =>
  left.writePolicy === right.writePolicy &&
  left.modules.length === right.modules.length &&
  left.modules.every((m) => right.modules.some((a) => a.moduleId === m.moduleId && a.access === m.access));
const profilesOf = (document: MembershipDocument) =>
  Effect.gen(function* reviewedProfiles() {
    const profiles: (typeof ProfileSchema.Type)[] = [];
    for (const row of document.rows) {
      const profile = row.approvedAgentProfile;
      if (row.kind === 'human') {
        if (profile !== undefined) {
          return yield* fail('Human row contains an agent profile');
        }
        continue;
      }
      if (
        profile === undefined ||
        profile.principalId !== row.principalId ||
        profile.tenantId !== row.tenantId ||
        profile.legalEntityId !== row.legalEntityId ||
        new Set(profile.modules.map((m) => m.moduleId)).size !== profile.modules.length
      ) {
        return yield* fail('Agent profile must match its exact reviewed actor/company once');
      }
      profiles.push(profile);
    }
    return profiles;
  });
const validateProfiles = (
  document: MembershipDocument,
  inventory: SqlInventory,
  relationships: PeopleModelTransitionSnapshot['relationships'],
) =>
  Effect.gen(function* profileEvidence() {
    const agents = yield* Effect.try({
      catch: (cause) => fail('Agent replay/preservation disposition differs from native evidence', cause),
      try: () =>
        reviewedTransitionReplayAgents({
          agents: inventory.actorRows
            .filter((p) => p.kind === 'agent')
            .map((p) => ({ principalId: p.principalId, tenantId: p.tenantId })),
          preservedUnadmittedAgents: document.preservedUnadmittedAgents,
          relationships,
          replayAgents: document.rows
            .filter((row) => row.kind === 'agent')
            .map((row) => ({ principalId: row.principalId, tenantId: row.tenantId })),
        }),
    });
    const events = [];
    for (const row of inventory.auditRows) {
      const at = Number(row.occurredAtEpochMicrosecondsText);
      if (!/^[0-9]+$/u.test(row.occurredAtEpochMicrosecondsText) || !Number.isSafeInteger(at)) {
        return yield* fail('Native audit ordering cannot preserve exact microseconds');
      }
      events.push({ ...row, legalEntityId: row.legalEntityId ?? undefined, occurredAtEpochMicroseconds: at });
    }
    const folded = foldAgentActionMigrationProfiles(agents, events);
    if (Result.isFailure(folded)) {
      return yield* fail('Native audited agent profile evidence is ambiguous');
    }
    const profiles = yield* profilesOf(document);
    if (
      profiles.length !== agents.length ||
      new Set(profiles.map((p) => p.principalId)).size !== agents.length ||
      agents.some((a) => !profiles.some((p) => p.principalId === a.principalId && p.tenantId === a.tenantId))
    ) {
      return yield* fail('Every native agent requires one exact approved/audited company profile');
    }
    const expectedProfiles = yield* readReviewedAgentProfiles(
      yield* Config.String('ONTOS_PEOPLE_MODEL_AGENT_PROFILES'),
      yield* Config.String('ONTOS_PEOPLE_MODEL_AGENT_PROFILES_SHA256'),
    );
    const deferred = yield* Effect.try({
      catch: (cause) => fail('Every agent must match the exact nine-profile replay review', cause),
      try: () =>
        reviewedTransitionAgentProfiles({
          agents,
          approved: expectedProfiles.profiles,
          audited: folded.success,
          profiles,
        }),
    });
    for (const profile of profiles.filter((p) => p.auditEventId !== undefined)) {
      const source = events.find((event) => event.auditEventId === profile.auditEventId);
      if (source === undefined) {
        return yield* fail('Reviewed legacy agent source audit is missing');
      }
      const sourceProfiles = foldAgentActionMigrationProfiles(agents, [source]);
      if (Result.isFailure(sourceProfiles)) {
        return yield* fail('Reviewed legacy agent source audit is ambiguous');
      }
      const actual = sourceProfiles.success.find(
        (p) =>
          p.principalId === profile.principalId &&
          p.legalEntityId === profile.legalEntityId &&
          p.tenantId === profile.tenantId,
      );
      const metadata = yield* Schema.decodeUnknownEffect(LegacyProfileMetadataSchema)(source.evidenceJson);
      if (
        actual === undefined ||
        !sameProfile(actual, profile) ||
        metadata.description !== profile.description ||
        metadata.ownerPrincipalId !== profile.ownerPrincipalId
      ) {
        return yield* fail('Legacy review provenance differs from preserved agent authority or metadata');
      }
    }
    return { deferred, expectedProfiles, profiles };
  });
const validateFixture = (
  document: MembershipDocument,
  fixture: readonly (typeof RelationshipSchema.Type)[],
  revision: string,
) =>
  Effect.gen(function* pinFixture() {
    const canonical = (rows: readonly (typeof RelationshipSchema.Type)[]) =>
      EffectArray.sortWith(
        [...new Set(rows.map((row) => v1.Relationship.toJsonString(relationship(row))))],
        (row) => row,
        Order.String,
      );
    const current = canonical(fixture);
    const reviewed = canonical(document.fixtureRelationships);
    if (
      revision !== document.compositionRevision ||
      current.length !== reviewed.length ||
      current.some((row, i) => row !== reviewed[i])
    ) {
      return yield* fail(
        'Current composition/bootstrap policy differs from the reviewed fixture; review a new artifact',
      );
    }
    return yield* Effect.void;
  });
const provisioningModeOf = (mode: TransitionMode) => {
  if (mode === applyCutoverMode) {
    return 'apply';
  }
  return mode === planCutoverMode ? 'dry-run' : 'verify';
};
/** The read-only inventory transaction commits before any graph request or operator authentication. */
const prepare = Effect.fn('PeopleModelTransition.prepare')(function* prepareTransition(
  file: string,
  sha256: string,
  mode: TransitionMode,
) {
  const document = yield* readReviewedMemberships(file, sha256);
  const provisioningMode = provisioningModeOf(mode);
  const inventory = yield* readSqlInventory(document, provisioningMode);
  yield* validateIdentityInventory(document, inventory);
  const configuration = yield* loadSpiceDbConfig();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${configuration.endpoint}`).hostname)) {
    return yield* fail('Only loopback graph cutover is allowed');
  }
  const client = yield* Effect.acquireRelease(
    Effect.try({
      catch: (cause) => fail('Cannot open local graph', cause),
      try: () => newSpiceDbGrpcClient(configuration),
    }),
    (value) => Effect.sync(() => value.close()),
  );
  const observed = yield* readGraph(client);
  const { deferred, expectedProfiles, profiles } = yield* validateProfiles(document, inventory, observed.relationships);
  const tenantIds = [...new Set(document.rows.map((row) => row.tenantId))];
  const composition = yield* loadCurrentActionAuthorizationComposition(tenantIds, provisioningMode);
  const fixture = yield* peopleModelTransitionFixtureRelationships(composition.actions, document.rows, {
    companies: composition.companies,
    moduleStates: composition.moduleStates,
    publishedModuleKeys: composition.snapshot.composition.modules.map(({ moduleId }) => moduleId),
  });
  yield* validateFixture(
    document,
    fixture,
    mode === planCutoverMode || mode === applyCutoverMode
      ? composition.snapshot.composition.revision
      : document.compositionRevision,
  );
  const catalog = yield* buildApplicationCompositionCatalog(composition.snapshot.composition);
  const agentRelationships = yield* Effect.forEach(
    profiles,
    (profile) =>
      Effect.gen(function* companyAgentPolicy() {
        const scope = composition.installedModuleScopes.find(
          (item) => item.tenantId === profile.tenantId && item.legalEntityId === profile.legalEntityId,
        );
        if (scope === undefined) {
          return yield* fail('Reviewed agent company has no active installed composition scope');
        }
        const namedPermissions = reviewedTransitionAgentNamedPermissions(fixture, profile);
        const desired = currentAgentProfileRelationships({
          catalog,
          company: { active: true, legalEntityId: profile.legalEntityId, profile },
          installedModuleKeys: new Set(scope.moduleKeys),
          namedPermissions,
          principalId: profile.principalId,
          tenantId: profile.tenantId,
        });
        return [
          ...desired,
          ...agentNamedPermissionScopeRelationships({ ...profile, currentPrincipalRelationships: [], desired }),
        ];
      }),
    { concurrency: 1 },
  );
  const actions = deriveScopedActionAuthorization(composition.actions, composition.installedModuleScopes);
  const reviewedPrincipalIds = new Set(document.rows.map((row) => row.principalId));
  const principalStructure = inventory.actorRows
    .filter((actor) => reviewedPrincipalIds.has(actor.principalId))
    .flatMap((actor) =>
      buildPrincipalSelfCredentialUpdates({
        ...actor,
        tenantActive: inventory.tenantRows.some(
          (tenant) => tenant.tenantId === actor.tenantId && tenant.status === 'active',
        ),
      }),
    )
    .flatMap((update) =>
      update.operation === v1.RelationshipUpdate_Operation.TOUCH && update.relationship !== undefined
        ? [update.relationship]
        : [],
    );
  const desired = [
    ...principalStructure,
    ...fixture.map(relationship),
    ...agentRelationships.flat(),
    ...buildActionAuthorizationRelationships(actions),
    ...buildIntrinsicSelfCredentialRelationships(composition.actions, actions),
  ];
  yield* validateProfiles(document, inventory, [...observed.relationships, ...desired]);
  const sqlState = yield* encodeMembershipState(
    EffectArray.sortWith(
      inventory.membershipRows.map((row) => ({ ...row, affiliation: Option.fromNullishOr(row.affiliation) })),
      (row) => `${row.tenantId}:${row.legalEntityId}:${row.principalId}`,
      Order.String,
    ),
  );
  const input: PeopleModelTransitionInput = {
    compositionRevision: composition.snapshot.composition.revision,
    deferredAgentPrincipalIds: deferred.map((p) => p.principalId),
    desired,
    memberships: document.rows,
    observed,
    reviewedInputSha256: hash(`${sha256}:${sqlState}:${configuration.endpoint}`),
    technicalPrincipalIds: inventory.actorRows
      .filter((p) => p.kind === 'service' || p.kind === 'integration' || p.kind === 'system')
      .map((p) => p.principalId),
  };
  return {
    authorityPhase: composition.authorityPhase,
    client,
    document,
    expectedProfiles,
    input,
    inventory,
    membershipsPresent: inventory.membershipsPresent,
  };
});
type PreparedTransition = Effect.Success<ReturnType<typeof prepare>>;
const installMemberships = (ready: PreparedTransition) =>
  Effect.gen(function* installReviewedMemberships() {
    const database = yield* CoreDatabase;
    for (const tenantId of new Set(ready.document.rows.map((row) => row.tenantId))) {
      const rows = yield* Effect.forEach(
        ready.document.rows.filter((row) => row.tenantId === tenantId),
        (row) =>
          Schema.decodeEffect(BootstrapCompanyMembershipSchema)({
            affiliation: row.affiliation,
            legalEntityId: row.legalEntityId,
            principalId: row.principalId,
          }),
        { concurrency: 1 },
      );
      yield* database.executor.transaction((tx) => installBootstrapCompanyMemberships(tx, tenantId, rows));
    }
  });
const nativeAuditedReplay = (ready: PreparedTransition) =>
  Effect.gen(function* replayProfiles() {
    const session = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (value) =>
      value.close.pipe(Effect.ignore),
    );
    const inputs = yield* reviewedProfileInputs(ready.expectedProfiles);
    yield* runAgentProfileSetup(
      session.principal,
      inputs,
      'apply',
      yield* Config.String('ONTOS_PEOPLE_MODEL_AGENT_PROFILES_SHA256'),
    );
  }).pipe(
    Effect.mapError((cause) =>
      fail(
        Match.value(cause).pipe(
          Match.tag(
            'AgentProfileSetupError',
            (failure) =>
              `Native audited nine-agent replay failed: ${failure.reason}; external traffic must remain stopped`,
          ),
          Match.tag(
            'OperationContextUnavailable',
            (failure) =>
              `Native audited nine-agent replay failed: ${failure.reason}; external traffic must remain stopped`,
          ),
          Match.orElse(
            (failure) =>
              `Native audited nine-agent replay failed (${failure._tag}); external traffic must remain stopped`,
          ),
        ),
        cause,
      ),
    ),
  );
const StageArtifactSchema = Schema.Struct({
  cutoverFingerprint: Schema.String,
  deferredRelationships: Schema.Array(Schema.String),
  expectedRelationships: Schema.Array(Schema.String),
  initialCompositionRevision: Schema.String,
  reviewedInputSha256: Schema.String,
  schemaVersion: Schema.Literal(1),
});
const encodeStageArtifact = Schema.encodeEffect(Schema.fromJsonString(StageArtifactSchema));
const readStageArtifact = (file: string, expectedSha: Option.Option<string>, reviewedSha: string) =>
  Effect.gen(function* readStage() {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs.readFile(file);
    if (Option.isNone(expectedSha) || hash(bytes) !== expectedSha.value) {
      return yield* fail('An exact reviewed sealed-stage artifact SHA is required');
    }
    const artifact = yield* Schema.decodeEffect(Schema.fromJsonString(StageArtifactSchema))(
      Buffer.from(bytes).toString('utf-8'),
    );
    if (artifact.reviewedInputSha256 !== reviewedSha) {
      return yield* fail('Sealed target is bound to different reviewed membership bytes');
    }
    const expected = yield* Effect.try({
      catch: (cause) => fail('Invalid native relationships in sealed-stage target', cause),
      try: () => artifact.expectedRelationships.map((row) => v1.Relationship.fromJsonString(row)),
    });
    return { artifact, expected, sha: hash(bytes) };
  });
type Plan = ReturnType<typeof planPeopleModelTransition>;
const writeStageArtifact = (file: string, sha: string, ready: PreparedTransition, plan: Plan) =>
  Effect.gen(function* writeStage() {
    const fs = yield* FileSystem.FileSystem;
    const deferredRoles = new Set(
      ready.document.rows
        .filter((row) => ready.input.deferredAgentPrincipalIds.includes(row.principalId))
        .flatMap((row) => row.scopedRoles.map(toScopedRoleObjectId)),
    );
    const text = yield* encodeStageArtifact({
      cutoverFingerprint: plan.fingerprint,
      deferredRelationships: plan.expected
        .filter((r) => r.subject?.object?.objectType === 'scoped_role' && deferredRoles.has(r.subject.object.objectId))
        .map((r) => v1.Relationship.toJsonString(r)),
      expectedRelationships: plan.expected.map((r) => v1.Relationship.toJsonString(r)),
      initialCompositionRevision: ready.input.compositionRevision,
      reviewedInputSha256: sha,
      schemaVersion: 1,
    });
    yield* fs.writeFileString(file, text, { flag: 'wx', mode: 0o600 });
    return hash(text);
  });
const graphClient = (ready: PreparedTransition) => ({
  snapshot: readGraph(ready.client),
  writeRelationships: (request: v1.WriteRelationshipsRequest) => writeRelationships(ready.client, request),
  writeSchema: (request: v1.WriteSchemaRequest) => writeSchema(ready.client, request),
});
const applySealedCutover = (ready: PreparedTransition, plan: Plan) =>
  Effect.gen(function* applySealed() {
    yield* installMemberships(ready);
    yield* applyPeopleModelTransitionSealedGraph(graphClient(ready), ready.input, plan.fingerprint);
  });
const verifySqlTarget = (ready: PreparedTransition) =>
  Effect.gen(function* exactSqlTarget() {
    const finalInventory = yield* readSqlInventory(ready.document, 'verify');
    yield* validateIdentityInventory(ready.document, finalInventory);
    return yield* validateSavedMemberships(ready.document, finalInventory.membershipRows, true);
  });
interface TransitionArguments {
  readonly file: string;
  readonly mode: TransitionMode;
  readonly planSha256: Option.Option<string>;
  readonly sha256: string;
  readonly stageFile: string;
  readonly stageSha256: Option.Option<string>;
}
const requireFingerprint = (actual: string, supplied: Option.Option<string>) =>
  Option.contains(supplied, actual)
    ? Effect.void
    : Effect.fail(fail('Apply requires the exact reviewed stage plan SHA; no writes performed'));
const verifyGraph = (plan: Plan, expected: readonly v1.Relationship[], actual: readonly v1.Relationship[]) =>
  Effect.try({
    catch: (cause) => fail('Exact reviewed graph or preserved evidence differs; keep external traffic stopped', cause),
    try: () => verifyPeopleModelTransitionGraph({ ...plan, expected }, actual),
  });
const replayStage = (args: TransitionArguments, ready: PreparedTransition, plan: Plan) =>
  Effect.gen(function* publishedReplay() {
    const stage = yield* readStageArtifact(args.stageFile, args.stageSha256, args.sha256);
    if (
      ready.authorityPhase !== 'active' ||
      ready.input.compositionRevision === stage.artifact.initialCompositionRevision
    ) {
      return yield* fail('Native replacement publication must activate a genuinely new composition before replay');
    }
    yield* verifySchema(ready.client);
    yield* verifySqlTarget(ready);
    const fs = yield* FileSystem.FileSystem;
    const inventoryBytes = yield* fs.readFileString(yield* Config.String('ONTOS_PEOPLE_MODEL_REVIEWED_INVENTORY'));
    if (hash(inventoryBytes) !== reviewedPeopleInventorySha256) {
      return yield* fail('Replay requires the exact reviewed SQL inventory SHA');
    }
    const baseline = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewedPeopleInventorySchema))(
      inventoryBytes,
    );
    const extraRelationships = yield* admitPostBaselineRelationships({
      actual: plan.expected,
      baseline,
      enrollments: ready.inventory.retailEnrollments,
      principals: ready.inventory.actorRows,
      reviewedInvitationMemberships: ready.inventory.reviewedInvitationMemberships,
      sealed: stage.expected,
    });
    const replayExpected = [...stage.expected, ...extraRelationships];
    yield* verifyGraph(plan, replayExpected, plan.expected);
    const deferred = new Set(stage.artifact.deferredRelationships);
    const actual = ready.input.observed.relationships;
    const initial = replayExpected.filter(
      (row) =>
        !deferred.has(v1.Relationship.toJsonString(row)) ||
        actual.some((r) => v1.Relationship.toJsonString(r) === v1.Relationship.toJsonString(row)),
    );
    // Partial native replay retries require a fresh stage review; only an exact subset of deferred target is admissible.
    yield* verifyGraph(plan, initial, actual);
    const fingerprint = hash(`people-model-replay-v1:${stage.sha}:${plan.fingerprint}`);
    if (args.mode === applyReplayMode) {
      yield* requireFingerprint(fingerprint, args.planSha256);
      const fresh = yield* readGraph(ready.client);
      yield* verifyGraph(plan, actual, fresh.relationships);
      yield* nativeAuditedReplay(ready);
    }
    if (args.mode === 'verify' || args.mode === applyReplayMode) {
      yield* verifyGraph(plan, replayExpected, (yield* readGraph(ready.client)).relationships);
      yield* verifySqlTarget(ready);
      const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (value) =>
        value.close.pipe(Effect.ignore),
      );
      yield* runAgentProfileSetup(
        operator.principal,
        yield* reviewedProfileInputs(ready.expectedProfiles),
        'verify',
        yield* Config.String('ONTOS_PEOPLE_MODEL_AGENT_PROFILES_SHA256'),
      );
    }
    return { fingerprint, stageSha256: stage.sha };
  });
const runStage = (args: TransitionArguments) =>
  Effect.gen(function* reviewedStage() {
    const ready = yield* prepare(args.file, args.sha256, args.mode);
    const plan = yield* Effect.try({
      catch: (cause) => fail('Reviewed transition plan was rejected', cause),
      try: () => planPeopleModelTransition(ready.input),
    });
    let { fingerprint } = plan;
    let stageSha256: string | undefined;
    if (args.mode === applyCutoverMode) {
      yield* requireFingerprint(fingerprint, args.planSha256);
      stageSha256 = yield* writeStageArtifact(args.stageFile, args.sha256, ready, plan);
      yield* applySealedCutover(ready, plan);
      yield* verifySchema(ready.client);
      yield* verifySqlTarget(ready);
    } else if (args.mode !== planCutoverMode) {
      ({ fingerprint, stageSha256 } = yield* replayStage(args, ready, plan));
    }
    yield* Console.log({
      additions: plan.additions.length,
      deletions: plan.deletions.length,
      fingerprint,
      legacyBlanketExecutors: plan.legacyBlanketExecutors,
      memberships: plan.memberships.length,
      membershipsPresent: ready.membershipsPresent,
      mode: args.mode,
      preservedRecordGrants: plan.preservedRecordGrants,
      stageSha256,
    });
  });
const program = (args: TransitionArguments) =>
  Effect.gen(function* transition() {
    const databaseUrl = yield* Config.Redacted('DATABASE_ADMIN_URL');
    const url = new URL(Redacted.value(databaseUrl));
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.port.length === 0 ||
      /_preserved_|archive/iu.test(url.pathname)
    ) {
      return yield* fail('Only the local loopback non-archive database is allowed');
    }
    if (
      (args.mode === applyCutoverMode || args.mode === applyReplayMode) &&
      (yield* Config.String('ONTOS_PEOPLE_MODEL_TARGET_DATABASE')) !== decodeURIComponent(url.pathname.slice(1))
    ) {
      return yield* fail('Apply requires an explicitly selected exact target database');
    }
    return yield* withPostgresSessionAdvisoryLock(
      databaseUrl,
      'ontos.people-model-cutover',
      args.mode === applyCutoverMode
        ? Effect.gen(function* nativeSealedTransition() {
            const ready = yield* prepare(args.file, args.sha256, planCutoverMode);
            const plan = yield* Effect.try({
              catch: (cause) => fail('Reviewed transition preflight was rejected', cause),
              try: () => planPeopleModelTransition(ready.input),
            });
            yield* requireFingerprint(plan.fingerprint, args.planSha256);
            return yield* runApplicationCompositionMigration(
              runStage(args),
              Effect.fail(fail('Legacy transition requires an existing native composition authority')),
            );
          })
        : withApplicationCompositionPublicationLock(runStage(args)),
    );
  }).pipe(Effect.scoped);

const composition = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(ActiveApplicationCompositionSourceLive),
  Layer.provide(FetchHttpClient.layer),
);
const live = Layer.mergeAll(
  AgentProfileOperatorLive,
  CoreAdminDatabaseLive,
  composition,
  NodeServices.layer,
  Reactivity.layer,
);
const safeExecutableFailure = (error: Effect.Error<ReturnType<typeof program>>) =>
  new Error(
    Schema.is(PeopleModelTransitionError)(error)
      ? error.reason
      : `Local transition failed (${error._tag}); admission must remain sealed`,
  );
const command = Command.make(
  'transition-people-model',
  {
    file: Flag.String('file'),
    mode: Flag.Literals('mode', TransitionModeSchema.literals).pipe(Flag.withDefault(planCutoverMode)),
    planSha256: Flag.String('plan-sha256').pipe(Flag.optional),
    sha256: Flag.String('sha256'),
    stageFile: Flag.String('stage-file'),
    stageSha256: Flag.String('stage-sha256').pipe(Flag.optional),
  },
  (args) => program(args).pipe(Effect.mapError(safeExecutableFailure)),
).pipe(Command.provide(live));
if (import.meta.main) {
  await Effect.runPromise(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}
