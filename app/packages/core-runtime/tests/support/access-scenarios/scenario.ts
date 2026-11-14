import type { PgClient } from '@effect/sql-pg';
import { DateTime, Effect, Schema } from 'effect';
import type { Ref } from 'effect';

import type { AccessCatalogModule } from '../../../src/authorization/access-declaration.ts';
import type { BootstrapTenantAccessResult } from '../../../src/access/bootstrap/bootstrap-tenant-access.ts';
import { grantIncarnationId } from '../../../src/access/intent/grant-incarnations.ts';
import type { AccessChangesStoreService } from '../../../src/access/changes/persistence/store.ts';
import { capabilitySlot } from '../../../src/access/compiler/object-id.ts';
import type { AccessDecision } from '../../../src/access/decision/contract.ts';
import type { AccessDecisionService, GateInput } from '../../../src/access/enforcement/contract.ts';
import type { OwnerAccessFacts } from '../../../src/access/enforcement/owner-overlay.ts';
import { AccessScopeIdSchema, CapabilityKeySchema, CurrencyCodeSchema, RoleIdSchema } from '../../../src/access/ids.ts';
import type { TenantId } from '../../../src/access/ids.ts';
import type { AccessProjectionWriterService } from '../../../src/access/intent/projection-writer.ts';
import type { Cell } from '../../../src/access/model.ts';
import type { ActionRuntimeService } from '../../../src/actions/runtime.ts';
import { TrustedPrincipalContextSchema } from '../../../src/actions/principal-context.ts';
import type { BoundAccessGate } from '../../../src/operations/access-gate.ts';
import type { OperationalScope } from '../../../src/operations/context.ts';
import type { ReadRuntimeService } from '../../../src/reads/runtime.ts';

/*
 * The cutover scenario fixtures (C20). This module holds only what a scenario *is* — the shape the
 * suite hands around, and the SQL the suite writes directly. The Effect layer composition (the real
 * gate over `AccessDecisionLive` + `AccessEnforcementPortsLive` + `TenantIntentLoaderLive`, and the
 * real Action/Read runtimes wired to it) lives in the suite itself, because that composition is the
 * test code and never a runtime factory (anti-slop-effect/no-service-constructor-imports).
 *
 * No scripted gate is ever installed: a scenario's answer comes from the engine, through the seam,
 * into the runner.
 */

/** The fixed instant every direct gate question asks at; runners mint their own transaction time. */
export const DECISION_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00.000Z'));

/** The `cells_json` text one row stores, built by the model's own JSON codec. */
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** One principal of the seeded tenant: its identity row kind decides which path may admit it. */
export interface SeededPrincipal {
  readonly kind: 'agent' | 'human' | 'integration' | 'service' | 'system';
  readonly principalId: string;
}

export interface SeedTenantInput {
  readonly legalEntityIds: readonly string[];
  readonly moduleKeys: readonly string[];
  readonly principals: readonly SeededPrincipal[];
  readonly tenantId: string;
}

/** One role a scenario needs for its own scope: a run cell per named capability (O51). */
export interface SeededRoleInput {
  /** The one ceiling every cell of this role carries; omitted means an uncapped cell (O18). */
  readonly amountCeiling?: { readonly currency: string; readonly limitMinor: number };
  readonly capabilityKeys: readonly string[];
  readonly catalogSnapshotId: string;
  /** The human who authored the role; `access_roles.created_by` is a verified human (O46). */
  readonly createdBy: string;
  /** Required when the role grants explicit record targets in one Legal Entity. */
  readonly legalEntityId?: string;
  readonly roleId: string;
  readonly roleRevisionId: string;
  readonly scopeId: string;
  /** Omit to grant the capability on every permitted record in the scope. */
  readonly selector?: Cell['selector'];
}

/** The services one composed scenario carries; the suite resolves them and hands them in. */
export interface ScenarioServices {
  readonly admin: PgClient.PgClient;
  readonly bootstrap: (input: {
    readonly legalEntityIds: readonly string[];
    readonly modules: readonly AccessCatalogModule[];
    readonly principalId: string;
  }) => Effect.Effect<BootstrapTenantAccessResult>;
  readonly changes: AccessChangesStoreService;
  /** The whole live gate, for a scenario that asks a batch or the company list as well as one decision. */
  readonly decisionGate: AccessDecisionService;
  readonly gate: (input: GateInput) => Effect.Effect<AccessDecision>;
  readonly ownerOverlayFacts: Ref.Ref<readonly (OwnerAccessFacts | undefined)[]>;
  readonly runAction: ActionRuntimeService['runAction'];
  readonly runActionUnavailable: ActionRuntimeService['runAction'];
  readonly runRead: ReadRuntimeService['runRead'];
  readonly runReadUnavailable: ReadRuntimeService['runRead'];
  readonly tenantId: TenantId;
  readonly unavailableGate: BoundAccessGate;
  readonly writer: AccessProjectionWriterService;
}

export interface AccessScenario extends Omit<ScenarioServices, 'gate'> {
  /** Registers one workload key for a seeded principal, as the install/bootstrap path does (O73). */
  readonly bindWorkload: (input: { readonly principalId: string; readonly workloadKey: string }) => Effect.Effect<void>;
  /** One protected request, asked the way an entrypoint asks it, at the fixed instant. */
  readonly decide: (input: {
    readonly carrier: GateInput['carrier'];
    readonly legalEntityId?: string | undefined;
    readonly legalEntityScope: GateInput['legalEntityScope'];
    readonly principalId: string;
  }) => Effect.Effect<AccessDecision>;
  /** Ends one registered workload binding; a revoked binding is never reopened (O73). */
  /** Registers one company for the active binding of one workload key (D6), or ends that registration. */
  readonly registerWorkloadCompany: (input: {
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly workloadKey: string;
  }) => Effect.Effect<void>;
  readonly revokeWorkload: (input: {
    readonly principalId: string;
    readonly workloadKey: string;
  }) => Effect.Effect<void>;
  readonly revokeWorkloadCompany: (input: {
    readonly principalId: string;
    readonly workloadKey: string;
  }) => Effect.Effect<void>;
  /** One trusted request scope of this tenant (O66). */
  readonly scopeFor: (principalId: string, legalEntityId?: string) => Effect.Effect<OperationalScope>;
  readonly seedTenant: (input: Omit<SeedTenantInput, 'tenantId'>) => Effect.Effect<void>;
}

const decodeScope = Schema.decodeUnknownEffect(TrustedPrincipalContextSchema);

/** One trusted request scope: the acting person, the tenant and, when given, the selected company. */
export const scopeOf = (input: {
  readonly legalEntityId?: string | undefined;
  readonly principalId: string;
  readonly tenantId: string;
}): Effect.Effect<OperationalScope> => {
  const session = {
    authBindingId: input.principalId,
    authContextRef: `session:c20:${input.principalId}`,
    authenticationNamespaceId: 'c20.session.v1',
    authMethod: 'session' as const,
    principalId: input.principalId,
    tenantId: input.tenantId,
  };
  return decodeScope(
    input.legalEntityId === undefined ? session : { ...session, legalEntityId: input.legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-cutover-scenarios' }) satisfies OperationalScope),
    Effect.orDie,
  );
};

/** The tenant-context scope of the tenant: the scope every legal-entity decision also rests on. */
export const tenantScopeIdOf = (admin: PgClient.PgClient, tenantId: TenantId) =>
  admin
    .unsafe<{ readonly scope_id: string }>(
      `select scope_id from core.access_scopes
       where tenant_id = '${tenantId}' and tenant_context_id is not null`,
    )
    .pipe(
      Effect.map((rows) => rows[0]?.scope_id ?? ''),
      Effect.orDie,
    );

/** The legal-entity scope of one company. */
export const legalEntityScopeIdOf = (admin: PgClient.PgClient, tenantId: TenantId, legalEntityId: string) =>
  admin
    .unsafe<{ readonly scope_id: string }>(
      `select scope_id from core.access_scopes
       where tenant_id = '${tenantId}' and legal_entity_id = '${legalEntityId}'`,
    )
    .pipe(
      Effect.map((rows) => rows[0]?.scope_id ?? ''),
      Effect.orDie,
    );

/** The tenant's identity rows and installations: exactly what a product tenant starts with. */
export const seedTenantRows = (admin: PgClient.PgClient, input: SeedTenantInput) =>
  Effect.gen(function* seedTenantRowsEffect() {
    yield* admin.unsafe(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale)
         values ('${input.tenantId}', 'c20-${input.tenantId.slice(-8)}', 'C20 scenario tenant', 'active', 'cs')`,
    );
    for (const legalEntityId of input.legalEntityIds) {
      yield* admin.unsafe(
        `insert into core.legal_entities
             (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
           values ('${legalEntityId}', '${input.tenantId}', 'C20 entity', 'CZ', '${legalEntityId.slice(-8)}', 'active')`,
      );
    }
    for (const principal of input.principals) {
      yield* admin.unsafe(
        `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
           values ('${principal.principalId}', '${input.tenantId}', '${principal.kind}', 'C20 principal', 'active')`,
      );
      // The runtimes persist the request's auth binding, so a scope's binding id must name a real
      // binding row of this tenant (the invocation evidence carries the foreign key).
      yield* admin.unsafe(
        `insert into core.principal_auth_bindings
             (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider,
              subject_type, provider_subject_id, status)
           values ('${principal.principalId}', '${input.tenantId}', '${principal.principalId}', 'c20.session.v1',
                   'c20', 'user', '${principal.principalId}', 'active')`,
      );
    }
    for (const moduleKey of input.moduleKeys) {
      yield* admin.unsafe(
        `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state)
           values (gen_random_uuid(), '${input.tenantId}', '${moduleKey}', 'active')`,
      );
    }
  }).pipe(Effect.orDie);

/** One live membership of a seeded holder; the deadline source of D6. */
export const insertMembership = (
  admin: PgClient.PgClient,
  tenantId: TenantId,
  input: {
    readonly agentId?: string;
    readonly kind: 'access_admin' | 'member' | 'owner';
    readonly principalId?: string;
    /** The human who recorded the membership; `recorded_by` is a verified human (O46). */
    readonly recordedBy: string;
    readonly scopeId: string;
    /** Raw SQL expressions, so a scenario can start or end a membership in the past. */
    readonly validFrom?: string;
    readonly validUntil?: string;
  },
) => {
  const column = input.agentId === undefined ? 'principal_id' : 'agent_id';
  const holder = input.agentId ?? input.principalId;
  const validFrom = input.validFrom ?? "now() - interval '1 day'";
  const validUntil = input.validUntil ?? 'null';
  return admin
    .unsafe(
      `insert into core.access_memberships
         (membership_id, tenant_id, scope_id, ${column}, kind, status, valid_from, valid_until, recorded_by)
       values (gen_random_uuid(), '${tenantId}', '${input.scopeId}', '${holder}', '${input.kind}', 'active',
               ${validFrom}, ${validUntil}, '${input.recordedBy}')`,
    )
    .pipe(Effect.orDie);
};

/** One active assignment of an existing role revision in one scope; its grant incarnations exist. */
export const insertAssignment = (
  admin: PgClient.PgClient,
  tenantId: TenantId,
  input: {
    readonly agentId?: string;
    readonly assignedBy: string;
    readonly delegatedBy?: string;
    readonly delegationEnvelopeJson?: string;
    readonly incarnationId: string;
    readonly principalId?: string;
    readonly roleId: string;
    readonly roleRevisionId: string;
    readonly scopeId: string;
    /** A raw SQL expression, so a scenario can end an assignment in the past. */
    readonly validUntil?: string;
  },
) => {
  const column = input.agentId === undefined ? 'principal_id' : 'agent_id';
  const holder = input.agentId ?? input.principalId;
  const validUntil = input.validUntil ?? 'null';
  const delegatedBy = input.delegatedBy === undefined ? 'null' : `'${input.delegatedBy}'`;
  const envelope = input.delegationEnvelopeJson === undefined ? 'null' : `'${input.delegationEnvelopeJson}'::jsonb`;
  return admin
    .unsafe(
      `insert into core.access_assignments
         (incarnation_id, tenant_id, scope_id, ${column}, role_id, role_revision_id, status, assigned_by,
          valid_from, valid_until, delegated_by, delegation_envelope_json)
       values ('${input.incarnationId}', '${tenantId}', '${input.scopeId}', '${holder}', '${input.roleId}',
               '${input.roleRevisionId}', 'active', '${input.assignedBy}', now() - interval '1 day',
               ${validUntil}, ${delegatedBy}, ${envelope})`,
    )
    .pipe(Effect.orDie);
};

/**
 * Writes one role, its first revision and one grant incarnation per cell and scope — exactly the rows
 * `bootstrapTenantAccess` writes, so a scenario can give a holder a capability of its own without the
 * full-access role. A cell without its grant incarnation grants nothing (guarantee 9).
 */
export const insertRoleWithCells = (
  admin: PgClient.PgClient,
  tenantId: TenantId,
  input: SeededRoleInput,
): Effect.Effect<void> =>
  Effect.gen(function* insertRoleWithCellsEffect() {
    const ceiling = input.amountCeiling;
    const cells: readonly Cell[] = input.capabilityKeys.map((key) => {
      const base = {
        capabilityKey: CapabilityKeySchema.make(key),
        mode: 'run' as const,
        selector: input.selector ?? { _tag: 'all' as const },
      };
      return ceiling === undefined
        ? base
        : {
            ...base,
            amountCeiling: {
              currency: CurrencyCodeSchema.make(ceiling.currency),
              limitMinor: ceiling.limitMinor,
            },
          };
    });
    const roleId = RoleIdSchema.make(input.roleId);
    const scopeId = AccessScopeIdSchema.make(input.scopeId);
    yield* admin.unsafe(
      `insert into core.access_roles (role_id, tenant_id, created_by, legal_entity_id, name)
         values ($1, $2, $3, $4, 'C20 scenario role')`,
      [input.roleId, tenantId, input.createdBy, input.legalEntityId ?? null],
    );
    yield* admin.unsafe(
      `insert into core.access_role_revisions
           (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
         values ('${input.roleRevisionId}', '${tenantId}', '${input.roleId}', 1, '${input.catalogSnapshotId}',
                 '${jsonText(cells)}'::jsonb, '${input.createdBy}', 'manual')`,
    );
    for (const cell of cells) {
      yield* admin.unsafe(
        `insert into core.access_grant_incarnations
             (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
           values ('${grantIncarnationId({ cell, roleId, scopeId, tenantId })}', '${tenantId}', '${scopeId}',
                   '${roleId}', '${cell.capabilityKey}', '${cell.mode}', '${capabilitySlot(cell)}',
                   '${jsonText(cell)}'::jsonb, 'active')`,
      );
    }
  }).pipe(Effect.orDie);

/** One registered workload key for a seeded principal, exactly the row the install path writes (O73). */
export const insertWorkloadBinding = (
  admin: PgClient.PgClient,
  tenantId: TenantId,
  input: { readonly principalId: string; readonly workloadKey: string },
) =>
  admin
    .unsafe(
      `insert into core.access_workload_bindings
         (binding_id, tenant_id, principal_id, workload_key, status, incarnation, created_at)
       values (gen_random_uuid(), '${tenantId}', '${input.principalId}', '${input.workloadKey}', 'active',
               gen_random_uuid(), now())`,
    )
    .pipe(Effect.orDie);

/** Ends one registered workload binding: the same row becomes `revoked`, exactly as Core revokes it (O73). */
export const revokeWorkloadBinding = (
  admin: PgClient.PgClient,
  tenantId: TenantId,
  input: { readonly principalId: string; readonly workloadKey: string },
) =>
  admin
    .unsafe(
      `update core.access_workload_bindings set status = 'revoked', revoked_at = now()
       where tenant_id = '${tenantId}' and principal_id = '${input.principalId}'
         and workload_key = '${input.workloadKey}' and status = 'active'`,
    )
    .pipe(Effect.orDie);

/** One company registration for the active binding of a workload key, exactly the row Core writes (D6). */
export const insertWorkloadCompanyBinding = (
  admin: PgClient.PgClient,
  tenantId: TenantId,
  input: { readonly legalEntityId: string; readonly principalId: string; readonly workloadKey: string },
) =>
  admin
    .unsafe(
      `insert into core.access_workload_company_bindings
         (company_binding_id, tenant_id, workload_binding_id, legal_entity_id, status, incarnation, created_at)
       select gen_random_uuid(), tenant_id, binding_id, '${input.legalEntityId}', 'active', gen_random_uuid(), now()
         from core.access_workload_bindings
        where tenant_id = '${tenantId}' and principal_id = '${input.principalId}'
          and workload_key = '${input.workloadKey}' and status = 'active'`,
    )
    .pipe(Effect.orDie);

/** Ends the company registration of one workload key's active binding, exactly as Core revokes it (D6). */
export const revokeWorkloadCompanyBinding = (
  admin: PgClient.PgClient,
  tenantId: TenantId,
  input: { readonly principalId: string; readonly workloadKey: string },
) =>
  admin
    .unsafe(
      `update core.access_workload_company_bindings as c set status = 'revoked', revoked_at = now()
         from core.access_workload_bindings as b
        where c.tenant_id = '${tenantId}' and b.tenant_id = c.tenant_id and b.binding_id = c.workload_binding_id
          and b.principal_id = '${input.principalId}' and b.workload_key = '${input.workloadKey}'
          and c.status = 'active'`,
    )
    .pipe(Effect.orDie);

/** One composed scenario: the services the suite resolved, plus the questions a scenario asks. */
export const scenarioOf = (services: ScenarioServices): AccessScenario => {
  const { gate, tenantId, ...rest } = services;
  return {
    ...rest,
    bindWorkload: (input) => insertWorkloadBinding(services.admin, tenantId, input),
    decide: (input) =>
      scopeOf({ legalEntityId: input.legalEntityId, principalId: input.principalId, tenantId }).pipe(
        Effect.flatMap((scope) =>
          gate({
            carrier: input.carrier,
            legalEntityScope: input.legalEntityScope,
            now: DECISION_AT,
            scope,
          }),
        ),
      ),
    registerWorkloadCompany: (input) => insertWorkloadCompanyBinding(services.admin, tenantId, input),
    revokeWorkload: (input) => revokeWorkloadBinding(services.admin, tenantId, input),
    revokeWorkloadCompany: (input) => revokeWorkloadCompanyBinding(services.admin, tenantId, input),
    scopeFor: (principalId, legalEntityId) => scopeOf({ legalEntityId, principalId, tenantId }),
    seedTenant: (input) => seedTenantRows(services.admin, { ...input, tenantId }),
    tenantId,
  };
};
