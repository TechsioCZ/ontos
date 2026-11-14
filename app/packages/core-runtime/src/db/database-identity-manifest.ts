import { Option, Result, Schema } from 'effect';

import { freezeIdentity, SHARED_RUNTIME_IDENTITY, SHELL_GATEWAY_ISSUER_IDENTITY } from './database-identity-data.ts';

export {
  BEARER_ASSERTION_ROLE_SETTINGS,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from './database-identity-data.ts';

/** Owner-neutral identity contracts and enrollment validation. */
const DATABASE_SCOPE_AUTHORITIES = ['gateway_grant', 'session_setting', 'none'] as const;
export type DatabaseScopeAuthority = (typeof DATABASE_SCOPE_AUTHORITIES)[number];
const DATABASE_TABLE_PRIVILEGES = ['select', 'insert', 'update', 'delete'] as const;
export type DatabaseTablePrivilege = (typeof DATABASE_TABLE_PRIVILEGES)[number];
export type DatabaseIdentityId = DatabaseIdentity['id'];
export type DatabaseUrlKey = DatabaseIdentity['urlKey'];

export interface CloudflareHyperdriveBinding {
  readonly binding: string;
  readonly idVariable: string;
}
export interface DatabaseIdentity {
  readonly cloudflareHyperdrive: CloudflareHyperdriveBinding | null;
  readonly gatewayScopeAudiences: readonly string[];
  readonly handlesBearerAssertions: boolean;
  readonly id: string;
  readonly ownerModuleKey: string | null;
  readonly registersGatewayScopeGrants: boolean;
  readonly role: string;
  /** The identity runs protected Actions, so it locks their access scope fence. */
  readonly runsActions: boolean;
  readonly scopeAuthority: DatabaseScopeAuthority;
  readonly urlKey: string;
}
export interface DatabaseTableGrant {
  readonly columns?: Readonly<Partial<Record<'select' | 'insert' | 'update', readonly string[]>>>;
  readonly privileges: readonly DatabaseTablePrivilege[];
  readonly reason: string;
  readonly table: string;
}
export interface DatabaseSequenceGrant {
  readonly privileges: readonly ('usage' | 'select')[];
  readonly reason: string;
  readonly sequence: string;
}
export interface DatabaseAcceptedFinding {
  readonly code: string;
  readonly objects: readonly string[] | 'all';
  readonly reason: string;
}
export interface DatabaseRoleGrants {
  readonly acceptedFindings: readonly DatabaseAcceptedFinding[];
  readonly routines: readonly string[];
  readonly schemas: readonly string[];
  readonly sequences: readonly DatabaseSequenceGrant[];
  readonly tables: readonly DatabaseTableGrant[];
}

/** Complete owner-authored enrollment facts. No executable registration or foreign schema is imported. */
export interface DatabaseOwnerIdentityDescriptor {
  readonly moduleKey: string;
  readonly policyPrefix: string;
  readonly request: DatabaseIdentity;
  readonly schemas: readonly string[];
  readonly worker: DatabaseIdentity;
}

/**
 * What one access decision reads and writes in `core`, as the least-privilege request identity sees it.
 *
 * Every entry is reached by `access/enforcement/**` or `access/intent/**` on the request path only:
 * the acting principal's kind (actor.ts), the scope, membership, live cells, connection and teams the
 * decision is taken from (tenant-intent-loader.ts), the tenant's companies (legal-entities.ts) and the
 * one evidence row a denial, an approval request or sensitive work appends (decision-log.ts). The
 * projection writer's catalog reads and the approval store's proposal, mandate and journal writes are
 * the worker's and the admin BFF's, never the request path's, so no request identity gets them here.
 *
 * This is a declaration, not authority: a composing role only ever receives the union of these
 * columns, and PostgreSQL row security still decides which tenant's rows the request may see.
 */
export const ACCESS_DECISION_REQUEST_GRANTS: readonly DatabaseTableGrant[] = Object.freeze([
  {
    columns: { select: ['revision', 'scope_id', 'state', 'tenant_id'] },
    privileges: ['select'],
    reason:
      'Core prepared Action authority compares persisted projection revisions before external I/O and under its writer fence',
    table: 'core.access_scope_fences',
  },
  {
    columns: { select: ['kind', 'principal_id', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/enforcement/actor.ts reads the acting principal kind before the engine is asked',
    table: 'core.principals',
  },
  {
    columns: { select: ['legal_entity_id', 'status', 'tenant_id'] },
    privileges: ['select'],
    reason:
      'Core access/enforcement/legal-entities.ts lists the companies the engine may then narrow, and a workload registration read joins the active ones (D6)',
    table: 'core.legal_entities',
  },
  {
    columns: { select: ['legal_entity_id', 'scope_id', 'tenant_context_id', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts resolves the scope a request asks in',
    table: 'core.access_scopes',
  },
  {
    columns: {
      select: [
        'agent_id',
        'created_at',
        'kind',
        'membership_id',
        'principal_id',
        'recorded_by',
        'scope_id',
        'status',
        'tenant_id',
        'valid_from',
        'valid_until',
      ],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the membership deadlines of every holder (D6)',
    table: 'core.access_memberships',
  },
  {
    columns: {
      select: [
        'agent_id',
        'assigned_by',
        'delegated_by',
        'delegation_envelope_json',
        'incarnation_id',
        'principal_id',
        'role_id',
        'role_revision_id',
        'scope_id',
        'status',
        'tenant_id',
        'valid_from',
        'valid_until',
      ],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the live assignments of the asked capability',
    table: 'core.access_assignments',
  },
  {
    columns: {
      select: [
        'catalog_snapshot_id',
        'cells_json',
        'created_at',
        'created_by',
        'provenance',
        'revision',
        'role_id',
        'role_revision_id',
        'template_key',
        'tenant_id',
      ],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the role revision a live assignment pins',
    table: 'core.access_role_revisions',
  },
  {
    columns: {
      select: ['capability_key', 'grant_incarnation_id', 'mode', 'role_id', 'scope_id', 'slot', 'status', 'tenant_id'],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the live grant incarnation of one cell',
    table: 'core.access_grant_incarnations',
  },
  {
    columns: {
      select: [
        'amount_ceiling_json',
        'capability_keys',
        'delegation_id',
        'granted_by',
        'manager_id',
        'people',
        'role_ids',
        'scope_id',
        'status',
        'tenant_id',
        'until',
        'valid_from',
      ],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the delegation that bounds a delegated cell',
    table: 'core.access_delegations',
  },
  {
    columns: {
      select: [
        'agent_id',
        'connection_id',
        'principal_id',
        'revision',
        'scope_id',
        'status',
        'tenant_id',
        'valid_from',
        'valid_until',
      ],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the agent connection a decision is asked for',
    table: 'core.access_agent_connections',
  },
  {
    columns: { select: ['ceiling_json', 'connection_id', 'revision', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the consent ceiling at the connection revision',
    table: 'core.access_consent_snapshots',
  },
  {
    columns: { select: ['agent_id', 'principal_id', 'team_id', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the teams a holder takes part in (team selector)',
    table: 'core.access_team_members',
  },
  {
    columns: { select: ['scope_id', 'team_id', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the team a team membership reaches',
    table: 'core.access_teams',
  },
  {
    columns: {
      select: [
        'action_key',
        'capability_key',
        'command_digest',
        'command_json',
        'created_at',
        'proposal_id',
        'scope_id',
        'tenant_id',
      ],
    },
    privileges: ['select'],
    reason: 'Core mandate dispatch reads the frozen command bound to the proposal (O75)',
    table: 'core.access_frozen_commands',
  },
  {
    columns: { select: ['binding_id', 'incarnation', 'principal_id', 'status', 'tenant_id', 'workload_key'] },
    privileges: ['select'],
    reason: 'Core access/workloads/bindings.ts reads the active workloads the acting workload is registered for (O73)',
    table: 'core.access_workload_bindings',
  },
  {
    columns: { select: ['legal_entity_id', 'status', 'tenant_id', 'workload_binding_id'] },
    privileges: ['select'],
    reason:
      'Core access/workloads/bindings.ts reads the companies a standalone workload is explicitly registered for (D6)',
    table: 'core.access_workload_company_bindings',
  },
  {
    columns: {
      insert: [
        'actor_json',
        'actor_principal_id',
        'admission_deadline',
        'capability_key',
        'correlation_id',
        'decided_at',
        'decision_log_id',
        'delegate_app_id',
        'delegate_principal_id',
        'mode',
        'on_behalf_of_principal_id',
        'operation_id',
        'outcome',
        'reasons_json',
        'scope_id',
        'target',
        'tenant_id',
      ],
    },
    privileges: ['insert'],
    // Drizzle names every column of the table in the insert (an unset one as `default`), and PostgreSQL
    // checks the column privilege for each named column, so the request path's unset `operation_id` needs it too.
    reason:
      'Core access/enforcement/decision-log.ts appends the evidence row of one denial, approval or sensitive allow',
    table: 'core.access_decision_logs',
  },
]);

export interface TrustRoutine {
  readonly executableBy: readonly string[];
  readonly securityDefiner: boolean;
  readonly signature: string;
}

const enrollmentBrand: unique symbol = Symbol('@app/core-runtime/db/DatabaseIdentityEnrollment');
export interface DatabaseIdentityEnrollment {
  readonly dedicatedModuleKeys: readonly string[];
  readonly [enrollmentBrand]: true;
  readonly identities: readonly DatabaseIdentity[];
  readonly owners: readonly DatabaseOwnerIdentityDescriptor[];
  readonly trustRoutines: readonly TrustRoutine[];
}

export class DatabaseIdentityEnrollmentError extends Schema.TaggedError<DatabaseIdentityEnrollmentError>()(
  'DatabaseIdentityEnrollmentError',
  { cause: Schema.optionalKey(Schema.Unknown), reason: Schema.String },
) {}

/** Routine vocabulary is Core-owned; executor membership comes only from the supplied enrollment. */
export const trustRoutinesForIdentities = (identities: readonly DatabaseIdentity[]): readonly TrustRoutine[] => {
  const registrars = identities.flatMap((identity) => (identity.registersGatewayScopeGrants ? [identity.role] : []));
  const requests = identities.flatMap((identity) =>
    identity.scopeAuthority === 'gateway_grant' ? [identity.role] : [],
  );
  const actionRunners = identities.flatMap((identity) => (identity.runsActions ? [identity.role] : []));
  const sharedRuntime = identities.flatMap((identity) =>
    identity.id === SHARED_RUNTIME_IDENTITY.id ? [identity.role] : [],
  );
  return Object.freeze([
    ...[
      { executableBy: sharedRuntime, signature: 'trust.open_source_execution_fence(uuid,uuid)' },
      { executableBy: sharedRuntime, signature: 'trust.open_source_execution_fence(uuid,uuid,uuid,text,text)' },
      { executableBy: [], signature: 'trust.register_source_execution_gated_action(text,text)' },
      {
        executableBy: [],
        signature: 'trust.publish_source_execution_gate(uuid,uuid,text,uuid,uuid,text,text,boolean,boolean)',
      },
      { executableBy: sharedRuntime, signature: 'trust.cancel_source_execution_fence(uuid,uuid)' },
      { executableBy: actionRunners, signature: 'trust.lock_source_execution_fence(uuid,uuid)' },
      { executableBy: actionRunners, signature: 'trust.read_source_execution_fence(uuid,uuid)' },
      {
        executableBy: [...sharedRuntime, ...requests],
        signature: 'trust.registered_workload_delivery_is_active(uuid,text,text,text,uuid)',
      },
      {
        executableBy: registrars,
        signature: 'trust.register_gateway_scope_grant(text,text,uuid,uuid,uuid,uuid,timestamptz)',
      },
      ...[
        'trust.establish_gateway_scope(text)',
        'trust.current_tenant_id()',
        'trust.current_legal_entity_id()',
        'trust.auth_binding_issuing_legal_entity(uuid,uuid)',
      ].map((signature) => ({ executableBy: requests, signature })),
      {
        executableBy: actionRunners,
        signature: 'trust.lock_access_scope_fence(uuid,uuid)',
      },
    ].map(({ executableBy, signature }) =>
      Object.freeze({ executableBy: Object.freeze([...executableBy]), securityDefiner: true, signature }),
    ),
    ...['trust.verified_scope()', 'trust.scope_payload(xid8,timestamptz,uuid,uuid)', 'trust.scope_mac(text)'].map(
      (signature) => Object.freeze({ executableBy: Object.freeze([]), securityDefiner: false, signature }),
    ),
  ]);
};

const IdentifierSchema = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,62}$/u)));
const VariableSchema = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u)));
const ModuleKeySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u)),
  Schema.brand('DatabaseOwnerModuleKey'),
);
const AudienceSchema = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)));
const IdentitySchema = Schema.Struct({
  cloudflareHyperdrive: Schema.OptionFromNullOr(Schema.Struct({ binding: VariableSchema, idVariable: VariableSchema })),
  gatewayScopeAudiences: Schema.Array(AudienceSchema),
  handlesBearerAssertions: Schema.Boolean,
  id: IdentifierSchema,
  ownerModuleKey: Schema.OptionFromNullOr(ModuleKeySchema),
  registersGatewayScopeGrants: Schema.Boolean,
  role: IdentifierSchema,
  runsActions: Schema.Boolean,
  scopeAuthority: Schema.Literals(DATABASE_SCOPE_AUTHORITIES),
  urlKey: VariableSchema.pipe(Schema.brand('DatabaseUrlKey')),
});
const DescriptorSchema = Schema.Struct({
  moduleKey: ModuleKeySchema,
  policyPrefix: IdentifierSchema,
  request: IdentitySchema,
  schemas: Schema.Array(IdentifierSchema),
  worker: IdentitySchema,
});
const decodeDescriptors = Schema.decodeUnknownResult(Schema.Array(DescriptorSchema), { onExcessProperty: 'error' });
const freezeDecodedIdentity = (identity: typeof IdentitySchema.Type): DatabaseIdentity =>
  freezeIdentity({
    ...identity,
    cloudflareHyperdrive: Option.getOrNull(identity.cloudflareHyperdrive),
    ownerModuleKey: Option.getOrNull(identity.ownerModuleKey),
  });
const invalidEnrollment = (reason: string): never => {
  throw new DatabaseIdentityEnrollmentError({ reason });
};
const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) {
    invalidEnrollment(`Database identity enrollment has duplicate ${label}`);
  }
};
const reservedRole = (role: string): boolean => role === 'public' || role === 'postgres' || role.startsWith('pg_');
const PLATFORM_SCHEMAS = new Set(['auth', 'core', 'drizzle', 'email', 'information_schema', 'public', 'trust']);

/** Each application explicitly validates and freezes its complete owner graph. There is no global registry. */
export const defineDatabaseIdentityEnrollment = (
  descriptors: readonly DatabaseOwnerIdentityDescriptor[],
): DatabaseIdentityEnrollment => {
  const decoded = Result.getOrThrow(
    decodeDescriptors(descriptors).pipe(
      Result.mapError(
        (cause) =>
          new DatabaseIdentityEnrollmentError({
            cause,
            reason: 'Database identity enrollment descriptors are invalid',
          }),
      ),
    ),
  );
  const owners = decoded.map((owner) => {
    const request = freezeDecodedIdentity(owner.request);
    const worker = freezeDecodedIdentity(owner.worker);
    if (
      request.ownerModuleKey !== owner.moduleKey ||
      worker.ownerModuleKey !== owner.moduleKey ||
      request.scopeAuthority !== 'gateway_grant' ||
      !request.handlesBearerAssertions ||
      request.registersGatewayScopeGrants ||
      request.gatewayScopeAudiences.length === 0 ||
      worker.scopeAuthority !== 'session_setting' ||
      worker.handlesBearerAssertions ||
      worker.registersGatewayScopeGrants ||
      worker.gatewayScopeAudiences.length !== 0 ||
      worker.cloudflareHyperdrive !== null ||
      reservedRole(request.role) ||
      reservedRole(worker.role) ||
      owner.schemas.length === 0 ||
      owner.schemas.some((schema) => PLATFORM_SCHEMAS.has(schema) || schema.startsWith('pg_'))
    ) {
      invalidEnrollment('An owner descriptor has inconsistent identity authority or schema ownership');
    }
    return Object.freeze({
      moduleKey: owner.moduleKey,
      policyPrefix: owner.policyPrefix,
      request,
      schemas: Object.freeze([...owner.schemas]),
      worker,
    });
  });
  const identities = Object.freeze([
    SHARED_RUNTIME_IDENTITY,
    SHELL_GATEWAY_ISSUER_IDENTITY,
    ...owners.flatMap(({ request, worker }) => [request, worker]),
  ]);
  assertUnique(
    owners.map(({ moduleKey }) => moduleKey),
    'module keys',
  );
  assertUnique(
    owners.map(({ policyPrefix }) => policyPrefix),
    'policy prefixes',
  );
  assertUnique(
    owners.flatMap(({ schemas }) => schemas),
    'schema owners',
  );
  assertUnique(
    identities.map(({ id }) => id),
    'identity ids',
  );
  assertUnique(
    identities.map(({ role }) => role),
    'roles',
  );
  assertUnique(
    identities.map(({ urlKey }) => urlKey),
    'URL keys',
  );
  assertUnique(
    identities.flatMap(({ gatewayScopeAudiences }) => gatewayScopeAudiences),
    'gateway audiences',
  );
  assertUnique(
    identities.flatMap(({ cloudflareHyperdrive }) =>
      cloudflareHyperdrive === null ? [] : [cloudflareHyperdrive.binding],
    ),
    'Hyperdrive bindings',
  );
  assertUnique(
    identities.flatMap(({ cloudflareHyperdrive }) =>
      cloudflareHyperdrive === null ? [] : [cloudflareHyperdrive.idVariable],
    ),
    'Hyperdrive variables',
  );
  return Object.freeze({
    dedicatedModuleKeys: Object.freeze(owners.map(({ moduleKey }) => moduleKey)),
    [enrollmentBrand]: true as const,
    identities,
    owners: Object.freeze(owners),
    trustRoutines: trustRoutinesForIdentities(identities),
  });
};
