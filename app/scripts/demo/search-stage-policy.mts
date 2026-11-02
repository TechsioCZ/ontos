#!/usr/bin/env node
/**
 * Post-deploy STAGE operator. Plan and verify only read SpiceDB; apply creates reviewed missing executor grants.
 * Native helpers supply exact Action installation links; existing installers own role membership.
 * Owning Actions still check their business permissions.
 * No schema publication, identity/data reset, module access, reader or context-permission writes.
 */
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  Array as EffectArray,
  Config,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Order,
  Redacted,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { Hex } from 'effect/encoding';
import { FetchHttpClient } from 'effect/http';

import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { fromScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import type { SpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-rpc.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { ActionProvisioningIntentSchema } from '../../packages/core-runtime/src/authorization/entrypoint-classification.ts';
import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from './fixture-ids.mts';
import type { DemoAction, DemoRelationship } from './permissions.mts';
import {
  agentBotPrincipal,
  companyPermissionRelationships,
  demoHumanAccounts,
  demoRoles,
  principalRelationships,
  rentalPermissionRelationships,
  scopedDemoActionRelationships,
  tenantAdministratorCrmRelationships,
} from './permissions.mts';

export class SearchStagePolicyError extends Schema.TaggedError<SearchStagePolicyError>()('SearchStagePolicyError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new SearchStagePolicyError({ reason });
const origin = 'https://ontos-stage.web-revolution.cz';
const peopleAction = 'core.identity.request-people-search-rebuild';
const partyAction = 'party.registry.request-search-rebuild';
const rebuildDescriptors: readonly DemoAction[] = [
  {
    actionKey: peopleAction,
    legalEntityScope: 'forbidden',
    owningModuleKey: 'core.identity',
    provisioning: 'explicit',
  },
  {
    actionKey: partyAction,
    legalEntityScope: 'optional',
    owningModuleKey: 'party.registry',
    provisioning: 'tenant_membership_default',
  },
  ...[
    'demo.crm',
    'demo.sales-pipeline',
    'demo.merchandise',
    'work.tasks',
    'finance.billing',
    'legal.agreements',
    'facility.operations',
    'commerce.market-catalog',
  ].map((owningModuleKey): DemoAction => ({
    actionKey: `${owningModuleKey}.request-search-rebuild`,
    legalEntityScope: 'optional',
    owningModuleKey,
    provisioning: 'explicit',
  })),
  ...['property.portfolio', 'property.leasing'].map((owningModuleKey): DemoAction => ({
    actionKey: `${owningModuleKey}.request-search-rebuild`,
    legalEntityScope: 'required',
    owningModuleKey,
    provisioning: 'explicit',
  })),
];
// Synthetic negative controls are never provisioned or treated as real operator identities.
const negativePrincipalId = demoId('core.principal', 'search-stage-policy-negative-control');
const negativeTenantId = demoId('core.tenant', 'search-stage-policy-negative-control');
const modes = ['plan', 'apply', 'verify'] as const;
const companies = [
  demoLegalEntityId,
  rentalDemoLegalEntityId,
  crmDemoLegalEntityId,
  eshopDemoLegalEntityId,
  akrosDemoLegalEntityId,
];
const consistent = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });
const hash = (text: string) => Hex.encode(sha256(utf8ToBytes(text)));
const encoded = (relationship: v1.Relationship) => v1.Relationship.toJsonString(relationship);
const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);
const native = (item: DemoRelationship) =>
  v1.Relationship.create({
    relation: item.relation,
    resource: { objectId: item.resourceId, objectType: item.resourceType },
    subject: {
      object: { objectId: item.subjectId, objectType: item.subjectType },
      optionalRelation: item.subjectRelation ?? '',
    },
  });
const unique = (items: readonly v1.Relationship[]) =>
  EffectArray.sortWith(
    [...new Map(items.map((item) => [encoded(item), item])).entries()],
    ([key]) => key,
    Order.String,
  ).map(([, item]) => item);

/** Select only current published descriptors; a suffix is not sufficient authority for an unknown owner or scope. */
export const searchRebuildActions = (actions: readonly DemoAction[]) =>
  Effect.gen(function* selectRebuildActions() {
    const selected = actions.filter(
      ({ actionKey }) =>
        actionKey.endsWith('.request-search-rebuild') || actionKey.endsWith('.request-people-search-rebuild'),
    );
    if (
      selected.length === 0 ||
      new Set(selected.map(({ actionKey }) => actionKey)).size !== selected.length ||
      selected.some((action) => {
        const descriptor = rebuildDescriptors.find(({ actionKey }) => actionKey === action.actionKey);
        return (
          descriptor === undefined ||
          action.provisioning !== descriptor.provisioning ||
          action.owningModuleKey !== descriptor.owningModuleKey ||
          action.legalEntityScope !== descriptor.legalEntityScope
        );
      })
    ) {
      return yield* fail('Missing rebuilds or unknown/invalid rebuild owner, Action, scope or provisioning');
    }
    // Party's existing tenant-membership policy is already installed. Never replace it with explicit grants.
    return EffectArray.sortWith(
      selected.filter(({ actionKey }) => actionKey !== partyAction),
      ({ actionKey }) => actionKey,
      Order.String,
    );
  });

const ObjectId = Schema.String.pipe(Schema.brand('SearchStageActionObjectId'));
const PrincipalId = Schema.String.pipe(Schema.brand('SearchStagePrincipalId'));
const ProbeSchema = Schema.Struct({
  negativeControl: Schema.Boolean,
  objectId: Schema.toEncoded(ObjectId),
  principalId: Schema.toEncoded(PrincipalId),
});
const sameProbes = (left: readonly (typeof ProbeSchema.Type)[], right: readonly (typeof ProbeSchema.Type)[]) =>
  left.length === right.length &&
  left.every(
    (item, index) =>
      item.objectId === right[index]?.objectId &&
      item.principalId === right[index]?.principalId &&
      item.negativeControl === right[index]?.negativeControl,
  );
const ActionSchema = Schema.Struct({
  actionKey: Schema.toEncoded(Schema.String.pipe(Schema.brand('SearchStageActionKey'))),
  legalEntityScope: Schema.Literals(['required', 'optional', 'forbidden']),
  owningModuleKey: Schema.toEncoded(Schema.String.pipe(Schema.brand('SearchStageModuleKey'))),
  provisioning: ActionProvisioningIntentSchema,
});
const CheckSchema = Schema.Struct({ ...ProbeSchema.fields, before: Schema.Boolean, expected: Schema.Boolean });
const SourceSchema = Schema.Struct({
  actions: Schema.Array(Schema.String),
  desired: Schema.Array(Schema.String),
  prerequisites: Schema.Array(Schema.String),
  probes: Schema.Array(ProbeSchema),
});
type Source = typeof SourceSchema.Type;
export type SearchStageRpc = Pick<
  SpiceDbRpc,
  'checkPermission' | 'diffSchema' | 'readSchema' | 'readRelationships' | 'writeRelationships'
>;

const actionScopes = (action: DemoAction) => [
  ...(action.legalEntityScope === 'forbidden'
    ? [{ actionKey: action.actionKey, tenantId: demoTenantId }]
    : companies.map((legalEntityId) => ({ actionKey: action.actionKey, legalEntityId, tenantId: demoTenantId }))),
  { actionKey: action.actionKey, tenantId: negativeTenantId },
];
const probesFor = (action: DemoAction, principalIds: readonly string[]) =>
  actionScopes(action).flatMap((scope) =>
    principalIds.map((principalId) => ({
      negativeControl: scope.tenantId === negativeTenantId || principalId === negativePrincipalId,
      objectId: toSpiceDbActionObjectId(scope),
      principalId,
    })),
  );

/** Native demo helpers own executor role policy and exact Action scope/grant links, never read privileges. */
export const searchStageSource = (catalog: readonly DemoAction[]) =>
  Effect.gen(function* deriveSearchStageSource() {
    const actions = yield* searchRebuildActions(catalog);
    const moduleActions = actions.filter(({ actionKey }) => actionKey !== peopleAction);
    const base = [
      ...demoHumanAccounts.flatMap((account) =>
        principalRelationships(account.principalId, demoRoles[account.role], moduleActions),
      ),
      ...principalRelationships(agentBotPrincipal.principalId, demoRoles[agentBotPrincipal.role], moduleActions),
      ...rentalPermissionRelationships(moduleActions),
      ...companyPermissionRelationships(moduleActions),
      ...tenantAdministratorCrmRelationships(moduleActions),
    ];
    // Derive tenant administrators from the source role's actual superadmin membership, never email or array position.
    const administrators = base.filter(
      (item) =>
        item.resourceType === 'tenant' &&
        item.resourceId === demoTenantId &&
        item.relation === 'superadmin' &&
        item.subjectType === 'scoped_role' &&
        item.subjectRelation === 'member',
    );
    const core = actions.find(({ actionKey }) => actionKey === peopleAction);
    if (core !== undefined && administrators.length === 0) {
      return yield* fail('The current policy has no explicit tenant administrator membership for Core rebuild');
    }
    const people: DemoRelationship[] = [];
    for (const administrator of administrators) {
      if (core === undefined) {
        continue;
      }
      const role = fromScopedRoleObjectId(administrator.subjectId);
      if (Option.isNone(role) || role.value.tenantId !== demoTenantId || role.value.legalEntityId !== undefined) {
        return yield* fail('Tenant administrator source role is not tenant-scoped');
      }
      const members = base.filter(
        (item) =>
          item.resourceType === 'scoped_role' &&
          item.resourceId === administrator.subjectId &&
          item.relation === 'member' &&
          item.subjectType === 'principal' &&
          item.subjectRelation === undefined,
      );
      if (members.length === 0) {
        return yield* fail('Tenant administrator source role has no declared principal membership');
      }
      for (const member of members) {
        people.push(
          ...scopedDemoActionRelationships(member.subjectId, core, demoLegalEntityId, demoTenantId, role.value.roleKey),
        );
      }
    }
    const policy = [...base, ...people];
    const desired = unique(
      policy
        .filter(
          (item) =>
            (item.resourceType === 'action' && ['company_scope', 'tenant_scope', 'grant'].includes(item.relation)) ||
            (item.resourceType === 'action_grant' && item.relation === 'role'),
        )
        .map(native),
    );
    if (desired.length === 0) {
      return yield* fail('The current source policy produced no rebuild executor grants');
    }
    // Canonical Action scope links also inherit existing company/tenant administration.
    // These are read-only proofs, not additional memberships or administrative grants.
    const administrativeLinks = policy.filter(
      (item) =>
        administrators.includes(item) ||
        (item.resourceType === 'legal_entity' &&
          item.relation === 'admin' &&
          desired.some(
            (edge) => edge.relation === 'company_scope' && edge.subject?.object?.objectId === item.resourceId,
          )),
    );
    const roles = new Set([
      ...desired.filter((item) => item.relation === 'role').map((item) => item.subject?.object?.objectId),
      ...administrativeLinks.map((item) => item.subjectId),
    ]);
    const prerequisites = unique(
      policy
        .filter(
          (item) =>
            (item.resourceType === 'scoped_role' && roles.has(item.resourceId) && item.relation === 'member') ||
            administrativeLinks.includes(item),
        )
        .map(native),
    );
    const principalIds = EffectArray.sort(
      [
        ...new Set(base.filter((item) => item.resourceType === 'scoped_role').map((item) => item.subjectId)),
        negativePrincipalId,
      ],
      Order.String,
    );
    const probes = actions.flatMap((action) => probesFor(action, principalIds));
    const encodedActions = yield* Schema.encodeEffect(Schema.Array(Schema.fromJsonString(ActionSchema)))(actions);
    return {
      actions: encodedActions,
      desired: desired.map(encoded),
      prerequisites: prerequisites.map(encoded),
      probes,
    } satisfies Source;
  });

const PlanSchema = Schema.Struct({
  ...SourceSchema.fields,
  checks: Schema.Array(CheckSchema),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  environment: Schema.Literal('stage'),
  liveSchemaSha256: Schema.String,
  missing: Schema.Array(Schema.String),
  missingPrerequisites: Schema.Array(Schema.String),
  origin: Schema.Literal(origin),
  schemaDiffKinds: Schema.Array(Schema.String),
  schemaSha256: Schema.String,
  tenantId: Schema.Literal(demoTenantId),
  version: Schema.Literal(1),
});
type Plan = typeof PlanSchema.Type;
const planJson = Schema.fromJsonString(PlanSchema);
export const searchStagePlanDigest = (plan: Plan) => Schema.encodeEffect(planJson)(plan).pipe(Effect.map(hash));
export const decodeSearchStagePlan = Schema.decodeUnknownEffect(planJson, { onExcessProperty: 'error' });
const relations = (items: readonly string[]) =>
  Effect.try({
    catch: () => fail('Invalid native relationship in reviewed policy'),
    try: () => items.map((item) => v1.Relationship.fromJsonString(item)),
  });

const filterFor = (relationship: v1.Relationship): Effect.Effect<v1.RelationshipFilter, SearchStagePolicyError> => {
  const { resource } = relationship;
  const subject = relationship.subject?.object;
  if (
    resource === undefined ||
    subject === undefined ||
    resource.objectId === '' ||
    subject.objectId === '' ||
    resource.objectType === '' ||
    subject.objectType === '' ||
    relationship.relation === ''
  ) {
    return Effect.fail(fail('Refusing an unscoped authorization relationship read'));
  }
  return Effect.succeed(
    v1.RelationshipFilter.create({
      optionalRelation: relationship.relation,
      optionalResourceId: resource.objectId,
      optionalSubjectFilter: {
        optionalRelation: { relation: relationship.subject?.optionalRelation ?? '' },
        optionalSubjectId: subject.objectId,
        subjectType: subject.objectType,
      },
      resourceType: resource.objectType,
    }),
  );
};

/** Exact tuple reads only. Never replace conditional/expiring grants with unconditional authority. */
const missingRelationships = (rpc: SearchStageRpc, desired: readonly v1.Relationship[]) =>
  Effect.forEach(
    desired,
    (relationship) =>
      filterFor(relationship).pipe(
        Effect.flatMap((filter) =>
          rpc.readRelationships(
            v1.ReadRelationshipsRequest.create({
              consistency: consistent,
              optionalLimit: 2,
              relationshipFilter: filter,
            }),
          ),
        ),
        Effect.flatMap((rows) => {
          if (
            rows.length > 1 ||
            rows.some(
              (row) =>
                row.relationship === undefined ||
                row.relationship.optionalCaveat !== undefined ||
                row.relationship.optionalExpiresAt !== undefined ||
                encoded(row.relationship) !== encoded(relationship),
            )
          ) {
            return Effect.fail(fail('Conditional, expiring or unverifiable authorization evidence; no grants changed'));
          }
          return Effect.succeed(rows.length === 0 ? [relationship] : []);
        }),
      ),
    { concurrency: 8 },
  ).pipe(Effect.map((items) => items.flat()));

const readSchema = (rpc: SearchStageRpc) =>
  Effect.gen(function* readCanonicalSchemaEvidence() {
    const live = yield* rpc.readSchema(v1.ReadSchemaRequest.create({}));
    if (live.readAt === undefined || live.readAt.token === '') {
      return yield* fail('Schema read has no verifiable revision');
    }
    const diff = yield* rpc.diffSchema(
      v1.DiffSchemaRequest.create({
        comparisonSchema: ONTOS_SPICEDB_SCHEMA,
        consistency: { requirement: { atExactSnapshot: live.readAt, oneofKind: 'atExactSnapshot' } },
      }),
    );
    return {
      liveSchemaSha256: hash(live.schemaText),
      schemaDiffKinds: EffectArray.sort(
        diff.diffs.map(({ diff: item }) => item.oneofKind ?? 'unknown'),
        Order.String,
      ),
      schemaSha256: hash(ONTOS_SPICEDB_SCHEMA),
    };
  });

const decisions = (rpc: SearchStageRpc, probes: readonly (typeof ProbeSchema.Type)[]) =>
  Effect.forEach(
    probes,
    (probe) =>
      rpc
        .checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: consistent,
            permission: 'execute',
            resource: { objectId: probe.objectId, objectType: 'action' },
            subject: { object: { objectId: probe.principalId, objectType: 'principal' } },
          }),
        )
        .pipe(
          Effect.flatMap(({ permissionship }) => {
            if (
              permissionship !== v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION &&
              permissionship !== v1.CheckPermissionResponse_Permissionship.NO_PERMISSION
            ) {
              return Effect.fail(fail('Indeterminate executor permission evidence'));
            }
            return Effect.succeed(permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION);
          }),
        ),
    { concurrency: 8 },
  );

const receivesGrant = (probe: typeof ProbeSchema.Type, policy: readonly v1.Relationship[]) => {
  const grants = policy.filter((item) => item.resource?.objectId === probe.objectId && item.relation === 'grant');
  const scopes = policy.filter(
    (item) =>
      item.resource?.objectId === probe.objectId &&
      (item.relation === 'company_scope' || item.relation === 'tenant_scope'),
  );
  const administration = policy.filter(
    (item) =>
      (item.resource?.objectType === 'tenant' &&
        item.resource.objectId === demoTenantId &&
        item.relation === 'superadmin' &&
        scopes.length > 0) ||
      (item.relation === 'admin' &&
        scopes.some(
          (scope) =>
            scope.subject?.object?.objectType === item.resource?.objectType &&
            scope.subject?.object?.objectId === item.resource?.objectId,
        )),
  );
  const roles = policy.filter(
    (item) =>
      item.relation === 'role' && grants.some((grant) => grant.subject?.object?.objectId === item.resource?.objectId),
  );
  const allowedRoles = [...roles, ...administration];
  return policy.some(
    (item) =>
      item.resource?.objectType === 'scoped_role' &&
      item.relation === 'member' &&
      item.subject?.object?.objectId === probe.principalId &&
      allowedRoles.some((role) => role.subject?.object?.objectId === item.resource?.objectId),
  );
};

export const planSearchStagePolicy = (rpc: SearchStageRpc, source: Source, compositionRevision: string) =>
  Effect.gen(function* planSearchPolicy() {
    const desired = yield* relations(source.desired);
    const prerequisites = yield* relations(source.prerequisites);
    const missing = yield* missingRelationships(rpc, desired);
    const missingPrerequisites = yield* missingRelationships(rpc, prerequisites);
    const schema = yield* readSchema(rpc);
    const before = yield* decisions(rpc, source.probes);
    if (source.probes.some((probe, index) => probe.negativeControl && before[index])) {
      return yield* fail('A negative-control principal or foreign tenant unexpectedly has executor authority');
    }
    const policy = [...desired, ...prerequisites];
    return {
      ...source,
      ...schema,
      checks: source.probes.map((probe, index) => ({
        ...probe,
        before: before[index] ?? false,
        expected: (before[index] ?? false) || receivesGrant(probe, policy),
      })),
      compositionRevision,
      environment: 'stage',
      missing: missing.map(encoded),
      missingPrerequisites: missingPrerequisites.map(encoded),
      origin,
      tenantId: demoTenantId,
      version: 1,
    } satisfies Plan;
  });

export const assertReviewedSearchStagePlan = (
  plan: Plan,
  source: Source,
  compositionRevision: string,
  reviewed: Option.Option<string>,
) =>
  Effect.gen(function* assertReviewedPlan() {
    const digest = yield* searchStagePlanDigest(plan);
    if (
      Option.isNone(reviewed) ||
      reviewed.value !== digest ||
      plan.compositionRevision !== compositionRevision ||
      !same(plan.actions, source.actions) ||
      !same(plan.desired, source.desired) ||
      !same(plan.prerequisites, source.prerequisites) ||
      !sameProbes(plan.probes, source.probes) ||
      !sameProbes(plan.checks, source.probes) ||
      plan.checks.some((check) => check.negativeControl && (check.before || check.expected)) ||
      plan.missing.some((item) => !plan.desired.includes(item))
    ) {
      return yield* fail('Exact reviewed plan digest, current source policy and deployed composition are required');
    }
    return digest;
  });

/** Apply only the reviewed missing set, atomically CREATE with existing prerequisite and absence preconditions. */
export const runSearchStagePolicy = (
  rpc: SearchStageRpc,
  mode: 'apply' | 'verify',
  plan: Plan,
  source: Source,
  compositionRevision: string,
  reviewed: Option.Option<string>,
) =>
  Effect.gen(function* reconcileSearchPolicy() {
    const digest = yield* assertReviewedSearchStagePlan(plan, source, compositionRevision, reviewed);
    const schema = yield* readSchema(rpc);
    if (
      plan.schemaDiffKinds.length > 0 ||
      schema.schemaDiffKinds.length > 0 ||
      schema.schemaSha256 !== plan.schemaSha256 ||
      schema.liveSchemaSha256 !== plan.liveSchemaSha256
    ) {
      return yield* fail(
        'Canonical schema publication is a separate prerequisite: scripts/ops/publish-people-search-schema.mts (dry-run, then reviewed --apply through the approved runner); make a new policy plan afterward',
      );
    }
    const prerequisites = yield* relations(source.prerequisites);
    if ((yield* missingRelationships(rpc, prerequisites)).length > 0 || plan.missingPrerequisites.length > 0) {
      return yield* fail('Existing role membership is missing; use the owning installer and re-plan');
    }
    const desired = yield* relations(source.desired);
    const missing = yield* missingRelationships(rpc, desired);
    if (missing.some((item) => !plan.missing.includes(encoded(item)))) {
      return yield* fail('A grant outside the reviewed missing set disappeared; re-plan before any write');
    }
    const before = yield* decisions(rpc, plan.probes);
    if (
      plan.checks.some(
        (check, index) => !receivesGrant(check, [...desired, ...prerequisites]) && before[index] !== check.before,
      )
    ) {
      return yield* fail('An unrelated executor permission changed since review; no grants changed');
    }
    if (mode === 'apply' && missing.length > 0) {
      if (missing.length + prerequisites.length > 900) {
        return yield* fail('Atomic relationship budget exceeded; no partial writes are permitted');
      }
      const preconditions = yield* Effect.forEach([...prerequisites, ...missing], (item, index) =>
        filterFor(item).pipe(
          Effect.map((filter) =>
            v1.Precondition.create({
              filter,
              operation:
                index < prerequisites.length
                  ? v1.Precondition_Operation.MUST_MATCH
                  : v1.Precondition_Operation.MUST_NOT_MATCH,
            }),
          ),
        ),
      );
      yield* rpc.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          optionalPreconditions: preconditions,
          updates: missing.map((relationship) =>
            v1.RelationshipUpdate.create({
              operation: v1.RelationshipUpdate_Operation.CREATE,
              relationship,
            }),
          ),
        }),
      );
    }
    if ((yield* missingRelationships(rpc, desired)).length > 0) {
      return yield* fail('Reviewed executor grants are missing');
    }
    const after = yield* decisions(rpc, plan.probes);
    if (plan.checks.some((check, index) => after[index] !== check.expected)) {
      return yield* fail('Allowed/denied executor verification failed; owning Action checks remain independent');
    }
    return { applied: mode === 'apply' ? missing.length : 0, checks: plan.checks.length, digest, mode };
  });

interface TaggedFailure {
  readonly _tag: string;
}
/** Never include underlying config, RPC, filesystem or provider errors in operator output. */
export const searchStageFailureMessage = (failure: TaggedFailure) =>
  Schema.is(SearchStagePolicyError)(failure)
    ? failure.reason
    : 'Search STAGE policy stopped; credentials and provider details withheld';
const reportFailure = (error: TaggedFailure) => Console.error(searchStageFailureMessage(error));

export const searchStageEnvironment = Config.all({
  ONTOS_PUBLIC_ORIGIN: Config.schema(Schema.Literal(origin), 'ONTOS_PUBLIC_ORIGIN'),
  SPICEDB_CA_CERT: Config.Redacted('SPICEDB_CA_CERT'),
  SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
  SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
});

const command = Command.make(
  'search-stage-policy',
  {
    mode: Flag.Literals('mode', modes),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, plan: path, reviewed }) =>
    Effect.gen(function* searchStagePolicyCommand() {
      const environment = yield* searchStageEnvironment;
      const config = yield* parseSpiceDbConfig({
        ...environment,
        SPICEDB_CA_CERT: Redacted.value(environment.SPICEDB_CA_CERT),
        SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY),
      });
      const rpc = yield* Effect.acquireRelease(
        Effect.try({
          catch: () => fail('Unable to open pinned STAGE SpiceDB client'),
          try: () => openSpiceDbGrpcRpc(config, 10_000),
        }),
        (client) => Effect.sync(() => client.close()),
      );
      const snapshot = yield* (yield* ActiveApplicationCompositionService).load;
      const source = yield* searchStageSource(yield* discoverCurrentActions(snapshot));
      const filesystem = yield* FileSystem.FileSystem;
      if (mode === 'plan') {
        const plan = yield* planSearchStagePolicy(rpc, source, snapshot.composition.revision);
        const text = yield* Schema.encodeEffect(planJson)(plan);
        yield* filesystem.writeFileString(path, text, { flag: 'wx', mode: 0o600 });
        return yield* Console.log({
          desired: plan.desired.length,
          digest: yield* searchStagePlanDigest(plan),
          missing: plan.missing.length,
          missingPrerequisites: plan.missingPrerequisites.length,
          mode,
          schemaPublicationRequired: plan.schemaDiffKinds.length > 0,
        });
      }
      const plan = yield* decodeSearchStagePlan(yield* filesystem.readFileString(path));
      return yield* Console.log(
        yield* runSearchStagePolicy(rpc, mode, plan, source, snapshot.composition.revision, reviewed),
      );
    }).pipe(Effect.scoped, Effect.tapError(reportFailure)),
);

if (import.meta.main) {
  const services = ActiveApplicationCompositionConfigLive.pipe(
    Layer.provide(ActiveApplicationCompositionSourceLive),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  const exit = await Effect.runPromiseExit(
    Layer.build(Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(Layer.provide(services))).pipe(
      Effect.scoped,
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : process.exitCode;
}
