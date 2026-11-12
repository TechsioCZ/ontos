import { recoverSqlTransactionError } from '@app/core-runtime';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { eq, sql } from 'drizzle-orm';
import { Clock, Effect, Layer, Option } from 'effect';

import { AuthDatabase } from './db/client.ts';
import { user } from './db/schema.ts';
import { userBanHoldsAt } from './gateway-delegation-authentication.service.ts';
import { delegationUnavailable as unavailableBecause } from './gateway-delegation-errors.ts';
import {
  GatewayOriginatorEvidence,
  admitInvocationEvidence,
  decodeOriginatorEvidenceRows,
} from './gateway-originator-evidence.ts';
import type { GatewayOriginatorEvidenceService, OriginatorEvidenceRow } from './gateway-originator-evidence.ts';

const delegationUnavailable = unavailableBecause('originator_evidence_unavailable');

type CoreExecutor = (typeof CoreDatabase)['Service']['executor'];
type AuthExecutor = (typeof AuthDatabase)['Service']['executor'];

/** Core's recorded requester of one invocation, with the authentication columns stored on it. */
const selectInvocationRows = (executor: CoreExecutor, tenantId: string, actionInvocationId: string) =>
  executor
    .execute(
      sql`
        select
          i.status as "status",
          i.action_key as "actionKey",
          i.principal_id as "principalId",
          i.auth_method as "authMethod",
          i.auth_binding_id as "authBindingId",
          i.auth_context_ref as "authContextRef",
          i.impersonated_by_principal_id as "impersonatedByPrincipalId",
          i.legal_entity_id as "legalEntityId",
          extract(epoch from i.started_at)::float8 as "startedAtEpochSeconds",
          p.kind as "principalKind",
          p.status as "principalStatus",
          b.principal_id as "bindingPrincipalId",
          b.subject_type as "bindingSubjectType",
          b.provider_subject_id as "bindingProviderSubjectId",
          b.status as "bindingStatus",
          (b.revoked_at is not null) as "bindingRevoked",
          b.authentication_namespace_id as "bindingAuthenticationNamespaceId"
        from core.action_invocations as i
        left join core.principals as p
          on p.tenant_id = i.tenant_id and p.principal_id = i.principal_id
        left join core.principal_auth_bindings as b
          on b.tenant_id = i.tenant_id and b.principal_auth_binding_id = i.auth_binding_id
        where i.tenant_id = ${tenantId} and i.action_invocation_id = ${actionInvocationId}
        limit 1
      `,
      'objects',
    )
    .pipe(
      recoverSqlTransactionError,
      Effect.mapError(delegationUnavailable),
      Effect.flatMap((rows) => decodeOriginatorEvidenceRows(rows).pipe(Effect.mapError(delegationUnavailable))),
    );

/**
 * Whether the Better Auth user a user-bound requester names is banned now, read from the same user store the
 * Assertion path reads. Only a user binding carries a user to check, and a user that no longer exists counts as banned.
 */
const subjectUserBanned = (auth: AuthExecutor, row: OriginatorEvidenceRow | undefined, nowSeconds: number) => {
  if (row === undefined || Option.getOrUndefined(row.bindingSubjectType) !== 'user') {
    return Effect.succeed(false);
  }
  const userId = Option.getOrUndefined(row.bindingProviderSubjectId);
  if (userId === undefined) {
    return Effect.succeed(true);
  }
  return auth
    .select({ banExpires: user.banExpires, banned: user.banned })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
    .pipe(
      recoverSqlTransactionError,
      Effect.mapError(delegationUnavailable),
      Effect.map(([ban]) => ban === undefined || userBanHoldsAt(ban, nowSeconds)),
    );
};

const makeGatewayOriginatorEvidence = (core: CoreExecutor, auth: AuthExecutor): GatewayOriginatorEvidenceService => ({
  load: Effect.fn('GatewayOriginatorEvidence.load')(function* loadOriginatorEvidence(input: {
    readonly actionInvocationId: string;
    readonly originatorActions: readonly string[];
    readonly tenantId: string;
  }) {
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const rows = yield* selectInvocationRows(core, input.tenantId, input.actionInvocationId);
    const banned = yield* subjectUserBanned(auth, rows[0], nowSeconds);
    return yield* admitInvocationEvidence(rows, {
      nowSeconds,
      originatorActions: input.originatorActions,
      subjectUserBanned: banned,
      tenantId: input.tenantId,
    });
  }),
});

export const GatewayOriginatorEvidenceLive = Layer.effect(
  GatewayOriginatorEvidence,
  Effect.gen(function* prepareOriginatorEvidence() {
    const database = yield* CoreDatabase;
    const authDatabase = yield* AuthDatabase;
    return makeGatewayOriginatorEvidence(database.executor, authDatabase.executor);
  }),
);
