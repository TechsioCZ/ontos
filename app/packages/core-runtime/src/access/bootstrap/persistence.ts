import { Effect, Match, Schema } from 'effect';

import type { AccessIntentDatabase } from '../intent/persistence.ts';
import type { AccessIntentError } from '../intent/errors.ts';
import { intentConflict } from '../intent/errors.ts';
import { durable, runScoped, scopeIssue } from '../intent/persistence.ts';
import { writeGrantIncarnations } from '../intent/grant-incarnations.ts';
import { stableUuid } from '../catalog/stable-id.ts';
import { AccessScopeIdSchema, LegalEntityIdSchema } from '../ids.ts';
import type { AccessScopeId, LegalEntityId, PrincipalId, RoleId, RoleRevisionId, TenantId } from '../ids.ts';
import type { Cell } from '../model.ts';
import { accessAssignments, accessScopeFences, accessScopes } from '../../db/schema.ts';
import type { OperationalScope } from '../../operations/context.ts';

/*
 * The rows a tenant bootstrap writes beside the memberships and the role it records through their own
 * stores: the tenant's access scopes, the one fence of each scope, and the owner's assignment with the
 * grant incarnations its role cells own.
 *
 * Every identifier is derived from what it names, so a bootstrap that runs twice resumes the tenant it
 * already created instead of building a second one (D27): the tenant context scope of a tenant, the
 * scope of one legal entity, the owner's assignment of one role, and one grant incarnation per exact cell
 * slot (O51(2)). Inserts are therefore conflict-free on a re-run, and a revoked membership or a narrowed
 * role is never silently resurrected by a later bootstrap.
 */

/** The two contexts an access scope can be: the tenant itself, or one of its companies. */
export const BootstrapScopeSchema = Schema.Union([
  Schema.TaggedStruct('TenantContext', { scopeId: AccessScopeIdSchema }),
  Schema.TaggedStruct('LegalEntity', { legalEntityId: LegalEntityIdSchema, scopeId: AccessScopeIdSchema }),
]);
export type BootstrapScope = typeof BootstrapScopeSchema.Type;

/**
 * The context columns of one scope row: exactly one of the tenant context and the legal entity is set,
 * which is the table's own XOR and never a null legal entity meaning "every company".
 */
const scopeIdentityOf = (
  tenantId: TenantId,
  entry: BootstrapScope,
): { readonly legalEntityId: LegalEntityId | null; readonly tenantContextId: TenantId | null } =>
  Match.value(entry).pipe(
    Match.tag('TenantContext', () => ({ legalEntityId: null, tenantContextId: tenantId })),
    Match.tag('LegalEntity', ({ legalEntityId }) => ({ legalEntityId, tenantContextId: null })),
    Match.exhaustive,
  );

/** The tenant context scope: the scope that speaks for the whole tenant and holds its fence. */
export const tenantContextScopeId = (tenantId: TenantId): AccessScopeId =>
  AccessScopeIdSchema.make(stableUuid(`ontos.access.bootstrap.tenant-scope:${tenantId}`));

export const legalEntityScopeId = (tenantId: TenantId, legalEntityId: LegalEntityId): AccessScopeId =>
  AccessScopeIdSchema.make(stableUuid(`ontos.access.bootstrap.legal-entity-scope:${tenantId}:${legalEntityId}`));

/** The scopes a new tenant starts with: its own context first, then one per company (O7). */
export const bootstrapScopesOf = (
  tenantId: TenantId,
  legalEntityIds: readonly LegalEntityId[],
): readonly BootstrapScope[] => [
  { _tag: 'TenantContext', scopeId: tenantContextScopeId(tenantId) },
  ...legalEntityIds.map((legalEntityId): BootstrapScope => ({
    _tag: 'LegalEntity',
    legalEntityId,
    scopeId: legalEntityScopeId(tenantId, legalEntityId),
  })),
];

/** The assignment of one role to the owner inside one scope: one incarnation, never reused. */
export const ownerAssignmentIncarnationId = (tenantId: TenantId, scopeId: AccessScopeId, roleId: RoleId): string =>
  stableUuid(`ontos.access.bootstrap.assignment:${tenantId}:${scopeId}:${roleId}`);

/**
 * The unique indexes the scope and fence writes can collide on. A collision is a re-run that found the
 * row it would have written, which the caller repairs by reading the tenant again.
 */
const SCOPE_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_scope_fences_pkey',
  'access_scopes_legal_entity_uk',
  'access_scopes_pkey',
  'access_scopes_tenant_context_uk',
  'access_scopes_tenant_id_uk',
]);

const ASSIGNMENT_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_assignments_pkey',
  'access_assignments_scope_uk',
  'access_assignments_tenant_id_uk',
  'access_grants_cell_uk',
  'access_grants_pkey',
  'access_grants_scope_uk',
  'access_grants_tenant_id_uk',
]);

const requireTenant = (scope: OperationalScope, tenantId: TenantId): Effect.Effect<void, AccessIntentError> => {
  const issue = scopeIssue(scope, [tenantId]);
  return issue === null ? Effect.void : Effect.fail(intentConflict('access_intent_scope_mismatch', issue));
};

export interface WriteBootstrapScopesInput {
  readonly scopes: readonly BootstrapScope[];
  readonly tenantId: TenantId;
}

/**
 * Creates the scopes of a tenant together with the fence of each one. A scope without a fence can never
 * be projected (D15), so the two rows are one write: a tenant either has a writable scope or none.
 */
export const writeBootstrapScopes = (
  database: AccessIntentDatabase,
  scope: OperationalScope,
  input: WriteBootstrapScopesInput,
): Effect.Effect<void, AccessIntentError> =>
  requireTenant(scope, input.tenantId).pipe(
    Effect.andThen(
      runScoped(database, scope, SCOPE_UNIQUE_CONSTRAINTS, (transaction) =>
        Effect.all(
          [
            transaction
              .insert(accessScopes)
              .values(
                input.scopes.map((entry) => ({
                  ...scopeIdentityOf(input.tenantId, entry),
                  scopeId: entry.scopeId,
                  tenantId: input.tenantId,
                })),
              )
              .onConflictDoNothing()
              .pipe(durable(SCOPE_UNIQUE_CONSTRAINTS), Effect.asVoid),
            transaction
              .insert(accessScopeFences)
              .values(
                input.scopes.map((entry) => ({
                  owningOperationId: null,
                  revision: 1,
                  scopeId: entry.scopeId,
                  state: 'Ready' as const,
                  tenantId: input.tenantId,
                })),
              )
              .onConflictDoNothing()
              .pipe(durable(SCOPE_UNIQUE_CONSTRAINTS), Effect.asVoid),
          ],
          { concurrency: 1, discard: true },
        ),
      ),
    ),
  );

export interface WriteOwnerAssignmentsInput {
  /** The cells the pinned role revision grants; each one owns an incarnation in every scope. */
  readonly cells: readonly Cell[];
  readonly principalId: PrincipalId;
  readonly roleId: RoleId;
  readonly roleRevisionId: RoleRevisionId;
  readonly scopes: readonly BootstrapScope[];
  readonly tenantId: TenantId;
  readonly validFrom: Date;
}

/**
 * Assigns one role to the owner in every scope of the tenant, with one grant incarnation per cell and
 * scope. The incarnation is what a decision reads as its witness (guarantee 9), so a role without one
 * grants nothing; both rows are written together, through the one incarnation writer the Novinky role
 * edits use too.
 */
export const writeOwnerAssignments = (
  database: AccessIntentDatabase,
  scope: OperationalScope,
  input: WriteOwnerAssignmentsInput,
): Effect.Effect<void, AccessIntentError> =>
  requireTenant(scope, input.tenantId).pipe(
    Effect.andThen(
      runScoped(database, scope, ASSIGNMENT_UNIQUE_CONSTRAINTS, (transaction) =>
        Effect.all(
          [
            transaction
              .insert(accessAssignments)
              .values(
                input.scopes.map((entry) => ({
                  assignedBy: input.principalId,
                  incarnationId: ownerAssignmentIncarnationId(input.tenantId, entry.scopeId, input.roleId),
                  principalId: input.principalId,
                  roleId: input.roleId,
                  roleRevisionId: input.roleRevisionId,
                  scopeId: entry.scopeId,
                  status: 'active' as const,
                  tenantId: input.tenantId,
                  validFrom: input.validFrom,
                })),
              )
              .onConflictDoNothing()
              .pipe(durable(ASSIGNMENT_UNIQUE_CONSTRAINTS), Effect.asVoid),
            // The first revision of the owner's role: every cell is an addition and none is retired.
            writeGrantIncarnations(transaction, {
              addedCells: input.cells,
              removedCells: [],
              roleId: input.roleId,
              scopeIds: input.scopes.map((entry) => entry.scopeId),
              targetRevisionId: input.roleRevisionId,
              tenantId: input.tenantId,
            }).pipe(durable(ASSIGNMENT_UNIQUE_CONSTRAINTS), Effect.asVoid),
          ],
          { concurrency: 1, discard: true },
        ),
      ),
    ),
  );
