// @ontos-action-owner core.identity
// @ontos-action-slug manage-demo-account
/**
 * Sales-demo account administration (development only). A company administrator creates a human staff account,
 * changes its demo role or deactivates / reactivates it. The Action owns the Core rows (principal, staff auth
 * binding, principal status) and the audit evidence; the shell endpoint that runs it writes the Better Auth user
 * and copies the role's SpiceDB grants after the Action committed (see `demo-account-administration.ts`).
 *
 * Unlike `core.identity.change-principal-status`, which is limited to non-human principals, this Action targets
 * human principals, so the deactivated person is rejected by the principal resolver on the next request.
 *
 * Agent entities (kind `agent`): `create-agent` / `configure-agent` store write policy, module access, description and owner in the audit evidence; `change-status` (de)activates agents; `archive-agent` deletes an agent (status `archived`, kept for the audit trail).
 */
import { and, eq } from 'drizzle-orm';
import { Config, DateTime, Effect, Schema } from 'effect';

import type { ActionHandlerContext } from '../../actions/context.ts';
import { defineAction } from '../../actions/definition.ts';
import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
  PrincipalManagementErrorSchema,
} from '../../auth/principal-management-errors.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../auth/staff-authentication-namespace.ts';
import { principalAuthBindings, principals } from '../../db/schema.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import { defineSystemModuleEntrypoint } from '../module-entrypoint.ts';

const uuid = Schema.String.check(Schema.isUUID());
const text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const roleKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const status = Schema.Literals(['active', 'disabled']);
const writePolicy = Schema.Literals(['read_only', 'direct', 'approval']);
const modulesJson = text(8000);

export const ManageDemoAccountPayloadSchema = Schema.Union([
  Schema.Struct({
    authBindingId: uuid,
    authUserId: text(120),
    displayName: text(200),
    email: text(320),
    operation: Schema.Literal('create'),
    principalId: uuid,
    roleKey,
    roleLabel: text(120),
  }),
  Schema.Struct({
    operation: Schema.Literal('change-role'),
    previousRoleKey: Schema.NullOr(roleKey),
    previousRoleLabel: Schema.NullOr(text(120)),
    principalId: uuid,
    roleKey,
    roleLabel: text(120),
  }),
  Schema.Struct({
    expectedStatus: status,
    newStatus: status,
    operation: Schema.Literal('change-status'),
    principalId: uuid,
    reason: Schema.optionalKey(text(500)),
  }),
  Schema.Struct({
    description: Schema.NullOr(text(500)),
    displayName: text(200),
    modulesJson,
    operation: Schema.Literal('create-agent'),
    ownerPrincipalId: Schema.NullOr(uuid),
    principalId: uuid,
    writePolicy,
  }),
  Schema.Struct({
    description: Schema.NullOr(text(500)),
    displayName: text(200),
    modulesJson,
    operation: Schema.Literal('configure-agent'),
    ownerPrincipalId: Schema.NullOr(uuid),
    previousModulesJson: Schema.NullOr(modulesJson),
    previousWritePolicy: Schema.NullOr(writePolicy),
    principalId: uuid,
    writePolicy,
  }),
  Schema.Struct({
    expectedStatus: status,
    operation: Schema.Literal('archive-agent'),
    principalId: uuid,
    reason: text(500),
  }),
]);
export type ManageDemoAccountPayload = typeof ManageDemoAccountPayloadSchema.Type;

export const ManageDemoAccountResultSchema = Schema.Struct({
  operation: Schema.Literals([
    'create',
    'change-role',
    'change-status',
    'create-agent',
    'configure-agent',
    'archive-agent',
  ]),
  principalId: uuid,
  status: Schema.Literals(['active', 'disabled', 'archived']),
});
export type ManageDemoAccountResult = typeof ManageDemoAccountResultSchema.Type;

const nullableText = Schema.NullOr(Schema.String);
/** Stored in `core.audit_events.evidence_json`; the admin UI renders the audit trail from it. */
export const ManageDemoAccountAuditEvidenceSchema = Schema.Struct({
  description: nullableText,
  displayName: nullableText,
  email: nullableText,
  modulesJson: nullableText,
  newRoleKey: nullableText,
  newRoleLabel: nullableText,
  newStatus: nullableText,
  operation: Schema.String,
  ownerPrincipalId: nullableText,
  previousModulesJson: nullableText,
  previousRoleKey: nullableText,
  previousRoleLabel: nullableText,
  previousStatus: nullableText,
  previousWritePolicy: nullableText,
  principalKind: nullableText,
  reason: nullableText,
  targetPrincipalId: Schema.String,
  writePolicy: nullableText,
});
type AuditEvidence = typeof ManageDemoAccountAuditEvidenceSchema.Type;

const invalid = (reason: string) => new IdentityTargetInvalidError({ code: 'identity_target_invalid', reason });
const conflict = (reason: string) =>
  new IdentityLifecycleConflictError({ code: 'identity_lifecycle_conflict', reason });
const persistenceFailure = (cause: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'The demo account could not be persisted',
    }),
    'cause',
    { configurable: true, value: cause },
  );

type Transaction = Pick<ScopedTransactionExecutor, 'insert' | 'select' | 'update'>;

const loadManagedPrincipal = (transaction: Transaction, tenantId: string, principalId: string) =>
  transaction
    .select({ displayName: principals.displayName, kind: principals.kind, status: principals.status })
    .from(principals)
    .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, principalId)))
    .limit(1)
    .pipe(
      Effect.mapError(persistenceFailure),
      Effect.flatMap(([row]) =>
        row === undefined || (row.kind !== 'human' && row.kind !== 'agent')
          ? Effect.fail(invalid('The target is not a person or agent entity of this tenant'))
          : Effect.succeed(row),
      ),
    );

const emptyEvidence = (principalId: string, operation: string): AuditEvidence => ({
  description: null,
  displayName: null,
  email: null,
  modulesJson: null,
  newRoleKey: null,
  newRoleLabel: null,
  newStatus: null,
  operation,
  ownerPrincipalId: null,
  previousModulesJson: null,
  previousRoleKey: null,
  previousRoleLabel: null,
  previousStatus: null,
  previousWritePolicy: null,
  principalKind: null,
  reason: null,
  targetPrincipalId: principalId,
  writePolicy: null,
});

interface Services {
  readonly transaction: Transaction;
}

const handleManageDemoAccount = Effect.fn('ManageDemoAccount.handle')(function* handle(
  payload: ManageDemoAccountPayload,
  context: ActionHandlerContext<Readonly<Record<never, never>>, Services>,
) {
  const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
    Effect.orElseSucceed(() => 'unknown'),
  );
  if (environment !== 'development') {
    return yield* invalid('Demo account administration is available only in development');
  }
  const { transaction } = context.services;
  const { tenantId } = context.scope;
  const now = yield* DateTime.nowAsDate;
  if (payload.operation === 'create') {
    const existing = yield* transaction
      .select({ principalId: principals.principalId })
      .from(principals)
      .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, payload.principalId)))
      .limit(1)
      .pipe(Effect.mapError(persistenceFailure));
    if (existing.length > 0) {
      return yield* conflict('The account already exists');
    }
    yield* transaction
      .insert(principals)
      .values({
        displayName: payload.displayName,
        kind: 'human',
        principalId: payload.principalId,
        status: 'active',
        tenantId,
      })
      .pipe(Effect.mapError(persistenceFailure));
    yield* transaction
      .insert(principalAuthBindings)
      .values({
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        createdByInvocationId: context.actionInvocationId,
        principalAuthBindingId: payload.authBindingId,
        principalId: payload.principalId,
        provider: 'better_auth',
        providerSubjectId: payload.authUserId,
        status: 'active',
        subjectType: 'user',
        tenantId,
      })
      .pipe(Effect.mapError(persistenceFailure));
    yield* context.recordAuditEvidence({
      ...emptyEvidence(payload.principalId, 'create'),
      displayName: payload.displayName,
      email: payload.email,
      newRoleKey: payload.roleKey,
      newRoleLabel: payload.roleLabel,
      newStatus: 'active',
    });
    return { operation: 'create' as const, principalId: payload.principalId, status: 'active' as const };
  }
  if (payload.operation === 'create-agent') {
    const existing = yield* transaction
      .select({ principalId: principals.principalId })
      .from(principals)
      .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, payload.principalId)))
      .limit(1)
      .pipe(Effect.mapError(persistenceFailure));
    if (existing.length > 0) {
      return yield* conflict('The agent entity already exists');
    }
    yield* transaction
      .insert(principals)
      .values({
        displayName: payload.displayName,
        kind: 'agent',
        principalId: payload.principalId,
        status: 'active',
        tenantId,
      })
      .pipe(Effect.mapError(persistenceFailure));
    yield* context.recordAuditEvidence({
      ...emptyEvidence(payload.principalId, 'create-agent'),
      description: payload.description,
      displayName: payload.displayName,
      modulesJson: payload.modulesJson,
      newStatus: 'active',
      ownerPrincipalId: payload.ownerPrincipalId,
      principalKind: 'agent',
      writePolicy: payload.writePolicy,
    });
    return { operation: 'create-agent' as const, principalId: payload.principalId, status: 'active' as const };
  }
  const target = yield* loadManagedPrincipal(transaction, tenantId, payload.principalId);
  if (payload.principalId === context.scope.principalId) {
    return yield* invalid('An administrator cannot change their own account');
  }
  if (payload.operation === 'archive-agent') {
    if (target.kind !== 'agent') {
      return yield* invalid('The target is not an agent entity');
    }
    if (target.status !== payload.expectedStatus) {
      return yield* conflict('The agent status changed concurrently');
    }
    yield* transaction
      .update(principals)
      .set({ disabledAt: now, status: 'archived' })
      .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, payload.principalId)))
      .pipe(Effect.mapError(persistenceFailure));
    yield* context.recordAuditEvidence({
      ...emptyEvidence(payload.principalId, 'archive-agent'),
      displayName: target.displayName,
      newStatus: 'archived',
      previousStatus: target.status,
      principalKind: 'agent',
      reason: payload.reason,
    });
    return { operation: 'archive-agent' as const, principalId: payload.principalId, status: 'archived' as const };
  }
  if (payload.operation === 'configure-agent') {
    if (target.kind !== 'agent') {
      return yield* invalid('The target is not an agent entity');
    }
    if (target.displayName !== payload.displayName) {
      yield* transaction
        .update(principals)
        .set({ displayName: payload.displayName })
        .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, payload.principalId)))
        .pipe(Effect.mapError(persistenceFailure));
    }
    yield* context.recordAuditEvidence({
      ...emptyEvidence(payload.principalId, 'configure-agent'),
      description: payload.description,
      displayName: payload.displayName,
      modulesJson: payload.modulesJson,
      ownerPrincipalId: payload.ownerPrincipalId,
      previousModulesJson: payload.previousModulesJson,
      previousWritePolicy: payload.previousWritePolicy,
      principalKind: 'agent',
      writePolicy: payload.writePolicy,
    });
    return {
      operation: 'configure-agent' as const,
      principalId: payload.principalId,
      status: target.status === 'active' ? ('active' as const) : ('disabled' as const),
    };
  }
  if (payload.operation === 'change-role') {
    if (target.kind !== 'human') {
      return yield* invalid('Only people have demo roles');
    }
    yield* context.recordAuditEvidence({
      ...emptyEvidence(payload.principalId, 'change-role'),
      displayName: target.displayName,
      newRoleKey: payload.roleKey,
      newRoleLabel: payload.roleLabel,
      previousRoleKey: payload.previousRoleKey,
      previousRoleLabel: payload.previousRoleLabel,
    });
    return {
      operation: 'change-role' as const,
      principalId: payload.principalId,
      status: target.status === 'active' ? ('active' as const) : ('disabled' as const),
    };
  }
  if (target.status !== payload.expectedStatus) {
    return yield* conflict('The account status changed concurrently');
  }
  if (payload.newStatus === 'disabled' && payload.reason === undefined) {
    return yield* invalid('A reason is required to deactivate an account');
  }
  if (payload.newStatus !== payload.expectedStatus) {
    yield* transaction
      .update(principals)
      .set({ disabledAt: payload.newStatus === 'disabled' ? now : null, status: payload.newStatus })
      .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, payload.principalId)))
      .pipe(Effect.mapError(persistenceFailure));
  }
  yield* context.recordAuditEvidence({
    ...emptyEvidence(payload.principalId, 'change-status'),
    displayName: target.displayName,
    newStatus: payload.newStatus,
    previousStatus: payload.expectedStatus,
    principalKind: target.kind,
    reason: payload.reason ?? null,
  });
  return { operation: 'change-status' as const, principalId: payload.principalId, status: payload.newStatus };
});

export const manageDemoAccountAction = defineAction(
  {
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.manage-demo-account.access.v1',
    },
    actionKey: 'core.identity.manage-demo-account',
    auditEvidenceSchema: ManageDemoAccountAuditEvidenceSchema,
    auditProfile: 'sensitive',
    domainErrorSchema: PrincipalManagementErrorSchema,
    domainEvents: {},
    entrypoint: defineSystemModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'explicit' },
      entrypointKey: 'core.identity.manage-demo-account',
      moduleKey: 'core.identity',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    payloadSchema: ManageDemoAccountPayloadSchema,
    policies: [],
    resultSchema: ManageDemoAccountResultSchema,
    schemaVersion: '1',
    tenantPermission: () => 'manage_identity',
  },
  handleManageDemoAccount,
  (transaction) => Effect.succeed({ transaction }),
);
