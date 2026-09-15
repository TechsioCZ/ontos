import type {
  ActionCollectorError,
  ActionHandlerContext,
  DomainEventContractMap,
  OperationalScope,
} from '@app/core-runtime';
/* eslint-disable effect-native/no-unbranded-identifier-schema -- Audit evidence retains the owner-issued opaque record identity from a validated Privacy result. expires: 2027-03-31. */
import { Effect, Schema } from 'effect';

import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';
import type { PrivacyOperationRepositoryService } from '../persistence/privacy-operation-repository.ts';
import { PrivacyActionRejected } from './privacy-action-rejected.ts';
import { PrivacyActionScopeRequired } from './privacy-action-scope-required.ts';

export { PrivacyActionRejected } from './privacy-action-rejected.ts';
export { PrivacyActionScopeRequired } from './privacy-action-scope-required.ts';

export const PrivacyActionErrorSchema = Schema.Union([
  PrivacyActionRejected,
  PrivacyActionScopeRequired,
  PrivacyOperationPersistenceError,
]);

export const PrivacyActionAuditEvidenceSchema = Schema.Struct({
  operationKind: Schema.String,
  recordId: Schema.String,
});

export const privacyActionDomainEvents = {} as const;

export interface TrustedPrivacyActionScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

export const requirePrivacyActionScope = (
  scope: OperationalScope,
): Effect.Effect<TrustedPrivacyActionScope, PrivacyActionScopeRequired> =>
  scope.legalEntityId === undefined
    ? Effect.fail(
        new PrivacyActionScopeRequired({
          code: 'privacy_action_scope_required',
          reason: 'The Privacy operation requires a trusted Legal Entity scope',
        }),
      )
    : Effect.succeed({ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });

export const completePrivacyAction = <DomainEvents extends DomainEventContractMap, Result>(
  context: ActionHandlerContext<DomainEvents, PrivacyOperationRepositoryService>,
  operationKind: string,
  recordId: string,
  result: Result,
): Effect.Effect<Result, ActionCollectorError> =>
  context.recordAuditEvidence({ operationKind, recordId }).pipe(Effect.as(result));
