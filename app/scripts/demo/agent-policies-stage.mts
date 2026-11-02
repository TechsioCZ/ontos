#!/usr/bin/env node
/** All-agent stage audit and reviewed declared-only reconciliation through the native seed provisioning path. */
import { createHash, randomUUID } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { v1 } from '@authzed/authzed-node';
import { and, eq, inArray } from 'drizzle-orm';
import { Array as EffectArray, Config, Console, Effect, FileSystem, Option, Order, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { principals, principalCompanyMemberships } from '../../packages/core-runtime/src/db/schema.ts';
import { openDemoAccountGrants } from '../../packages/core-runtime/src/install/demo-account-administration.ts';
import type { DemoAccountGrants } from '../../packages/core-runtime/src/install/demo-account-administration.ts';
import { planAgentScopedRoleReplacement } from '../../packages/core-runtime/src/install/agent-scoped-role-policy.ts';
import { fullyConsistent } from '../../packages/core-runtime/src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-transaction-guard.ts';
import type { SpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-rpc.ts';
import { ActionPermission, toSpiceDbActionGrantObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import { agentScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import {
  AgentProfileReadDatabase,
  AgentProfileSetupInputSchema,
  readProfile,
  runAgentProfileSetup,
} from './agent-profile-setup.mts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';
import {
  AgentPolicyEvidenceSchema,
  AgentPolicyInspectionSchema,
  agentPolicyFingerprint,
  validateDeclaredAgentRepair,
} from './agent-policies-stage-model.mts';
import {
  demoTenantId,
  demoLegalEntityId,
  rentalDemoLegalEntityId,
  crmDemoLegalEntityId,
  eshopDemoLegalEntityId,
  akrosDemoLegalEntityId,
} from './fixture-ids.mts';
import { DemoSeedError } from './seed-client.mts';

const origin = 'https://ontos-stage.web-revolution.cz';
const companyIds: readonly string[] = [
  demoLegalEntityId,
  rentalDemoLegalEntityId,
  crmDemoLegalEntityId,
  eshopDemoLegalEntityId,
  akrosDemoLegalEntityId,
];
const lifecycleKey = 'core.identity.mutate-agent-proposals';
const StringList = Schema.Array(Schema.String);
const AuditRowSchema = Schema.Struct({
  companyId: AgentProfileSetupInputSchema.fields.legalEntityId,
  diagnostics: StringList,
  displayName: Schema.String,
  inactiveUnexpected: StringList,
  lifecycleDeclared: Schema.Boolean,
  lifecycleExecution: Schema.Literals(['allowed', 'denied']),
  membershipStatus: Schema.String,
  policy: Schema.optionalKey(AgentPolicyEvidenceSchema),
  principalId: AgentProfileSetupInputSchema.fields.principalId,
  profileRevision: Schema.Int,
  status: Schema.String,
});
const AuditPlanSchema = Schema.Struct({
  agents: Schema.Array(AuditRowSchema),
  compositionRevision: Schema.String,
  inventory: Schema.Array(
    Schema.Struct({
      displayName: Schema.String,
      principalId: AgentProfileSetupInputSchema.fields.principalId,
      status: Schema.String,
    }),
  ),
  sourceDigests: Schema.Record(Schema.String, Schema.String),
  tenantId: Schema.Literal(demoTenantId),
  undeclared: StringList,
});
type AuditPlan = typeof AuditPlanSchema.Type;
const reason = (text: string) => new DemoSeedError({ reason: text });
const sourcePaths = [
  '../../packages/core-runtime/src/install/agent-entity-grants.ts',
  '../../packages/core-runtime/src/permissions/agent-profile-lifecycle.ts',
  '../../packages/core-runtime/src/install/agent-scoped-role-policy.ts',
  './agent-profile-setup.mts',
  './seed-agent-entities.mts',
  './agent-policies-stage.mts',
];
const principalTuple = (
  principalId: string,
  edge: { readonly relation: string; readonly resourceId: string; readonly resourceType: string },
) =>
  v1.Relationship.toJsonString(
    v1.Relationship.create({
      relation: edge.relation,
      resource: { objectId: edge.resourceId, objectType: edge.resourceType },
      subject: { object: { objectId: principalId, objectType: 'principal' } },
    }),
  );
const lifecycleTuple = (principalId: string, legalEntityId: string) =>
  v1.Relationship.toJsonString(
    v1.Relationship.create({
      relation: 'role',
      resource: {
        objectId: toSpiceDbActionGrantObjectId({ actionKey: lifecycleKey, legalEntityId, tenantId: demoTenantId }),
        objectType: 'action_grant',
      },
      subject: {
        object: {
          objectId: agentScopedRoleObjectId({ legalEntityId, principalId, tenantId: demoTenantId }),
          objectType: 'scoped_role',
        },
        optionalRelation: 'member',
      },
    }),
  );

type Actor = Parameters<typeof runAgentProfileSetup>[0];
type Agent = AuditPlan['inventory'][number];
type Membership = Pick<
  typeof principalCompanyMemberships.$inferSelect,
  'affiliation' | 'legalEntityId' | 'principalId' | 'status'
>;
type Profile = NonNullable<Effect.Success<ReturnType<typeof readProfile>>>;
type Row = typeof AuditRowSchema.Type;
interface AgentScope {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const inspectActivePolicy = (actor: Actor, row: Row, membership: Membership, profile: Profile) =>
  Effect.gen(function* inspectActivePolicyEffect() {
    const diagnostics = [...row.diagnostics];
    const scope = { legalEntityId: row.companyId, principalId: row.principalId, tenantId: demoTenantId };
    const input = yield* Schema.decodeUnknownEffect(AgentProfileSetupInputSchema)({
      ...scope,
      description: profile.description,
      displayName: row.displayName,
      modules: profile.modules,
      operation: 'configure-agent',
      ownerPrincipalId: profile.ownerPrincipalId,
      writePolicy: profile.writePolicy,
    });
    if (membership.affiliation !== null || profile.displayName !== row.displayName) {
      diagnostics.push('Native identity/profile metadata differs; do not overwrite administrator evidence');
    }
    const inspection = yield* runAgentProfileSetup(actor, [input], 'dry-run', 'read-only-inspection').pipe(
      Effect.result,
    );
    if (Result.isFailure(inspection)) {
      const detail = Schema.decodeUnknownOption(Schema.Struct({ reason: Schema.String }))(inspection.failure);
      diagnostics.push(
        Option.isSome(detail)
          ? `Native read-only preparation: ${detail.value.reason}`
          : 'Native read-only preparation failed; no write permitted',
      );
      return { ...row, diagnostics };
    }
    const parsed = yield* Schema.decodeUnknownEffect(AgentPolicyInspectionSchema)(inspection.success);
    const [policy] = parsed.policies;
    if (policy === undefined) {
      return yield* reason('Native policy inspection omitted an agent');
    }
    const lifecycleDeclared = policy.expected.includes(lifecycleTuple(row.principalId, membership.legalEntityId));
    const validity = yield* Effect.result(validateDeclaredAgentRepair(policy));
    if (Result.isFailure(validity)) {
      diagnostics.push('Policy contains undeclared/deletion/profile-changing differences; reconciliation forbidden');
    }
    if (!lifecycleDeclared && row.lifecycleExecution === 'allowed') {
      diagnostics.push('Undeclared lifecycle execution is allowed; access differs from source');
    }
    if (lifecycleDeclared && row.lifecycleExecution === 'denied' && policy.missing.length === 0) {
      diagnostics.push(
        'Declared policy already matches but Action execution is denied: check source/runtime relation or Action metadata, not a role regrant',
      );
    }
    return { ...row, diagnostics, lifecycleDeclared, policy };
  });

const inspectInactivePolicy = (
  row: Row,
  rpc: SpiceDbRpc,
  direct: readonly v1.Relationship[],
  scope: AgentScope,
  profile: Profile | undefined,
) =>
  Effect.gen(function* inspectInactivePolicyEffect() {
    const diagnostics = [...row.diagnostics];
    const inactive = yield* planAgentScopedRoleReplacement(rpc, {
      ...scope,
      currentPrincipalRelationships: direct,
      desired: [],
    }).pipe(Effect.result);
    let inactiveUnexpected: string[] = [];
    if (Result.isFailure(inactive)) {
      diagnostics.push('Inactive/unconfigured policy could not be inspected safely');
    } else if (inactive.success.updates.length > 0) {
      inactiveUnexpected = EffectArray.sort(
        inactive.success.updates.map((update) => v1.RelationshipUpdate.toJsonString(update)),
        Order.String,
      );
      diagnostics.push('Inactive/unconfigured agent retains undeclared policy; no write authorized');
    }
    if (row.lifecycleExecution === 'allowed') {
      diagnostics.push('Lifecycle execution allowed without a declared active profile');
    }
    if (row.status === 'active' && row.membershipStatus === 'active' && profile === undefined) {
      diagnostics.push('Active agent has no native audited profile; no manifest defaults invented');
    }
    return { ...row, diagnostics, inactiveUnexpected };
  });

const inspectMembership = (
  actor: Actor,
  agent: Agent,
  membership: Membership,
  rpc: SpiceDbRpc,
  direct: readonly v1.Relationship[],
) =>
  Effect.gen(function* inspectMembershipEffect() {
    const scope = { legalEntityId: membership.legalEntityId, principalId: agent.principalId, tenantId: demoTenantId };
    const profile = yield* readProfile(scope);
    const permission = yield* ActionPermission;
    const row: Row = {
      companyId: membership.legalEntityId,
      diagnostics: [],
      displayName: agent.displayName,
      inactiveUnexpected: [],
      lifecycleDeclared: false,
      lifecycleExecution: yield* permission.checkActionPermission({
        ...scope,
        actionKey: lifecycleKey,
        correlationId: randomUUID(),
      }),
      membershipStatus: membership.status,
      principalId: agent.principalId,
      profileRevision: profile?.revision ?? 0,
      status: agent.status,
    };
    return agent.status === 'active' && membership.status === 'active' && profile !== undefined
      ? yield* inspectActivePolicy(actor, row, membership, profile)
      : yield* inspectInactivePolicy(row, rpc, direct, scope, profile);
  });

const retainedAdmission = (edge: {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
}) =>
  edge.resourceType === 'tenant' &&
  edge.resourceId === demoTenantId &&
  ['member', 'company_member'].includes(edge.relation);

const inspectOneAgent = (
  actor: Actor,
  agent: Agent,
  memberships: readonly Membership[],
  rpc: SpiceDbRpc,
  grants: DemoAccountGrants,
) =>
  Effect.gen(function* inspectOneAgentEffect() {
    const associations = memberships.filter((item) => item.principalId === agent.principalId);
    const direct = yield* grants.relationshipsOf(agent.principalId);
    const directTuples = direct.map((edge) => v1.Relationship.fromJsonString(principalTuple(agent.principalId, edge)));
    const roleMembers = yield* rpc.readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency: fullyConsistent,
        relationshipFilter: {
          optionalSubjectFilter: { optionalSubjectId: agent.principalId, subjectType: 'principal' },
          resourceType: 'scoped_role',
        },
      }),
    );
    const allowedRoles = new Set(
      associations
        .filter((item) => companyIds.includes(item.legalEntityId))
        .map((item) =>
          agentScopedRoleObjectId({
            legalEntityId: item.legalEntityId,
            principalId: agent.principalId,
            tenantId: demoTenantId,
          }),
        ),
    );
    const undeclared: string[] = [];
    for (const response of roleMembers) {
      const edge = response.relationship;
      if (
        edge?.resource === undefined ||
        edge.subject?.object?.objectId !== agent.principalId ||
        edge.relation !== 'member' ||
        !allowedRoles.has(edge.resource.objectId)
      ) {
        undeclared.push(
          `Undeclared scoped-role membership of ${agent.principalId}: ${edge === undefined ? 'incomplete edge' : v1.Relationship.toJsonString(edge)}`,
        );
      }
    }
    if (associations.length === 0) {
      undeclared.push(`Agent ${agent.principalId} has no native company membership; no default scope inferred`);
    }
    const rows: Row[] = [];
    for (const membership of associations) {
      if (companyIds.includes(membership.legalEntityId)) {
        rows.push(yield* inspectMembership(actor, agent, membership, rpc, directTuples));
      } else {
        undeclared.push(
          `Agent ${agent.principalId} has company ${membership.legalEntityId} outside source demo companies`,
        );
      }
    }
    const expectedDirect = new Set(rows.flatMap((row) => row.policy?.expected ?? []));
    const unexpected = direct
      .filter((edge) => !retainedAdmission(edge))
      .map((edge) => principalTuple(agent.principalId, edge))
      .filter((tuple) => !expectedDirect.has(tuple));
    undeclared.push(
      ...unexpected.map((tuple) => `Undeclared direct principal policy of ${agent.principalId}: ${tuple}`),
    );
    return { rows, undeclared };
  });

const inspect = (actor: Parameters<typeof runAgentProfileSetup>[0]) =>
  Effect.gen(function* inspectAllAgents() {
    const fs = yield* FileSystem.FileSystem;
    const { executor } = yield* AgentProfileReadDatabase;
    const grants = yield* openDemoAccountGrants;
    const configuration = yield* loadSpiceDbConfig();
    const rpc = yield* Effect.acquireRelease(
      Effect.sync(() => openSpiceDbRpc(configuration, 10_000)),
      (channel) => Effect.sync(() => channel.close()),
    );
    const inventory = yield* executor
      .select({ displayName: principals.displayName, principalId: principals.principalId, status: principals.status })
      .from(principals)
      .where(and(eq(principals.tenantId, demoTenantId), eq(principals.kind, 'agent')))
      .orderBy(principals.principalId);
    if (actor.tenantId !== demoTenantId || inventory.length === 0) {
      return yield* reason('Expected authenticated demo tenant and a nonempty native all-agent inventory');
    }
    const memberships = yield* executor
      .select({
        affiliation: principalCompanyMemberships.affiliation,
        legalEntityId: principalCompanyMemberships.legalEntityId,
        principalId: principalCompanyMemberships.principalId,
        status: principalCompanyMemberships.status,
      })
      .from(principalCompanyMemberships)
      .where(
        and(
          eq(principalCompanyMemberships.tenantId, demoTenantId),
          inArray(
            principalCompanyMemberships.principalId,
            inventory.map((item) => item.principalId),
          ),
        ),
      )
      .orderBy(principalCompanyMemberships.principalId, principalCompanyMemberships.legalEntityId);
    const sourceDigests: Record<string, string> = {};
    for (const path of sourcePaths) {
      sourceDigests[path] = createHash('sha256')
        .update(yield* fs.readFileString(new URL(path, import.meta.url).pathname))
        .digest('hex');
    }
    const plan: AuditPlan = {
      agents: [],
      compositionRevision: (yield* (yield* ActiveApplicationCompositionService).load).composition.revision,
      inventory,
      sourceDigests,
      tenantId: demoTenantId,
      undeclared: [],
    };
    const results = yield* Effect.forEach(
      inventory,
      (agent) => inspectOneAgent(actor, agent, memberships, rpc, grants),
      { concurrency: 1 },
    );
    return {
      ...plan,
      agents: results.flatMap((result) => result.rows),
      undeclared: EffectArray.sort(
        results.flatMap((result) => result.undeclared),
        Order.String,
      ),
    };
  }).pipe(Effect.scoped);

const validatePlan = (plan: AuditPlan) =>
  Effect.gen(function* validateAllDeclared() {
    if (plan.undeclared.length > 0 || plan.agents.some((row) => row.diagnostics.length > 0)) {
      return yield* reason(
        'Audit contains undeclared authority, source/profile mismatch or unresolved native errors; stop and report, no apply',
      );
    }
    for (const row of plan.agents) {
      if (row.policy !== undefined) {
        yield* validateDeclaredAgentRepair(row.policy);
      }
    }
    return yield* Effect.void;
  });
/** Compare all reviewed identity/source/desired-policy facts, allowing only audit revision and missing-edge resolution. */
const reviewedIntentFingerprint = (saved: AuditPlan, after: AuditPlan) =>
  agentPolicyFingerprint(AuditPlanSchema, {
    ...after,
    agents: after.agents.map((row) => {
      const before = saved.agents.find(
        (candidate) => candidate.companyId === row.companyId && candidate.principalId === row.principalId,
      );
      if (before === undefined) {
        return row;
      }
      const stable = { ...row, lifecycleExecution: before.lifecycleExecution, profileRevision: before.profileRevision };
      if (row.policy === undefined || before.policy === undefined) {
        return stable;
      }
      return { ...stable, policy: { ...row.policy, missing: before.policy.missing } };
    }),
  });
const run = (mode: 'plan' | 'apply' | 'verify', path: string, reviewed: Option.Option<string>) =>
  Effect.gen(function* runAudit() {
    yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    yield* Config.schema(Schema.Literal(origin), 'ONTOS_PUBLIC_ORIGIN');
    const fs = yield* FileSystem.FileSystem;
    const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
      session.close.pipe(Effect.ignore),
    );
    const current = yield* inspect(operator.principal);
    const fingerprint = yield* agentPolicyFingerprint(AuditPlanSchema, current);
    if (mode === 'plan') {
      yield* fs.writeFileString(path, yield* Schema.encodeEffect(Schema.fromJsonString(AuditPlanSchema))(current), {
        flag: 'wx',
        mode: 0o600,
      });
      return yield* Console.log({
        agents: current.inventory.length,
        companies: companyIds.map((companyId) => ({
          agents: current.agents.filter((row) => row.companyId === companyId).length,
          companyId,
        })),
        fingerprint,
        mode,
        rows: current.agents.map((row) => ({
          company: row.companyId,
          diagnostics: row.diagnostics,
          inactiveUnexpected: row.inactiveUnexpected,
          lifecycleDeclared: row.lifecycleDeclared,
          lifecycleExecution: row.lifecycleExecution,
          missing: row.policy?.missing ?? [],
          name: row.displayName,
          principalId: row.principalId,
          unexpected: row.policy?.unexpected ?? [],
        })),
        undeclared: current.undeclared,
      });
    }
    const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AuditPlanSchema))(
      yield* fs.readFileString(path),
    );
    if (Option.isNone(reviewed) || reviewed.value !== (yield* agentPolicyFingerprint(AuditPlanSchema, saved))) {
      return yield* reason('Exact reviewed all-agent policy fingerprint required');
    }
    yield* validatePlan(saved);
    if (mode === 'apply') {
      if (fingerprint !== reviewed.value) {
        return yield* reason('Source, inventory, native profiles or live tuples changed after review; no writes');
      }
      const inputs = current.agents.flatMap((row) =>
        row.policy === undefined || row.policy.missing.length === 0 ? [] : [row.policy.input],
      );
      const bounds = current.agents.flatMap((row) =>
        row.policy === undefined || row.policy.missing.length === 0 ? [] : [row.policy],
      );
      yield* Console.log(yield* runAgentProfileSetup(operator.principal, inputs, 'apply', reviewed.value, bounds));
    }
    const after = yield* inspect(operator.principal);
    yield* validatePlan(after);
    if ((yield* reviewedIntentFingerprint(saved, after)) !== reviewed.value) {
      return yield* reason(
        'Inventory, source, profile selections or expected tuples differ from the reviewed intent; stop',
      );
    }
    if (
      after.agents.some(
        (row) =>
          (row.policy?.missing.length ?? 0) !== 0 || (row.lifecycleDeclared && row.lifecycleExecution !== 'allowed'),
      )
    ) {
      return yield* reason(
        'Declared policy or lifecycle execution remains incomplete; do not broaden access or blindly retry',
      );
    }
    return yield* Console.log({
      agents: after.inventory.length,
      declaredLifecycleChecksPassed: true,
      missingTuples: 0,
      mode,
      nativeProfilesPreserved: true,
      undeclaredTuples: 0,
    });
  }).pipe(Effect.scoped);
const command = Command.make(
  'agent-policies-stage',
  {
    mode: Flag.Literals('mode', ['plan', 'apply', 'verify']),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, plan, reviewed }) => run(mode, plan, reviewed),
).pipe(Command.provide(AgentProfileOperatorLive));
if (import.meta.main) {
  await Effect.runPromise(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}
