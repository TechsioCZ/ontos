import { Context, Effect, Layer, Schema } from 'effect';

import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { recoverSqlTransactionError } from '../actions/repository.ts';
import { transportIdentifier } from '../actions/string-schemas.ts';
import { CoreDatabase } from '../db/client.ts';
import { auditEvents } from '../db/schema.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import { OperationalScopeResolver } from '../operations/context.ts';
import type { OperationalScope, OperationalScopeRequest } from '../operations/context.ts';
import { ContextAccess } from '../permissions/context-access.ts';
import { IdentityAdministrationDeniedAuditUnavailable } from './identity-administration-audit-unavailable.ts';

const PrincipalId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId'));
const requestText = transportIdentifier;
/** These are the people Action operations and the exact `${request.operation}-agent` Shell denial callers. */
export const IdentityAdministrationDeniedAttemptSchema = Schema.Struct({
  operation: Schema.Literals([
    'create',
    'change-role',
    'change-status',
    'create-agent',
    'configure-agent',
    'change-status-agent',
    'delete-agent',
  ]),
  principalKind: Schema.Union([Schema.Literal('agent'), Schema.Null]),
  targetPrincipalId: Schema.Union([PrincipalId, Schema.Null]),
}).check(
  Schema.makeFilter((attempt) =>
    attempt.operation.endsWith('-agent') === (attempt.principalKind === 'agent')
      ? undefined
      : 'The operation must retain its actual subject kind',
  ),
);
export const IdentityAdministrationDeniedAuditEvidenceSchema = Schema.Struct({
  actionKey: Schema.Literal('core.identity.manage-demo-account'),
  correlationId: transportIdentifier,
  operation: IdentityAdministrationDeniedAttemptSchema.fields.operation,
  principalKind: IdentityAdministrationDeniedAttemptSchema.fields.principalKind,
  reason: Schema.Literal('company_administrator_required'),
  targetPrincipalId: Schema.optionalKey(PrincipalId),
  traceId: Schema.optionalKey(transportIdentifier),
});

const transportSchema = Schema.Struct({
  audience: Schema.optionalKey(requestText),
  correlationId: requestText,
  idempotencyKey: Schema.optionalKey(requestText),
  traceId: Schema.optionalKey(requestText),
});

export interface IdentityAdministrationDeniedAuditInput {
  readonly operation: string;
  readonly principal: TrustedPrincipalContext;
  readonly principalKind: 'agent' | null;
  readonly targetPrincipalId: string | null;
  readonly transport: OperationalScopeRequest & { readonly idempotencyKey?: string };
}

/** Fixed server evidence, never a caller-selected event, outcome, timestamp, JSON envelope or Action result. */
export const identityAdministrationDeniedAuditRow = (
  scope: OperationalScope,
  attempt: typeof IdentityAdministrationDeniedAttemptSchema.Type,
) => {
  const evidenceJson: typeof IdentityAdministrationDeniedAuditEvidenceSchema.Type = {
    actionKey: 'core.identity.manage-demo-account',
    correlationId: scope.correlationId,
    operation: attempt.operation,
    principalKind: attempt.principalKind,
    reason: 'company_administrator_required',
  };
  if (attempt.targetPrincipalId !== null) {
    Object.assign(evidenceJson, { targetPrincipalId: attempt.targetPrincipalId });
  }
  if (scope.traceId !== undefined) {
    Object.assign(evidenceJson, { traceId: scope.traceId });
  }
  return {
    auditProfile: 'sensitive' as const,
    authBindingId: scope.authBindingId,
    authContextRef: scope.authContextRef,
    authMethod: scope.authMethod,
    eventType: 'action.rejected',
    evidenceJson,
    impersonatedByPrincipalId: scope.impersonatedByPrincipalId,
    legalEntityId: scope.legalEntityId,
    outcome: 'denied' as const,
    outcomeCode: 'company_administrator_required',
    outcomeStage: 'authz' as const,
    principalId: scope.principalId,
    targetModuleKey: 'core.identity',
    tenantId: scope.tenantId,
  };
};

export class IdentityAdministrationDeniedAudit extends Context.Service<
  IdentityAdministrationDeniedAudit,
  {
    readonly record: (
      input: IdentityAdministrationDeniedAuditInput,
    ) => Effect.Effect<void, IdentityAdministrationDeniedAuditUnavailable>;
  }
>()('@app/core-runtime/auth/identity-administration-audit-denied/IdentityAdministrationDeniedAudit') {}

/**
 * Native pre-Action observer. Re-admit the ORIGINAL carrier and prove a definite admin denial outside SQL;
 * persist only its fixed observation in a short Core-owned transaction. This never requires Action authority.
 */
export const IdentityAdministrationDeniedAuditLive = Layer.effect(
  IdentityAdministrationDeniedAudit,
  Effect.gen(function* makeIdentityAdministrationDeniedAudit() {
    const { executor } = yield* CoreDatabase;
    const resolver = yield* OperationalScopeResolver;
    const access = yield* ContextAccess;
    return {
      record: Effect.fn('IdentityAdministrationDeniedAudit.record')(
        function* record(input: IdentityAdministrationDeniedAuditInput) {
          const [attempt, transport] = yield* Effect.all(
            [
              Schema.decodeUnknownEffect(IdentityAdministrationDeniedAttemptSchema, { onExcessProperty: 'error' })({
                operation: input.operation,
                principalKind: input.principalKind,
                targetPrincipalId: input.targetPrincipalId,
              }),
              Schema.decodeEffect(transportSchema, { onExcessProperty: 'error' })(input.transport),
              // Validate, but never reconstruct/replace the carrier: provenance is retained by object identity.
              Schema.decodeEffect(TrustedPrincipalContextSchema)(input.principal),
            ],
            { concurrency: 1 },
          );
          const scope = yield* resolver.resolve({
            ...transport,
            legalEntityScope: 'required',
            principal: input.principal,
          });
          const { legalEntityId, principalId, tenantId } = scope;
          if (
            legalEntityId === undefined ||
            legalEntityId !== input.principal.legalEntityId ||
            tenantId !== input.principal.tenantId ||
            principalId !== input.principal.principalId ||
            scope.authBindingId !== input.principal.authBindingId ||
            scope.authMethod !== input.principal.authMethod
          ) {
            return yield* new IdentityAdministrationDeniedAuditUnavailable({
              cause: 'The admitted original scope did not match',
              reason: 'An original admitted company scope is required',
            });
          }
          const [tenant, company] = yield* Effect.all(
            [
              access.tenants({ permission: 'manage_identity', principalId, tenantIds: [tenantId] }),
              access.legalEntities({
                legalEntityIds: [legalEntityId],
                permission: 'manage_people',
                principalId,
                tenantId,
              }),
            ],
            { concurrency: 2 },
          );
          if (
            tenant.length !== 1 ||
            company.length !== 1 ||
            tenant[0]?.key !== tenantId ||
            company[0]?.key !== legalEntityId ||
            tenant[0]?.decision !== 'denied' ||
            company[0]?.decision !== 'denied'
          ) {
            return yield* new IdentityAdministrationDeniedAuditUnavailable({
              cause: 'A definite current administration denial was not established',
              reason: 'The denied administration observation could not be verified',
            });
          }
          const row = identityAdministrationDeniedAuditRow(scope, attempt);
          return yield* executor
            .transaction((transaction) =>
              installOperationalScope(transaction, scope).pipe(
                Effect.flatMap((scoped) => scoped.insert(auditEvents).values(row)),
              ),
            )
            .pipe(recoverSqlTransactionError, Effect.asVoid);
        },
        Effect.mapError(
          (cause) =>
            new IdentityAdministrationDeniedAuditUnavailable({
              cause,
              reason: 'Unable to persist the denied identity administration observation',
            }),
        ),
      ),
    };
  }),
);
