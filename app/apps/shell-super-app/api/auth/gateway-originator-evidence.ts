import { WORKLOAD_PRINCIPAL_KINDS } from '@app/core-runtime/access/enforcement';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { Context, Duration, Effect, Option, Schema } from 'effect';

import { delegationForbidden } from './gateway-delegation-errors.ts';
import type { GatewayDelegationError } from './gateway-delegation-errors.ts';

/** Asynchronous work may act for a requester whose invocation is at most this old; no live session is required. */
export const ORIGINATOR_EVIDENCE_MAX_AGE_DAYS = 7;
const ORIGINATOR_EVIDENCE_MAX_AGE_SECONDS = Duration.toSeconds(Duration.days(ORIGINATOR_EVIDENCE_MAX_AGE_DAYS));
const TERMINAL_SUCCESS_STATUS = 'succeeded';

const ActionKeyRow = Schema.String.pipe(Schema.brand('ActionKey'));
const AuthBindingIdRow = Schema.String.pipe(Schema.brand('AuthBindingId'));
const ImpersonatorPrincipalIdRow = Schema.String.pipe(Schema.brand('ImpersonatedByPrincipalId'));
const LegalEntityIdRow = Schema.String.pipe(Schema.brand('LegalEntityId'));
const PrincipalIdRow = Schema.String.pipe(Schema.brand('PrincipalId'));

/** Nullable Core columns decode to Options; an absent value is never a stand-in for an authentication fact. */
export const OriginatorEvidenceRowSchema = Schema.Struct({
  actionKey: ActionKeyRow,
  authBindingId: Schema.OptionFromNullOr(AuthBindingIdRow),
  authContextRef: Schema.OptionFromNullOr(Schema.String),
  authMethod: Schema.OptionFromNullOr(Schema.String),
  bindingAuthenticationNamespaceId: Schema.OptionFromNullOr(Schema.String),
  bindingPrincipalId: Schema.OptionFromNullOr(PrincipalIdRow),
  bindingProviderSubjectId: Schema.OptionFromNullOr(Schema.String),
  bindingRevoked: Schema.OptionFromNullOr(Schema.Boolean),
  bindingStatus: Schema.OptionFromNullOr(Schema.String),
  bindingSubjectType: Schema.OptionFromNullOr(Schema.String),
  impersonatedByPrincipalId: Schema.OptionFromNullOr(ImpersonatorPrincipalIdRow),
  legalEntityId: Schema.OptionFromNullOr(LegalEntityIdRow),
  principalId: Schema.OptionFromNullOr(PrincipalIdRow),
  principalKind: Schema.OptionFromNullOr(Schema.String),
  principalStatus: Schema.OptionFromNullOr(Schema.String),
  startedAtEpochSeconds: Schema.OptionFromNullOr(Schema.Finite),
  status: Schema.String,
});
export type OriginatorEvidenceRow = typeof OriginatorEvidenceRowSchema.Type;

/** Decodes the rows Core returned for one invocation; a row of any other shape is unreadable, never admitted. */
export const decodeOriginatorEvidenceRows = Schema.decodeUnknownEffect(Schema.Array(OriginatorEvidenceRowSchema));

/** The Better Auth subject type a stored authentication method binds; system and unknown methods bind none. */
const subjectBindingTypeOf = (authMethod: string | undefined): 'api_key' | 'user' | undefined => {
  if (authMethod === 'api_key') {
    return 'api_key';
  }
  if (authMethod === 'session') {
    return 'user';
  }
  return undefined;
};

/**
 * The requester of asynchronous work as the Shell admits it: the principal recorded then, and whether it is a
 * workload — a service, integration or system principal — rather than a person or an agent.
 */
export interface AdmittedOriginator {
  readonly principal: TrustedPrincipalContext;
  readonly workload: boolean;
}

const isWorkloadKind = (kind: Option.Option<string>): boolean =>
  Option.exists(kind, (recorded) => WORKLOAD_PRINCIPAL_KINDS.some((workload) => workload === recorded));

/** Adds a field only when Core recorded it, so an absent field stays absent for the principal schema. */
const recordedField = <Key extends string, Value>(key: Key, value: Option.Option<Value>) =>
  Option.match(value, { onNone: () => ({}), onSome: (present) => ({ [key]: present }) });

/**
 * Admits the stored requester of a succeeded invocation: same tenant, a terminal success, a recent
 * record, an active principal and a binding that is still active and not revoked. The principal's
 * authentication is the one recorded then, never a live session that may have expired by now. A
 * support impersonation is never admitted: its recorded session has no lifetime to cap a replay by.
 */
const principalFromEvidence = (row: OriginatorEvidenceRow, tenantId: string, nowSeconds: number) => {
  if (row.status !== TERMINAL_SUCCESS_STATUS) {
    return Effect.fail(delegationForbidden());
  }
  const principalId = Option.getOrUndefined(row.principalId);
  const authMethod = Option.getOrUndefined(row.authMethod);
  const authBindingId = Option.getOrUndefined(row.authBindingId);
  const started = Option.getOrUndefined(row.startedAtEpochSeconds);
  const expectedSubjectType = subjectBindingTypeOf(authMethod);
  if (
    Option.isSome(row.impersonatedByPrincipalId) ||
    authMethod === 'support_impersonation' ||
    principalId === undefined ||
    Option.getOrUndefined(row.principalStatus) !== 'active' ||
    expectedSubjectType === undefined ||
    authBindingId === undefined ||
    Option.getOrUndefined(row.bindingPrincipalId) !== principalId ||
    Option.getOrUndefined(row.bindingSubjectType) !== expectedSubjectType ||
    Option.getOrUndefined(row.bindingStatus) !== 'active' ||
    Option.getOrUndefined(row.bindingRevoked) !== false
  ) {
    return Effect.fail(delegationForbidden());
  }
  if (
    started === undefined ||
    started > nowSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS ||
    nowSeconds - started > ORIGINATOR_EVIDENCE_MAX_AGE_SECONDS
  ) {
    return Effect.fail(delegationForbidden());
  }
  return Schema.decodeUnknownEffect(TrustedPrincipalContextSchema, { onExcessProperty: 'error' })({
    authMethod,
    principalId,
    tenantId,
    ...recordedField('authBindingId', row.authBindingId),
    ...recordedField('authContextRef', row.authContextRef),
    ...recordedField('authenticationNamespaceId', row.bindingAuthenticationNamespaceId),
    ...recordedField('impersonatedByPrincipalId', row.impersonatedByPrincipalId),
    ...recordedField('legalEntityId', row.legalEntityId),
  }).pipe(
    Effect.map((principal): AdmittedOriginator => ({ principal, workload: isWorkloadKind(row.principalKind) })),
    Effect.mapError((cause) => delegationForbidden(cause)),
  );
};

/**
 * Admits the requester recorded in the decoded rows Core returned for one invocation. Pure over those rows, so
 * every refusal rule is decided here and tested without a database. The invocation must be of an Action the
 * calling module declared it may act for, and the binding's user must not be banned now.
 */
export const admitInvocationEvidence = (
  rows: readonly OriginatorEvidenceRow[],
  input: {
    readonly nowSeconds: number;
    readonly originatorActions: readonly string[];
    readonly subjectUserBanned: boolean;
    readonly tenantId: string;
  },
) => {
  const [row] = rows;
  if (row === undefined || !input.originatorActions.includes(row.actionKey) || input.subjectUserBanned) {
    return Effect.fail(delegationForbidden());
  }
  return principalFromEvidence(row, input.tenantId, input.nowSeconds);
};

export interface GatewayOriginatorEvidenceService {
  /**
   * The subject principal recorded on a succeeded invocation of the tenant, admitted for delegated work of the
   * calling module, which may only act for the Actions in `originatorActions`.
   */
  readonly load: (input: {
    readonly actionInvocationId: string;
    readonly originatorActions: readonly string[];
    readonly tenantId: string;
  }) => Effect.Effect<AdmittedOriginator, GatewayDelegationError>;
}

export class GatewayOriginatorEvidence extends Context.Service<
  GatewayOriginatorEvidence,
  GatewayOriginatorEvidenceService
>()('@app/shell-super-app/api/auth/gateway-originator-evidence/GatewayOriginatorEvidence') {}
