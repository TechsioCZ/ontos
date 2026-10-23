/** Preflight only: derive exact agent Action policy without mutating or discarding legacy graph evidence. */
import { v1 } from '@authzed/authzed-node';
import { Option, Result, Schema } from 'effect';

import { toLegalEntityAccessObjectId, toModuleAccessObjectId } from '../permissions/context-access.ts';
import { agentScopedRoleObjectId } from '../permissions/scoped-role.ts';
import { toSpiceDbActionGrantObjectId } from '../permissions/service.ts';
import type { ActionAuthorizationProvisioningAction } from './action-authorization-provisioning.ts';
import { AgentGrantAccessSchema, AgentGrantWritePolicySchema } from './agent-entity-grants.ts';
import { ConfigureAgentAuditEvidenceSchema } from '../modules/actions/configure-agent.action.ts';

const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const LegalEntityIdSchema = NonEmpty.pipe(Schema.brand('LegalEntityId'));
const PrincipalIdSchema = NonEmpty.pipe(Schema.brand('PrincipalId'));
const TenantIdSchema = NonEmpty.pipe(Schema.brand('TenantId'));
const AuditEventIdSchema = NonEmpty.pipe(Schema.brand('AuditEventId'));
const ModuleIdSchema = NonEmpty.pipe(Schema.brand('ModuleId'));
const ScopeSchema = Schema.Struct({
  legalEntityId: LegalEntityIdSchema,
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
type AgentScope = typeof ScopeSchema.Encoded;

/** The caller must supply the last explicit successful audit evidence in this exact company, never a default profile. */
export const AgentActionMigrationProfileSchema = Schema.Struct({
  ...ScopeSchema.fields,
  auditEventId: AuditEventIdSchema,
  modules: Schema.Array(Schema.Struct({ access: AgentGrantAccessSchema, moduleId: ModuleIdSchema })),
  writePolicy: AgentGrantWritePolicySchema,
});
export type AgentActionMigrationProfile = typeof AgentActionMigrationProfileSchema.Encoded;

export const AgentActionMigrationIssueSchema = Schema.Struct({
  auditEventId: Schema.optionalKey(AuditEventIdSchema),
  code: Schema.Literals([
    'ambiguous_action_scope',
    'ambiguous_profile',
    'invalid_inventory',
    'invalid_audit_evidence',
    'missing_profile',
    'missing_tenant_membership',
    'policy_graph_disagreement',
    'unknown_legacy_action',
    'invalid_graph_evidence',
  ]),
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
export type AgentActionMigrationIssue = typeof AgentActionMigrationIssueSchema.Encoded;

export interface AgentActionMigrationReport extends AgentScope {
  readonly actionDerivations: readonly {
    readonly actionKey: string;
    readonly permission: 'execute' | 'propose';
    readonly source: 'legacy_executor' | 'scoped_policy' | 'audited_write_module';
  }[];
  readonly actualModuleIds: readonly string[];
  readonly auditEventId: string;
  readonly selectedWriteModuleIds: readonly string[];
  readonly writePolicy: AgentActionMigrationProfile['writePolicy'];
}

export interface AgentActionPolicyMigrationPlan {
  /** Durable Action policy only. Membership and named-permission migration are separate owner operations. */
  readonly relationships: readonly v1.Relationship[];
  readonly reports: readonly AgentActionMigrationReport[];
}

export interface AgentActionPolicyMigrationInput {
  readonly actions: readonly ActionAuthorizationProvisioningAction[];
  /** Complete Core principal-kind=agent inventory for the managed tenants. */
  readonly agents: readonly { readonly principalId: string; readonly tenantId: string }[];
  readonly companies: readonly { readonly legalEntityId: string; readonly tenantId: string }[];
  readonly profiles: readonly AgentActionMigrationProfile[];
  /** Fully consistent direct principal relationships and existing deterministic agent-role relationships. */
  readonly relationships: readonly v1.Relationship[];
}

export interface AgentActionMigrationAuditEvent {
  readonly auditEventId: string;
  readonly eventType: string;
  readonly evidenceJson: unknown;
  readonly legalEntityId?: string;
  /** Preserve PostgreSQL microsecond ordering; do not feed Date.getTime() here. */
  readonly occurredAtEpochMicroseconds: number;
  readonly outcome: string;
  readonly tenantId: string;
}

const AuditProfilePayloadSchema = Schema.Struct({
  modulesJson: Schema.fromJsonString(AgentActionMigrationProfileSchema.fields.modules),
  targetPrincipalId: PrincipalIdSchema,
  writePolicy: AgentGrantWritePolicySchema,
});
const decodeAuditProfile = Schema.decodeUnknownResult(AuditProfilePayloadSchema);
/** Only authority fields are needed; inventory need not collect display names, descriptions or owner metadata. */
const decodeGovernedAuditProfile = Schema.decodeUnknownResult(
  Schema.Struct({
    legalEntityId: ConfigureAgentAuditEvidenceSchema.fields.legalEntityId,
    modules: ConfigureAgentAuditEvidenceSchema.fields.modules,
    revision: ConfigureAgentAuditEvidenceSchema.fields.revision,
    targetPrincipalId: ConfigureAgentAuditEvidenceSchema.fields.targetPrincipalId,
    writePolicy: ConfigureAgentAuditEvidenceSchema.fields.writePolicy,
  }),
);
const sameAuthority = (left: AgentActionMigrationProfile, right: AgentActionMigrationProfile): boolean =>
  left.writePolicy === right.writePolicy &&
  left.modules.length === right.modules.length &&
  left.modules.every((module) =>
    right.modules.some((other) => module.moduleId === other.moduleId && module.access === other.access),
  );

const AuditSelectionSchema = Schema.Struct({
  actionKey: Schema.Literals(['core.identity.manage-demo-account', 'core.identity.configure-agent']),
  operation: Schema.Literals(['create-agent', 'configure-agent']),
  targetPrincipalId: PrincipalIdSchema,
});
const decodeAuditSelection = Schema.decodeUnknownOption(AuditSelectionSchema);

/** Unlike the display-profile folder, missing or malformed authority evidence never receives a seeded/default profile. */
export const foldAgentActionMigrationProfiles = (
  agents: AgentActionPolicyMigrationInput['agents'],
  events: readonly AgentActionMigrationAuditEvent[],
): Result.Result<readonly AgentActionMigrationProfile[], readonly AgentActionMigrationIssue[]> => {
  const issues: AgentActionMigrationIssue[] = [];
  const latest = new Map<string, { readonly at: number; readonly profile: AgentActionMigrationProfile }>();
  const ordered = events.toSorted(
    (left, right) =>
      left.occurredAtEpochMicroseconds - right.occurredAtEpochMicroseconds ||
      left.auditEventId.localeCompare(right.auditEventId),
  );
  const foldEvent = (row: AgentActionMigrationAuditEvent): void => {
    if (row.eventType !== 'action.executed' || row.outcome !== 'succeeded') {
      return;
    }
    const selection = decodeAuditSelection(row.evidenceJson);
    if (Option.isNone(selection)) {
      return;
    }
    const { targetPrincipalId: principalId } = selection.value;
    if (!agents.some((agent) => agent.principalId === principalId && agent.tenantId === row.tenantId)) {
      return;
    }
    const scope =
      row.legalEntityId === undefined || row.legalEntityId.length === 0
        ? { principalId, tenantId: row.tenantId }
        : { legalEntityId: row.legalEntityId, principalId, tenantId: row.tenantId };
    const auditScope = row.auditEventId.length === 0 ? scope : { ...scope, auditEventId: row.auditEventId };
    const decoded: Result.Result<
      {
        readonly legalEntityId: string | undefined;
        readonly modules: AgentActionMigrationProfile['modules'];
        readonly writePolicy: AgentActionMigrationProfile['writePolicy'];
      },
      Schema.SchemaError
    > =
      selection.value.actionKey === 'core.identity.configure-agent'
        ? Result.map(decodeGovernedAuditProfile(row.evidenceJson), (value) => ({
            legalEntityId: value.legalEntityId,
            modules: value.modules,
            writePolicy: value.writePolicy,
          }))
        : Result.map(decodeAuditProfile(row.evidenceJson), (value) => ({
            legalEntityId: row.legalEntityId,
            modules: value.modulesJson,
            writePolicy: value.writePolicy,
          }));
    if (
      row.legalEntityId === undefined ||
      row.legalEntityId.length === 0 ||
      row.auditEventId.length === 0 ||
      !Number.isSafeInteger(row.occurredAtEpochMicroseconds) ||
      Result.isFailure(decoded) ||
      decoded.success.legalEntityId !== row.legalEntityId
    ) {
      issues.push({ ...auditScope, code: 'invalid_audit_evidence' });
      return;
    }
    const profile: AgentActionMigrationProfile = {
      ...scope,
      auditEventId: row.auditEventId,
      legalEntityId: row.legalEntityId,
      modules: decoded.success.modules,
      writePolicy: decoded.success.writePolicy,
    };
    if (new Set(profile.modules.map(({ moduleId }) => moduleId)).size !== profile.modules.length) {
      issues.push({ ...auditScope, code: 'invalid_audit_evidence' });
      return;
    }
    const key = agentScopedRoleObjectId(profile);
    const previous = latest.get(key);
    if (previous?.at === row.occurredAtEpochMicroseconds && !sameAuthority(previous.profile, profile)) {
      issues.push({ ...auditScope, code: 'ambiguous_profile' });
      return;
    }
    latest.set(key, { at: row.occurredAtEpochMicroseconds, profile });
  };
  for (const row of ordered) {
    foldEvent(row);
  }
  return issues.length > 0 ? Result.fail(issues) : Result.succeed([...latest.values()].map(({ profile }) => profile));
};

const sameScope = (left: AgentScope, right: AgentScope): boolean =>
  left.tenantId === right.tenantId &&
  left.legalEntityId === right.legalEntityId &&
  left.principalId === right.principalId;
const directSubject = (item: v1.Relationship, principalId: string): boolean =>
  item.subject?.object?.objectType === 'principal' &&
  item.subject.object.objectId === principalId &&
  item.subject.optionalRelation === '';
const roleSubject = (item: v1.Relationship, roleId: string): boolean =>
  item.subject?.object?.objectType === 'scoped_role' &&
  item.subject.object.objectId === roleId &&
  item.subject.optionalRelation === 'member';
const directMember = (
  items: readonly v1.Relationship[],
  resourceType: string,
  objectId: string,
  principalId: string,
): boolean =>
  items.some(
    (item) =>
      item.resource?.objectType === resourceType &&
      item.resource.objectId === objectId &&
      item.relation === 'member' &&
      directSubject(item, principalId),
  );
const legacyActionId = (actionKey: string): string => `ak_${Buffer.from(actionKey, 'utf-8').toString('base64url')}`;
const decodeModule = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
);

interface Candidate {
  readonly modules: ReadonlySet<string>;
  readonly profile: AgentActionMigrationProfile;
  readonly roleId: string;
  readonly sources: Map<string, AgentActionMigrationReport['actionDerivations'][number]['source']>;
  readonly writes: ReadonlySet<string>;
}

interface MigrationScope {
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}
type ReportIssue = (scope: MigrationScope, code: AgentActionMigrationIssue['code']) => void;

const actualModules = (
  input: AgentActionPolicyMigrationInput,
  profile: AgentActionMigrationProfile,
  issue: ReportIssue,
): ReadonlySet<string> => {
  const modules = new Set<string>();
  const roleId = agentScopedRoleObjectId(profile);
  const roleMember = directMember(input.relationships, 'scoped_role', roleId, profile.principalId);
  const readModule = (item: v1.Relationship): void => {
    if (
      item.resource?.objectType !== 'module_access' ||
      !(directSubject(item, profile.principalId) || roleSubject(item, roleId))
    ) {
      return;
    }
    const id = item.resource.objectId;
    const decoded = id.startsWith('ctx_')
      ? decodeModule(Buffer.from(id.slice(4), 'base64url').toString('utf-8'))
      : Option.none();
    if (Option.isNone(decoded)) {
      issue(profile, 'invalid_graph_evidence');
      return;
    }
    const [tenantId, companyId, moduleId] = decoded.value;
    if (tenantId !== profile.tenantId || companyId !== profile.legalEntityId) {
      if (roleSubject(item, roleId)) {
        issue(profile, 'invalid_graph_evidence');
      }
      return;
    }
    const validRelation = directSubject(item, profile.principalId)
      ? item.relation === 'accessor'
      : roleMember && ['accessor_role', 'reader_role', 'writer_role'].includes(item.relation);
    if (id !== toModuleAccessObjectId(tenantId, companyId, moduleId) || !validRelation) {
      issue(profile, 'invalid_graph_evidence');
      return;
    }
    if (
      item.relation === 'writer_role' &&
      (profile.writePolicy !== 'direct' ||
        !profile.modules.some((module) => module.moduleId === moduleId && module.access === 'write'))
    ) {
      issue(profile, 'policy_graph_disagreement');
    }
    if (moduleId !== 'core.shell') {
      modules.add(moduleId);
    }
  };
  for (const item of input.relationships) {
    readModule(item);
  }
  return modules;
};

const candidateFor = (
  input: AgentActionPolicyMigrationInput,
  scope: AgentScope,
  issue: ReportIssue,
): Option.Option<Candidate> => {
  if (!directMember(input.relationships, 'tenant', scope.tenantId, scope.principalId)) {
    issue(scope, 'missing_tenant_membership');
    return Option.none();
  }
  const profiles = input.profiles.filter((profile) => sameScope(profile, scope));
  if (profiles.length !== 1) {
    issue(scope, profiles.length === 0 ? 'missing_profile' : 'ambiguous_profile');
    return Option.none();
  }
  const [profile] = profiles;
  if (profile === undefined || !Schema.is(AgentActionMigrationProfileSchema)(profile)) {
    issue(scope, 'missing_profile');
    return Option.none();
  }
  const modules = actualModules(input, profile, issue);
  const selected = new Set(profile.modules.map(({ moduleId }) => moduleId));
  if (
    selected.size !== profile.modules.length ||
    selected.size !== modules.size ||
    [...selected].some((moduleId) => moduleId.startsWith('core.') || !modules.has(moduleId))
  ) {
    issue(scope, 'policy_graph_disagreement');
  }
  return Option.some({
    modules,
    profile,
    roleId: agentScopedRoleObjectId(scope),
    sources: new Map(),
    writes: new Set(profile.modules.flatMap(({ access, moduleId }) => (access === 'write' ? [moduleId] : []))),
  });
};

const canWriteAction = (candidate: Candidate, action: ActionAuthorizationProvisioningAction): boolean =>
  action.legalEntityScope !== 'forbidden' &&
  candidate.modules.has(action.owningModuleKey) &&
  candidate.writes.has(action.owningModuleKey);

const recoverLegacyExecutor = (
  item: v1.Relationship,
  scope: MigrationScope,
  candidates: readonly Candidate[],
  legacyActions: ReadonlyMap<string, ActionAuthorizationProvisioningAction>,
  issue: ReportIssue,
): void => {
  if (item.resource?.objectType !== 'action' || !directSubject(item, scope.principalId)) {
    return;
  }
  const action = legacyActions.get(item.resource.objectId);
  if (action === undefined) {
    issue(scope, 'unknown_legacy_action');
    return;
  }
  if (item.relation !== 'executor') {
    issue(scope, 'invalid_graph_evidence');
    return;
  }
  const targets = candidates.filter(
    (candidate) => candidate.profile.writePolicy === 'direct' && canWriteAction(candidate, action),
  );
  if (targets.length !== 1) {
    issue(scope, targets.length > 1 ? 'ambiguous_action_scope' : 'policy_graph_disagreement');
    return;
  }
  targets[0]?.sources.set(action.actionKey, 'legacy_executor');
};

const recoverScopedPolicy = (
  input: AgentActionPolicyMigrationInput,
  candidate: Candidate,
  issue: ReportIssue,
): void => {
  const { profile, roleId, sources } = candidate;
  const roleMember = directMember(input.relationships, 'scoped_role', roleId, profile.principalId);
  const grants = new Map(
    input.actions.map((action) => [toSpiceDbActionGrantObjectId({ ...profile, actionKey: action.actionKey }), action]),
  );
  const readGrant = (item: v1.Relationship): void => {
    if (item.resource?.objectType !== 'action_grant' || !roleSubject(item, roleId)) {
      return;
    }
    const action = grants.get(item.resource.objectId);
    const expectedRelation = profile.writePolicy === 'direct' ? 'role' : 'proposer_role';
    if (
      !roleMember ||
      action === undefined ||
      !canWriteAction(candidate, action) ||
      profile.writePolicy === 'read_only' ||
      item.relation !== expectedRelation
    ) {
      issue(profile, 'policy_graph_disagreement');
      return;
    }
    if (!sources.has(action.actionKey)) {
      sources.set(action.actionKey, 'scoped_policy');
    }
  };
  for (const item of input.relationships) {
    readGrant(item);
  }
  if (profile.writePolicy === 'approval') {
    for (const action of input.actions) {
      if (canWriteAction(candidate, action) && !sources.has(action.actionKey)) {
        sources.set(action.actionKey, 'audited_write_module');
      }
    }
  }
};

const candidateReport = ({ modules, profile, sources, writes }: Candidate): AgentActionMigrationReport => ({
  actionDerivations: [...sources]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([actionKey, source]) => ({
      actionKey,
      permission: profile.writePolicy === 'direct' ? 'execute' : 'propose',
      source,
    })),
  actualModuleIds: [...modules].toSorted(),
  auditEventId: profile.auditEventId,
  legalEntityId: profile.legalEntityId,
  principalId: profile.principalId,
  selectedWriteModuleIds: [...writes].toSorted(),
  tenantId: profile.tenantId,
  writePolicy: profile.writePolicy,
});

/** No role-name permission matrix, Action-prefix ownership guesses, inferred profiles, or graph writes. */
export const planAgentActionPolicyMigration = (
  input: AgentActionPolicyMigrationInput,
): Result.Result<AgentActionPolicyMigrationPlan, readonly AgentActionMigrationIssue[]> => {
  const issues: AgentActionMigrationIssue[] = [];
  const issue: ReportIssue = (scope, code) => {
    issues.push({ ...scope, code });
  };
  const principalIds = input.agents.map(({ principalId }) => principalId);
  const companyIds = input.companies.map(({ legalEntityId }) => legalEntityId);
  const actionKeys = input.actions.map(({ actionKey }) => actionKey);
  if (
    new Set(principalIds).size !== principalIds.length ||
    new Set(companyIds).size !== companyIds.length ||
    new Set(actionKeys).size !== actionKeys.length
  ) {
    for (const agent of input.agents) {
      issue(agent, 'invalid_inventory');
    }
    return Result.fail(issues);
  }
  if (input.relationships.some((item) => item.resource === undefined || item.subject?.object === undefined)) {
    for (const agent of input.agents) {
      issue(agent, 'invalid_graph_evidence');
    }
    return Result.fail(issues);
  }
  const candidates: Candidate[] = [];
  const legacyActions = new Map(input.actions.map((action) => [legacyActionId(action.actionKey), action]));
  for (const agent of input.agents) {
    const companyScopes = input.companies.flatMap((company) => {
      const companyId = toLegalEntityAccessObjectId(company.tenantId, company.legalEntityId);
      return company.tenantId === agent.tenantId &&
        companyId !== undefined &&
        directMember(input.relationships, 'legal_entity', companyId, agent.principalId)
        ? [{ ...agent, legalEntityId: company.legalEntityId }]
        : [];
    });
    const agentCandidates = companyScopes.flatMap((scope) => Option.toArray(candidateFor(input, scope, issue)));
    candidates.push(...agentCandidates);
    for (const item of input.relationships) {
      recoverLegacyExecutor(item, companyScopes[0] ?? agent, agentCandidates, legacyActions, issue);
    }
  }
  for (const candidate of candidates) {
    recoverScopedPolicy(input, candidate, issue);
  }
  if (issues.length > 0) {
    return Result.fail(issues);
  }
  const reports = candidates.map(candidateReport);
  return Result.succeed({
    relationships: reports.flatMap((report) =>
      report.actionDerivations.map(({ actionKey, permission }) =>
        v1.Relationship.create({
          relation: permission === 'execute' ? 'role' : 'proposer_role',
          resource: { objectId: toSpiceDbActionGrantObjectId({ ...report, actionKey }), objectType: 'action_grant' },
          subject: {
            object: { objectId: agentScopedRoleObjectId(report), objectType: 'scoped_role' },
            optionalRelation: 'member',
          },
        }),
      ),
    ),
    reports,
  });
};
