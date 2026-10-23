import { v1 } from '@authzed/authzed-node';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import type { Reactivity } from 'effect/unstable/reactivity';

import { CoreDatabase } from '../db/client.ts';
import { DatabaseConfig } from '../db/config.ts';
import { actionInvocations, auditEvents, domainEvents, legalEntities, principals, tenants } from '../db/schema.ts';
import { withPostgresSessionAdvisoryLock } from '../db/session-advisory-lock.ts';
import type { CoreTransaction } from '../db/types.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import {
  OutboxPayloadSchema,
  ScopedRoleMembershipAuditEvidenceSchema,
  outboxProducerModuleKey,
  outboxTopic,
  scopedRoleIdentity,
  scopedRoleMembershipSubjectId,
} from '../outbox/core-identity-scoped-role-membership-changed-v1.ts';
import { ActionAuthorizationLifecycleError } from './action-authorization-lifecycle-error.ts';
import { SpiceDbConfig } from './config.ts';
import { buildScopedRoleMembershipUpdates, toScopedRoleObjectId } from './scoped-role.ts';
import type { ScopedRoleIdentity } from './scoped-role.ts';
import { openSpiceDbRpc } from './spicedb-transaction-guard.ts';

const actionKey = 'core.identity.set-scoped-role-membership';
const AuditSchema = Schema.Struct({
  ...ScopedRoleMembershipAuditEvidenceSchema.fields,
  actionKey: Schema.Literal(actionKey),
});
const failed = (cause?: unknown) =>
  new ActionAuthorizationLifecycleError({
    cause,
    reason: 'Scoped role membership could not be reconciled from exact committed evidence',
  });

const isExactEvidence = (input: {
  readonly auditCompanyId: string | null;
  readonly eventCompanyId: string | null;
  readonly evidence: typeof AuditSchema.Type;
  readonly invocationCompanyId: string | null;
  readonly payload: typeof OutboxPayloadSchema.Type;
  readonly principalId: string;
  readonly role: ScopedRoleIdentity;
}): boolean => {
  const { evidence, payload, principalId, role } = input;
  const roleId = toScopedRoleObjectId(role);
  return (
    evidence.principalRef.tenantId === role.tenantId &&
    evidence.principalRef.principalId === principalId &&
    payload.data.principalId === principalId &&
    toScopedRoleObjectId(scopedRoleIdentity(evidence.role)) === roleId &&
    toScopedRoleObjectId(scopedRoleIdentity({ ...payload.data, tenantId: role.tenantId })) === roleId &&
    input.auditCompanyId === (role.legalEntityId ?? null) &&
    input.eventCompanyId === (role.legalEntityId ?? null) &&
    input.invocationCompanyId === (role.legalEntityId ?? null)
  );
};

const readLatestCommand = Effect.fn('ScopedRoleMembershipLifecycle.readLatestCommand')(function* readLatestCommand(
  transaction: CoreTransaction,
  role: ScopedRoleIdentity,
  principalId: string,
  compositionRevision: string,
) {
  yield* lockApplicationCompositionAuthority(transaction, compositionRevision, 'worker');
  yield* transaction.execute(
    sql`select set_config('ontos.tenant_id', ${role.tenantId}, true), set_config('ontos.legal_entity_id', ${role.legalEntityId ?? ''}, true)`,
    'objects',
  );
  const rows = yield* transaction
    .select({
      auditCompanyId: auditEvents.legalEntityId,
      eventCompanyId: domainEvents.legalEntityId,
      evidence: auditEvents.evidenceJson,
      invocationActionKey: actionInvocations.actionKey,
      invocationCompanyId: actionInvocations.legalEntityId,
      payload: domainEvents.payloadJson,
      sequence: domainEvents.tenantSequenceNo,
    })
    .from(domainEvents)
    .leftJoin(
      auditEvents,
      and(
        eq(auditEvents.tenantId, domainEvents.tenantId),
        eq(auditEvents.actionInvocationId, domainEvents.actionInvocationId),
        eq(auditEvents.eventType, 'action.executed'),
        eq(auditEvents.outcome, 'succeeded'),
        eq(auditEvents.auditProfile, 'sensitive'),
        eq(auditEvents.outcomeStage, 'execution'),
      ),
    )
    .leftJoin(
      actionInvocations,
      and(
        eq(actionInvocations.tenantId, domainEvents.tenantId),
        eq(actionInvocations.actionInvocationId, domainEvents.actionInvocationId),
        eq(actionInvocations.actionKey, actionKey),
        eq(actionInvocations.status, 'succeeded'),
      ),
    )
    .where(
      and(
        eq(domainEvents.tenantId, role.tenantId),
        eq(domainEvents.eventType, outboxTopic),
        eq(domainEvents.producerModuleKey, outboxProducerModuleKey),
        eq(domainEvents.subjectModuleKey, outboxProducerModuleKey),
        eq(domainEvents.subjectResourceType, 'scoped_role_membership'),
        eq(domainEvents.subjectResourceId, scopedRoleMembershipSubjectId(role, principalId)),
      ),
    )
    .orderBy(desc(domainEvents.tenantSequenceNo))
    .limit(2);
  const [latest, previous] = rows;
  if (latest === undefined || latest.invocationActionKey !== actionKey || previous?.sequence === latest.sequence) {
    return yield* failed();
  }
  const evidence = yield* Schema.decodeUnknownEffect(AuditSchema)(latest.evidence);
  const payload = yield* Schema.decodeUnknownEffect(OutboxPayloadSchema, { onExcessProperty: 'error' })(latest.payload);
  if (!isExactEvidence({ ...latest, evidence, payload, principalId, role })) {
    return yield* failed();
  }
  const [target] = yield* transaction
    .select({
      kind: principals.kind,
      status: principals.status,
      tenantStatus: tenants.status,
    })
    .from(principals)
    .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
    .where(and(eq(principals.tenantId, role.tenantId), eq(principals.principalId, principalId)));
  if (target === undefined) {
    return yield* failed();
  }
  let companyActive = true;
  if (role.legalEntityId !== undefined) {
    const [company] = yield* transaction
      .select({ status: legalEntities.status })
      .from(legalEntities)
      .where(and(eq(legalEntities.tenantId, role.tenantId), eq(legalEntities.legalEntityId, role.legalEntityId)));
    if (company === undefined) {
      return yield* failed();
    }
    companyActive = company.status === 'active';
  }
  return {
    operation:
      evidence.operation === 'assign' &&
      (target.kind === 'human' || target.kind === 'agent') &&
      target.status === 'active' &&
      target.tenantStatus === 'active' &&
      companyActive
        ? ('assign' as const)
        : ('revoke' as const),
    principal: evidence.principalRef,
    role,
  };
});

export class ScopedRoleMembershipLifecycle extends Context.Service<
  ScopedRoleMembershipLifecycle,
  {
    readonly reconcile: (
      role: ScopedRoleIdentity,
      principalId: string,
      compositionRevision: string,
    ) => Effect.Effect<void, ActionAuthorizationLifecycleError, Reactivity.Reactivity>;
    readonly reconcilePrincipal: (
      tenantId: string,
      principalId: string,
      compositionRevision: string,
    ) => Effect.Effect<void, ActionAuthorizationLifecycleError, Reactivity.Reactivity>;
  }
>()('@app/core-runtime/permissions/ScopedRoleMembershipLifecycle') {}

/** The only persisted command is ordinary audit/event evidence. SpiceDB remains live authority. */
export const ScopedRoleMembershipLifecycleLive = Layer.effect(
  ScopedRoleMembershipLifecycle,
  Effect.gen(function* makeRoleLifecycle() {
    const database = yield* CoreDatabase;
    const configuration = yield* DatabaseConfig;
    const authority = yield* ActiveApplicationCompositionService;
    const spiceConfiguration = yield* SpiceDbConfig;
    const reconcile = Effect.fn('ScopedRoleMembershipLifecycle.reconcile')(function* reconcile(
      role: ScopedRoleIdentity,
      principalId: string,
      compositionRevision: string,
    ) {
      return yield* withPostgresSessionAdvisoryLock(
        Redacted.make(configuration.connectionString),
        `ontos.scoped-role-membership:${scopedRoleMembershipSubjectId(role, principalId)}`,
        Effect.gen(function* reconcileSerializedMembership() {
          const snapshot = yield* authority.load.pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
          if (snapshot.composition.revision !== compositionRevision) {
            return yield* failed();
          }
          const command = yield* database.executor.transaction((transaction) =>
            readLatestCommand(transaction, role, principalId, compositionRevision),
          );
          const updates = yield* buildScopedRoleMembershipUpdates(command);
          // The SQL transaction is finished before any graph I/O. Delayed wakeups apply
          // the newest ordered committed command, never their original operation.
          const client = yield* Effect.acquireRelease(
            Effect.try({ catch: failed, try: () => openSpiceDbRpc(spiceConfiguration, 5000) }),
            (rpc) => Effect.sync(rpc.close),
          );
          return yield* client.writeRelationships(v1.WriteRelationshipsRequest.create({ updates })).pipe(Effect.asVoid);
        }),
      ).pipe(Effect.mapError(failed));
    });
    return {
      reconcile,
      reconcilePrincipal: Effect.fn('ScopedRoleMembershipLifecycle.reconcilePrincipal')(function* reconcilePrincipal(
        tenantId: string,
        principalId: string,
        compositionRevision: string,
      ) {
        // Enumerate only identities from ordinary events. Each identity independently
        // reloads and validates its latest joined audit/Action evidence under its lock.
        const identities = yield* database.executor
          .selectDistinct({ payload: domainEvents.payloadJson })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.tenantId, tenantId),
              eq(domainEvents.eventType, outboxTopic),
              eq(domainEvents.producerModuleKey, outboxProducerModuleKey),
              eq(domainEvents.subjectResourceType, 'scoped_role_membership'),
              sql`${domainEvents.payloadJson} -> 'data' ->> 'principalId' = ${principalId}`,
            ),
          )
          .pipe(Effect.mapError(failed));
        yield* Effect.forEach(
          identities,
          Effect.fn(function* reconcileIdentity(identity) {
            const payload = yield* Schema.decodeUnknownEffect(OutboxPayloadSchema, { onExcessProperty: 'error' })(
              identity.payload,
            ).pipe(Effect.mapError(failed));
            return yield* reconcile(
              scopedRoleIdentity({ ...payload.data, tenantId }),
              principalId,
              compositionRevision,
            );
          }),
          { concurrency: 1, discard: true },
        );
      }),
    };
  }),
);
