import { defineScopedRoutine } from '@app/core-runtime';
import type {
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  CommerceEnrollmentAttemptConflict,
  CommerceEnrollmentAttemptIndeterminate,
  CommerceEnrollmentAttemptNotFound,
  CommerceEnrollmentAttemptRejected,
  CommerceEnrollmentAttemptUnavailable,
} from './errors.ts';
import type { CommerceEnrollmentAttemptError } from './errors.ts';
import type {
  ClaimEnrollmentTransitionInput,
  CommercePortalAccountSubject,
  EnrollmentAttemptLease,
  EnrollmentAttemptId,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
  ReadEnrollmentAttemptInput,
  ReadEnrollmentOwnerOperationInput,
  ReconcileEnrollmentOutcomeInput,
  RecordEnrollmentOutcomeInput,
  StartEnrollmentAttemptInput,
  TerminateEnrollmentAttemptInput,
} from '../../../shared/enrollment-contracts.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentAttemptStateSchema,
  EnrollmentAuthenticationNamespaceIdSchema,
  EnrollmentDigestSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentInvitationIdSchema,
  EnrollmentJourneySchema,
  EnrollmentKeySchema,
  EnrollmentLeaseTokenSchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentModuleKeySchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentAttemptSnapshotSchema,
  EnrollmentOwnerOperationStatusSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentProviderSubjectIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentOwnerOperationSnapshotSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../../shared/enrollment-contracts.ts';

const MODULE_KEY = 'commerce.customer-context';
const ATTEMPT_NOT_FOUND_REASON = 'The Enrollment Attempt was not found in the verified Tenant';

/* oxlint-disable effect-native/no-nullable-schema-field -- PostgreSQL routine object rows preserve SQL NULL at this private boundary; mapAttempt/mapOperation convert absence into omitted domain fields and reject incomplete rows. Expires: 2027-03-31. */
const databaseTimestamp = Schema.Union([Schema.Date, Schema.String]);
const nullableTimestamp = Schema.NullOr(databaseTimestamp);
const nullableString = Schema.NullOr(Schema.String);
const nullableActionInvocationId = Schema.NullOr(EnrollmentActionInvocationIdSchema);
const nullableDigest = Schema.NullOr(EnrollmentDigestSchema);
const nullableKey = Schema.NullOr(EnrollmentKeySchema);
const nullableModuleKey = Schema.NullOr(EnrollmentModuleKeySchema);
const nullableTransitionKey = Schema.NullOr(EnrollmentTransitionKeySchema);
const nullableOwnerOperationId = Schema.NullOr(EnrollmentOwnerOperationIdSchema);
const nullableResourceId = Schema.NullOr(EnrollmentResourceIdSchema);
const nullablePrincipalId = Schema.NullOr(EnrollmentPrincipalIdSchema);
const nullableLeaseToken = Schema.NullOr(EnrollmentLeaseTokenSchema);
const nullableProviderSubjectId = Schema.NullOr(EnrollmentProviderSubjectIdSchema);
const nullableAuthenticationNamespaceId = Schema.NullOr(EnrollmentAuthenticationNamespaceIdSchema);
const nullableInvitationId = Schema.NullOr(EnrollmentInvitationIdSchema);
const nullableLegalEntityId = Schema.NullOr(EnrollmentLegalEntityIdSchema);
const nullableOwnerStatus = Schema.NullOr(EnrollmentOwnerOperationStatusSchema);

const AttemptRoutineRowSchema = Schema.Struct({
  attempt_outcome: Schema.String,
  authentication_namespace_id: nullableAuthenticationNamespaceId,
  completed_at: nullableTimestamp,
  created_at: Schema.Union([Schema.Date, Schema.String]),
  created_by_principal_id: EnrollmentPrincipalIdSchema,
  failure_code: nullableKey,
  failure_reason: nullableString,
  intent_digest: EnrollmentDigestSchema,
  intent_key: EnrollmentKeySchema,
  invitation_id: nullableInvitationId,
  journey: EnrollmentJourneySchema,
  last_failure_code: nullableKey,
  last_failure_reason: nullableString,
  last_owner_invocation_id: nullableActionInvocationId,
  lease_expires_at: nullableTimestamp,
  lease_owner: nullableKey,
  lease_token: nullableLeaseToken,
  operation_actor_principal_id: nullablePrincipalId,
  operation_id: nullableOwnerOperationId,
  operation_lease_expires_at: nullableTimestamp,
  operation_lease_owner: nullableKey,
  operation_lease_token: nullableLeaseToken,
  operation_revision: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  operation_status: nullableOwnerStatus,
  outcome_code: nullableKey,
  owner_invocation_id: nullableActionInvocationId,
  owner_module_key: nullableModuleKey,
  portal_enrollment_attempt_id: EnrollmentAttemptIdSchema,
  provider_subject_id: nullableProviderSubjectId,
  reconciliation_ref: Schema.NullOr(EnrollmentEvidenceReferenceSchema),
  request_digest: nullableDigest,
  required: Schema.NullOr(Schema.Boolean),
  result_digest: nullableDigest,
  result_reference: nullableResourceId,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  state: EnrollmentAttemptStateSchema,
  subject_type: Schema.NullOr(Schema.Literal('user')),
  target_legal_entity_id: nullableLegalEntityId,
  target_resource_id: nullableResourceId,
  tenant_id: EnrollmentTenantIdSchema,
  terminated_at: nullableTimestamp,
  transition_key: nullableTransitionKey,
  updated_at: Schema.Union([Schema.Date, Schema.String]),
});
type AttemptRoutineRow = typeof AttemptRoutineRowSchema.Type;

const OwnerOperationRoutineRowSchema = Schema.Struct({
  actor_principal_id: EnrollmentPrincipalIdSchema,
  completed_at: nullableTimestamp,
  created_at: Schema.Union([Schema.Date, Schema.String]),
  failure_code: nullableKey,
  failure_reason: nullableString,
  lease_expires_at: nullableTimestamp,
  lease_owner: nullableKey,
  lease_token: nullableLeaseToken,
  operation_outcome: Schema.String,
  outcome_code: nullableKey,
  owner_invocation_id: EnrollmentActionInvocationIdSchema,
  owner_module_key: EnrollmentModuleKeySchema,
  portal_enrollment_attempt_id: EnrollmentAttemptIdSchema,
  portal_enrollment_owner_operation_id: EnrollmentOwnerOperationIdSchema,
  reconciliation_ref: Schema.NullOr(EnrollmentEvidenceReferenceSchema),
  request_digest: EnrollmentDigestSchema,
  required: Schema.Boolean,
  result_digest: nullableDigest,
  result_reference: nullableResourceId,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  status: EnrollmentOwnerOperationStatusSchema,
  tenant_id: EnrollmentTenantIdSchema,
  transition_key: EnrollmentTransitionKeySchema,
  updated_at: Schema.Union([Schema.Date, Schema.String]),
});
type OwnerOperationRoutineRow = typeof OwnerOperationRoutineRowSchema.Type;
/* oxlint-enable effect-native/no-nullable-schema-field */

type UuidInput = Readonly<{ readonly source: 'input'; readonly type: 'uuid' }>;
type TextInput = Readonly<{ readonly source: 'input'; readonly type: 'text' }>;
type IntegerInput = Readonly<{ readonly source: 'input'; readonly type: 'integer' }>;
type BooleanInput = Readonly<{ readonly source: 'input'; readonly type: 'boolean' }>;
type NullableUuidInput = Readonly<{ readonly nullable: true; readonly source: 'input'; readonly type: 'uuid' }>;
type NullableTextInput = Readonly<{ readonly nullable: true; readonly source: 'input'; readonly type: 'text' }>;
const uuid = (): UuidInput => ({ source: 'input', type: 'uuid' });
const text = (): TextInput => ({ source: 'input', type: 'text' });
const integer = (): IntegerInput => ({ source: 'input', type: 'integer' });
const boolean = (): BooleanInput => ({ source: 'input', type: 'boolean' });
const nullableUuid = (): NullableUuidInput => ({ nullable: true, source: 'input', type: 'uuid' });
const nullableText = (): NullableTextInput => ({ nullable: true, source: 'input', type: 'text' });

const createAttemptRoutine = defineScopedRoutine({
  name: 'create_portal_enrollment_attempt',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    uuid(),
    uuid(),
    text(),
    text(),
    text(),
    nullableUuid(),
    nullableUuid(),
    nullableText(),
  ],
  resultSchema: AttemptRoutineRowSchema,
  routineKey: 'portal-enrollment-attempt.create',
  schema: 'commerce_customer_context',
});

const claimTransitionRoutine = defineScopedRoutine({
  name: 'claim_portal_enrollment_transition',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    uuid(),
    integer(),
    text(),
    text(),
    text(),
    uuid(),
    text(),
    uuid(),
    boolean(),
    integer(),
    nullableText(),
    nullableText(),
  ],
  resultSchema: AttemptRoutineRowSchema,
  routineKey: 'portal-enrollment-attempt.claim-transition',
  schema: 'commerce_customer_context',
});

const recordOutcomeRoutine = defineScopedRoutine({
  name: 'record_portal_enrollment_outcome',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    uuid(),
    integer(),
    text(),
    uuid(),
    text(),
    text(),
    uuid(),
    uuid(),
    text(),
    nullableText(),
    nullableText(),
    nullableText(),
    nullableText(),
    nullableText(),
    nullableText(),
    nullableText(),
    nullableText(),
  ],
  resultSchema: AttemptRoutineRowSchema,
  routineKey: 'portal-enrollment-attempt.record-outcome',
  schema: 'commerce_customer_context',
});

const reconcileOutcomeRoutine = defineScopedRoutine({
  name: 'reconcile_portal_enrollment_outcome',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    uuid(),
    integer(),
    text(),
    text(),
    uuid(),
    uuid(),
    uuid(),
    text(),
    nullableText(),
    nullableText(),
    nullableText(),
    nullableText(),
    nullableText(),
    nullableText(),
    nullableText(),
    nullableText(),
  ],
  resultSchema: AttemptRoutineRowSchema,
  routineKey: 'portal-enrollment-attempt.reconcile-outcome',
  schema: 'commerce_customer_context',
});

const terminateAttemptRoutine = defineScopedRoutine({
  name: 'terminate_portal_enrollment',
  ownerModuleKey: MODULE_KEY,
  parameters: [{ source: 'tenantId', type: 'uuid' }, uuid(), integer(), uuid(), uuid(), text()],
  resultSchema: AttemptRoutineRowSchema,
  routineKey: 'portal-enrollment-attempt.terminate',
  schema: 'commerce_customer_context',
});

const readAttemptRoutine = defineScopedRoutine({
  name: 'read_portal_enrollment_attempt',
  ownerModuleKey: MODULE_KEY,
  parameters: [{ source: 'tenantId', type: 'uuid' }, uuid()],
  resultSchema: AttemptRoutineRowSchema,
  routineKey: 'portal-enrollment-attempt.read',
  schema: 'commerce_customer_context',
});

const readOwnerOperationRoutine = defineScopedRoutine({
  name: 'read_portal_enrollment_owner_operation',
  ownerModuleKey: MODULE_KEY,
  parameters: [{ source: 'tenantId', type: 'uuid' }, uuid(), text(), text()],
  resultSchema: OwnerOperationRoutineRowSchema,
  routineKey: 'portal-enrollment-attempt.read-owner-operation',
  schema: 'commerce_customer_context',
});

const authorizeAccountCreationRoutine = defineScopedRoutine({
  name: 'authorize_portal_enrollment_account_creation',
  ownerModuleKey: MODULE_KEY,
  parameters: [{ source: 'tenantId', type: 'uuid' }, uuid(), uuid()],
  resultSchema: Schema.Struct({
    // oxlint-disable-next-line effect-native/no-nullable-schema-field -- SQL uses NULL when no authorized owner operation exists; authorizeAccountCreationRows fails closed. Expires: 2027-03-31.
    evidence_ref: Schema.NullOr(EnrollmentEvidenceReferenceSchema),
    operation_outcome: Schema.Literals(['AUTHORIZED', 'NOT_AUTHORIZED', 'TERMINAL', 'INDETERMINATE']),
    revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  }),
  routineKey: 'portal-enrollment-attempt.authorize-account-creation',
  schema: 'commerce_customer_context',
});
type AuthorizeAccountCreationRow = typeof authorizeAccountCreationRoutine.resultSchema.Type;

const AuthorizeAccountCreationInputSchema = Schema.Struct({
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  tenantId: EnrollmentTenantIdSchema,
});

export interface EnrollmentAttemptScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

export interface AttemptCreateResult {
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly outcome: 'CREATED' | 'EXISTING';
}

export interface AttemptClaimResult {
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly operation: EnrollmentOwnerOperationSnapshot;
  readonly outcome: 'CLAIMED' | 'REPLAYED' | 'ALREADY_CLAIMED';
}

export interface AttemptRecordResult {
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly operation: EnrollmentOwnerOperationSnapshot;
  readonly outcome: 'RECORDED';
}

export interface AttemptTerminateResult {
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly outcome: 'TERMINATED' | 'ALREADY_TERMINAL';
}

export interface CommerceEnrollmentAttemptPersistence {
  readonly authorizeAccountCreation: (input: {
    readonly ownerInvocationId: string;
    readonly portalEnrollmentAttemptId: string;
    readonly tenantId: string;
  }) => Effect.Effect<{ readonly evidenceRef: string; readonly revision: number }, CommerceEnrollmentAttemptError>;
  readonly claim: (
    input: ClaimEnrollmentTransitionInput,
  ) => Effect.Effect<AttemptClaimResult, CommerceEnrollmentAttemptError>;
  readonly create: (
    input: StartEnrollmentAttemptInput,
  ) => Effect.Effect<AttemptCreateResult, CommerceEnrollmentAttemptError>;
  readonly read: (
    input: ReadEnrollmentAttemptInput,
  ) => Effect.Effect<EnrollmentAttemptSnapshot, CommerceEnrollmentAttemptError>;
  readonly readOperation: (
    input: ReadEnrollmentOwnerOperationInput,
  ) => Effect.Effect<EnrollmentOwnerOperationSnapshot, CommerceEnrollmentAttemptError>;
  readonly reconcile: (
    input: ReconcileEnrollmentOutcomeInput,
  ) => Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError>;
  readonly record: (
    input: RecordEnrollmentOutcomeInput,
  ) => Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError>;
  readonly terminate: (
    input: TerminateEnrollmentAttemptInput,
  ) => Effect.Effect<AttemptTerminateResult, CommerceEnrollmentAttemptError>;
}

const boundedReason = (reason: string): string => reason.slice(0, 500);

const unavailable = (cause?: unknown): InstanceType<typeof CommerceEnrollmentAttemptUnavailable> => {
  const error = new CommerceEnrollmentAttemptUnavailable({
    code: 'attempt_unavailable',
    reason: 'Commerce Enrollment Attempt persistence is temporarily unavailable',
    retryable: true,
  });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { enumerable: false, value: cause });
};

const invalid = (reason: string): InstanceType<typeof CommerceEnrollmentAttemptRejected> =>
  new CommerceEnrollmentAttemptRejected({
    code: 'attempt_invalid',
    reason: boundedReason(reason),
    retryable: false,
  });

const invalidWithCause = (reason: string, cause: unknown): InstanceType<typeof CommerceEnrollmentAttemptRejected> =>
  Object.defineProperty(invalid(reason), 'cause', { enumerable: false, value: cause });

const authorizeAccountCreationRows = (
  attemptId: EnrollmentAttemptId,
  ownerInvocationId: typeof EnrollmentActionInvocationIdSchema.Type,
  rows: readonly AuthorizeAccountCreationRow[],
): Effect.Effect<{ readonly evidenceRef: string; readonly revision: number }, CommerceEnrollmentAttemptError> => {
  const [row] = rows;
  if (row === undefined) {
    return Effect.fail(
      new CommerceEnrollmentAttemptNotFound({
        attemptId,
        code: 'attempt_not_found',
        reason: ATTEMPT_NOT_FOUND_REASON,
        retryable: false,
      }),
    );
  }
  if (row.operation_outcome === 'TERMINAL') {
    return Effect.fail(
      new CommerceEnrollmentAttemptRejected({
        attemptId,
        code: 'attempt_terminal',
        reason: 'A terminal Enrollment Attempt cannot authorize account creation',
        retryable: false,
      }),
    );
  }
  if (row.operation_outcome === 'INDETERMINATE') {
    return Effect.fail(
      new CommerceEnrollmentAttemptIndeterminate({
        attemptId,
        code: 'attempt_indeterminate',
        ownerInvocationId,
        reason: 'The provider creation transition requires reconciliation before account creation',
        retryable: true,
      }),
    );
  }
  if (row.operation_outcome !== 'AUTHORIZED') {
    return Effect.fail(
      new CommerceEnrollmentAttemptConflict({
        attemptId,
        code: 'attempt_lease_conflict',
        reason: 'The exact active provider creation transition is not authorized',
        retryable: true,
      }),
    );
  }
  if (row.evidence_ref === null) {
    return Effect.fail(
      new CommerceEnrollmentAttemptRejected({
        attemptId,
        code: 'attempt_invalid',
        reason: 'The authorized owner transition did not provide an evidence reference',
        retryable: false,
      }),
    );
  }
  return Effect.succeed({ evidenceRef: row.evidence_ref, revision: row.revision });
};

const requireAttemptRow = (
  rows: readonly AttemptRoutineRow[],
  operation: string,
  attemptId?: EnrollmentAttemptId,
): Effect.Effect<AttemptRoutineRow, CommerceEnrollmentAttemptError> => {
  const [row] = rows;
  return row === undefined
    ? Effect.fail(
        attemptId === undefined
          ? new CommerceEnrollmentAttemptUnavailable({
              code: 'attempt_unavailable',
              reason: `The ${operation} routine returned no result`,
              retryable: true,
            })
          : new CommerceEnrollmentAttemptNotFound({
              attemptId,
              code: 'attempt_not_found',
              reason: ATTEMPT_NOT_FOUND_REASON,
              retryable: false,
            }),
      )
    : Effect.succeed(row);
};

const requireOwnerRow = (
  rows: readonly OwnerOperationRoutineRow[],
  attemptId: EnrollmentAttemptId,
): Effect.Effect<OwnerOperationRoutineRow, CommerceEnrollmentAttemptError> => {
  const [row] = rows;
  return row === undefined
    ? Effect.fail(
        new CommerceEnrollmentAttemptNotFound({
          attemptId,
          code: 'attempt_not_found',
          reason: 'The Enrollment Attempt owner transition was not found',
          retryable: false,
        }),
      )
    : Effect.succeed(row);
};

const mapTimestamp = (value: Date | string): DateTime.Utc | undefined => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? parsed.value : undefined;
};

type OptionalPropertyValue =
  | boolean
  | CommercePortalAccountSubject
  | DateTime.Utc
  | EnrollmentAttemptLease
  | number
  | string
  | null
  | undefined;

const addOptionalProperty = <Value extends object>(target: Value, key: string, value: OptionalPropertyValue): Value => {
  if (value === null || value === undefined) {
    return target;
  }
  return Object.assign(target, { [key]: value });
};

const decodeAttemptSnapshot = (
  value: typeof EnrollmentAttemptSnapshotSchema.Encoded,
): Effect.Effect<EnrollmentAttemptSnapshot, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(EnrollmentAttemptSnapshotSchema)(value).pipe(
    Effect.mapError((cause) => invalidWithCause('The persisted Enrollment Attempt snapshot is invalid', cause)),
  );

const mapAttempt = (
  row: AttemptRoutineRow,
): Effect.Effect<EnrollmentAttemptSnapshot, CommerceEnrollmentAttemptError> => {
  const hasNamespace = row.authentication_namespace_id !== null;
  const hasProviderSubject = row.provider_subject_id !== null;
  const hasSubjectType = row.subject_type !== null;
  if (hasNamespace !== hasProviderSubject || hasNamespace !== hasSubjectType) {
    return Effect.fail(invalid('The Attempt account subject is incomplete'));
  }
  const createdAt = mapTimestamp(row.created_at);
  const updatedAt = mapTimestamp(row.updated_at);
  const leaseExpiresAt = row.lease_expires_at === null ? undefined : mapTimestamp(row.lease_expires_at);
  const terminatedAt = row.terminated_at === null ? undefined : mapTimestamp(row.terminated_at);
  if (
    createdAt === undefined ||
    updatedAt === undefined ||
    (row.lease_expires_at !== null && leaseExpiresAt === undefined)
  ) {
    return Effect.fail(invalid('The persisted Enrollment Attempt timestamp is invalid'));
  }
  if (row.terminated_at !== null && terminatedAt === undefined) {
    return Effect.fail(invalid('The persisted Enrollment Attempt termination timestamp is invalid'));
  }
  let accountSubject: CommercePortalAccountSubject | undefined;
  if (hasNamespace && hasProviderSubject && hasSubjectType) {
    accountSubject = {
      authenticationNamespaceId: row.authentication_namespace_id,
      providerSubjectId: row.provider_subject_id,
      subjectType: 'user',
    };
  }
  let attempt = {
    createdAt,
    createdByPrincipalId: row.created_by_principal_id,
    intentDigest: row.intent_digest,
    intentKey: row.intent_key,
    journey: row.journey,
    portalEnrollmentAttemptId: row.portal_enrollment_attempt_id,
    revision: row.revision,
    state: row.state,
    tenantId: row.tenant_id,
    updatedAt,
  };
  attempt = addOptionalProperty(attempt, 'accountSubject', accountSubject);
  attempt = addOptionalProperty(attempt, 'invitationId', row.invitation_id);
  attempt = addOptionalProperty(attempt, 'targetLegalEntityId', row.target_legal_entity_id);
  attempt = addOptionalProperty(attempt, 'targetResourceId', row.target_resource_id);
  attempt = addOptionalProperty(attempt, 'lastFailureCode', row.last_failure_code);
  attempt = addOptionalProperty(attempt, 'lastFailureReason', row.last_failure_reason);
  attempt = addOptionalProperty(attempt, 'lastOwnerInvocationId', row.last_owner_invocation_id);
  if (row.lease_owner !== null && row.lease_token !== null && leaseExpiresAt !== undefined) {
    attempt = addOptionalProperty(attempt, 'lease', {
      leaseExpiresAt,
      leaseToken: row.lease_token,
      workerId: row.lease_owner,
    });
  }
  attempt = addOptionalProperty(attempt, 'terminatedAt', terminatedAt);
  return decodeAttemptSnapshot(attempt);
};

const decodeOwnerOperationSnapshot = (
  value: typeof EnrollmentOwnerOperationSnapshotSchema.Encoded,
): Effect.Effect<EnrollmentOwnerOperationSnapshot, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(EnrollmentOwnerOperationSnapshotSchema)(value).pipe(
    Effect.mapError((cause) => invalidWithCause('The persisted owner transition journal snapshot is invalid', cause)),
  );

type OperationRowFields = Readonly<{
  actorPrincipalId: typeof nullablePrincipalId.Type;
  leaseExpiresAt: Date | string | null;
  leaseOwner: typeof nullableKey.Type;
  leaseToken: typeof nullableLeaseToken.Type;
  operationId: typeof nullableOwnerOperationId.Type;
  operationRevision: number | null;
  ownerInvocationId: typeof nullableActionInvocationId.Type;
  ownerModuleKey: typeof nullableModuleKey.Type;
  requestDigest: typeof nullableDigest.Type;
  required: boolean | null;
  status: typeof nullableOwnerStatus.Type;
  transitionKey: typeof nullableTransitionKey.Type;
}>;

const operationRowFields = (row: AttemptRoutineRow | OwnerOperationRoutineRow): OperationRowFields => {
  if ('operation_id' in row) {
    return {
      actorPrincipalId: row.operation_actor_principal_id,
      leaseExpiresAt: row.operation_lease_expires_at,
      leaseOwner: row.operation_lease_owner,
      leaseToken: row.operation_lease_token,
      operationId: row.operation_id,
      operationRevision: row.operation_revision,
      ownerInvocationId: row.owner_invocation_id,
      ownerModuleKey: row.owner_module_key,
      requestDigest: row.request_digest,
      required: row.required,
      status: row.operation_status,
      transitionKey: row.transition_key,
    };
  }
  return {
    actorPrincipalId: row.actor_principal_id,
    leaseExpiresAt: row.lease_expires_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    operationId: row.portal_enrollment_owner_operation_id,
    operationRevision: row.revision,
    ownerInvocationId: row.owner_invocation_id,
    ownerModuleKey: row.owner_module_key,
    requestDigest: row.request_digest,
    required: row.required,
    status: row.status,
    transitionKey: row.transition_key,
  };
};

const CompleteOperationRowFieldsSchema = Schema.Struct({
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  leaseExpiresAt: nullableTimestamp,
  leaseOwner: nullableKey,
  leaseToken: nullableLeaseToken,
  operationId: EnrollmentOwnerOperationIdSchema,
  operationRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  ownerModuleKey: EnrollmentModuleKeySchema,
  requestDigest: EnrollmentDigestSchema,
  required: Schema.Boolean,
  status: EnrollmentOwnerOperationStatusSchema,
  transitionKey: EnrollmentTransitionKeySchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const mapOptionalTimestamp = (value: Date | string | null): DateTime.Utc | undefined =>
  value === null ? undefined : mapTimestamp(value);

const mapOperation = (
  row: AttemptRoutineRow | OwnerOperationRoutineRow,
): Effect.Effect<EnrollmentOwnerOperationSnapshot, CommerceEnrollmentAttemptError> => {
  const fields = operationRowFields(row);
  const leaseExpiresAtValue = fields.leaseExpiresAt;
  if (!Schema.is(CompleteOperationRowFieldsSchema)(fields)) {
    return Effect.fail(invalid('The owner transition journal row is incomplete'));
  }
  const updatedAt = mapTimestamp(row.updated_at);
  const createdAt = mapTimestamp(row.created_at);
  const completedAt = mapOptionalTimestamp(row.completed_at);
  if (createdAt === undefined || updatedAt === undefined) {
    return Effect.fail(invalid('The owner transition journal timestamp is invalid'));
  }
  if (row.completed_at !== null && completedAt === undefined) {
    return Effect.fail(invalid('The owner transition journal lease timestamp is invalid'));
  }
  let operation = {
    actorPrincipalId: fields.actorPrincipalId,
    createdAt,
    ownerInvocationId: fields.ownerInvocationId,
    ownerModuleKey: fields.ownerModuleKey,
    portalEnrollmentAttemptId: row.portal_enrollment_attempt_id,
    portalEnrollmentOwnerOperationId: fields.operationId,
    requestDigest: fields.requestDigest,
    required: fields.required,
    revision: fields.operationRevision,
    status: fields.status,
    tenantId: row.tenant_id,
    transitionKey: fields.transitionKey,
    updatedAt,
  };
  operation = addOptionalProperty(operation, 'completedAt', completedAt);
  operation = addOptionalProperty(operation, 'failureCode', row.failure_code);
  operation = addOptionalProperty(operation, 'failureReason', row.failure_reason);
  const leaseExpiresAt = mapOptionalTimestamp(leaseExpiresAtValue);
  if (fields.leaseOwner !== null && fields.leaseToken !== null && leaseExpiresAt !== undefined) {
    operation = addOptionalProperty(operation, 'lease', {
      leaseExpiresAt,
      leaseToken: fields.leaseToken,
      workerId: fields.leaseOwner,
    });
  }
  operation = addOptionalProperty(operation, 'outcomeCode', row.outcome_code);
  operation = addOptionalProperty(operation, 'reconciliationRef', row.reconciliation_ref);
  operation = addOptionalProperty(operation, 'resultDigest', row.result_digest);
  operation = addOptionalProperty(operation, 'resultReference', row.result_reference);
  return decodeOwnerOperationSnapshot(operation);
};

const mapRoutineError = (cause: unknown): CommerceEnrollmentAttemptError => unavailable(cause);

const ensureTenant = (
  scope: OperationalScope,
  tenantId: string,
): Effect.Effect<void, CommerceEnrollmentAttemptError> =>
  scope.tenantId === tenantId
    ? Effect.void
    : Effect.fail(
        new CommerceEnrollmentAttemptConflict({
          code: 'attempt_conflict',
          reason: 'The Attempt Tenant does not match the verified operation Tenant',
          retryable: false,
        }),
      );

const mapOperationPersistenceError = (error: CommerceEnrollmentAttemptError): CommerceEnrollmentAttemptError =>
  Schema.is(CommerceEnrollmentAttemptRejected)(error) ? error : unavailable(error);

const operationFromAttemptRow = (row: AttemptRoutineRow) =>
  mapOperation(row).pipe(Effect.mapError(mapOperationPersistenceError));

type MappedAttemptOperation = Readonly<{
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly operation: EnrollmentOwnerOperationSnapshot;
}>;

const mapRecordedPair = ({ attempt, operation }: MappedAttemptOperation): AttemptRecordResult => ({
  attempt,
  operation,
  outcome: 'RECORDED',
});

const mapRecordedRow = (row: AttemptRoutineRow): Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError> =>
  Effect.all(
    {
      attempt: mapAttempt(row),
      operation: operationFromAttemptRow(row),
    },
    { concurrency: 1 },
  ).pipe(Effect.map(mapRecordedPair));

const claimOutcome = (outcome: string): AttemptClaimResult['outcome'] => {
  if (outcome === 'REPLAYED') {
    return 'REPLAYED';
  }
  if (outcome === 'ALREADY_CLAIMED') {
    return 'ALREADY_CLAIMED';
  }
  return 'CLAIMED';
};

const mapClaimRow = (
  input: ClaimEnrollmentTransitionInput,
  row: AttemptRoutineRow,
): Effect.Effect<AttemptClaimResult, CommerceEnrollmentAttemptError> => {
  if (row.attempt_outcome === 'NOT_FOUND') {
    return Effect.fail(
      new CommerceEnrollmentAttemptNotFound({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_not_found',
        reason: ATTEMPT_NOT_FOUND_REASON,
        retryable: false,
      }),
    );
  }
  if (row.attempt_outcome === 'CONFLICT' || row.attempt_outcome === 'SUBJECT_CONFLICT') {
    return Effect.fail(
      new CommerceEnrollmentAttemptConflict({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_conflict',
        reason: 'The immutable Attempt or owner transition identity conflicts with this request',
        retryable: false,
      }),
    );
  }
  if (row.attempt_outcome === 'REVISION_CONFLICT' || row.attempt_outcome === 'LEASE_CONFLICT') {
    return Effect.fail(
      new CommerceEnrollmentAttemptConflict({
        attemptId: input.portalEnrollmentAttemptId,
        code: row.attempt_outcome === 'LEASE_CONFLICT' ? 'attempt_lease_conflict' : 'attempt_revision_conflict',
        reason: 'The Attempt was changed by another worker; reload its Current revision',
        retryable: true,
      }),
    );
  }
  if (row.attempt_outcome === 'INDETERMINATE') {
    return Effect.fail(
      new CommerceEnrollmentAttemptIndeterminate({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_indeterminate',
        ownerInvocationId: input.ownerInvocationId,
        reason: 'The prior owner transition outcome is indeterminate and must be resolved first',
        retryable: true,
      }),
    );
  }
  if (row.attempt_outcome === 'TERMINAL') {
    return Effect.fail(
      new CommerceEnrollmentAttemptRejected({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_terminal',
        reason: 'A terminal Enrollment Attempt cannot perform another transition',
        retryable: false,
      }),
    );
  }
  if (row.attempt_outcome === 'ALREADY_CLAIMED' && row.operation_id === null) {
    return Effect.fail(
      new CommerceEnrollmentAttemptConflict({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_lease_conflict',
        reason: 'The Enrollment Attempt lease is held by another owner transition',
        retryable: true,
      }),
    );
  }
  return Effect.all(
    {
      attempt: mapAttempt(row),
      operation: operationFromAttemptRow(row),
    },
    { concurrency: 1 },
  ).pipe(
    Effect.map(({ attempt, operation }) => ({
      attempt,
      operation,
      outcome: claimOutcome(row.attempt_outcome),
    })),
  );
};

const mapCreateRow = (row: AttemptRoutineRow): Effect.Effect<AttemptCreateResult, CommerceEnrollmentAttemptError> => {
  if (row.attempt_outcome === 'CONFLICT') {
    return Effect.fail(
      new CommerceEnrollmentAttemptConflict({
        code: 'attempt_conflict',
        reason: 'The Attempt intent key is already bound to a different immutable enrollment intent',
        retryable: false,
      }),
    );
  }
  return mapAttempt(row).pipe(
    Effect.map((attempt) => ({
      attempt,
      outcome: row.attempt_outcome === 'CREATED' ? ('CREATED' as const) : ('EXISTING' as const),
    })),
  );
};

const mapRecordRow = (
  input: RecordEnrollmentOutcomeInput,
  row: AttemptRoutineRow,
): Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError> => {
  if (row.attempt_outcome === 'NOT_FOUND') {
    return Effect.fail(
      new CommerceEnrollmentAttemptNotFound({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_not_found',
        reason: ATTEMPT_NOT_FOUND_REASON,
        retryable: false,
      }),
    );
  }
  if (row.attempt_outcome === 'TERMINAL') {
    return Effect.fail(
      new CommerceEnrollmentAttemptRejected({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_terminal',
        reason: 'A terminal Enrollment Attempt cannot record a new owner outcome',
        retryable: false,
      }),
    );
  }
  if (row.attempt_outcome === 'REVISION_CONFLICT' || row.attempt_outcome === 'LEASE_CONFLICT') {
    return Effect.fail(
      new CommerceEnrollmentAttemptConflict({
        attemptId: input.portalEnrollmentAttemptId,
        code: row.attempt_outcome === 'LEASE_CONFLICT' ? 'attempt_lease_conflict' : 'attempt_revision_conflict',
        reason: 'The owner transition lease is stale or the Attempt revision changed',
        retryable: true,
      }),
    );
  }
  if (row.attempt_outcome === 'INDETERMINATE') {
    return Effect.fail(
      new CommerceEnrollmentAttemptIndeterminate({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_indeterminate',
        ownerInvocationId: input.ownerInvocationId,
        reason: 'The owner transition requires governed reconciliation before another outcome',
        retryable: true,
      }),
    );
  }
  if (row.attempt_outcome === 'CONFLICT' || row.attempt_outcome === 'SUBJECT_CONFLICT') {
    return Effect.fail(
      new CommerceEnrollmentAttemptConflict({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_conflict',
        reason: 'The immutable owner transition identity conflicts with this outcome request',
        retryable: false,
      }),
    );
  }
  return mapRecordedRow(row);
};

const mapReconcileRow = (
  input: ReconcileEnrollmentOutcomeInput,
  row: AttemptRoutineRow,
): Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError> => {
  if (row.attempt_outcome === 'NOT_FOUND') {
    return Effect.fail(
      new CommerceEnrollmentAttemptNotFound({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_not_found',
        reason: ATTEMPT_NOT_FOUND_REASON,
        retryable: false,
      }),
    );
  }
  if (row.attempt_outcome === 'TERMINAL') {
    return Effect.fail(
      new CommerceEnrollmentAttemptRejected({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_terminal',
        reason: 'A terminal Enrollment Attempt cannot be reconciled',
        retryable: false,
      }),
    );
  }
  if (row.attempt_outcome === 'REVISION_CONFLICT') {
    return Effect.fail(
      new CommerceEnrollmentAttemptConflict({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_revision_conflict',
        reason: 'The Attempt revision is stale; reconciliation did not change owner state',
        retryable: true,
      }),
    );
  }
  if (row.attempt_outcome === 'CONFLICT' || row.attempt_outcome === 'SUBJECT_CONFLICT') {
    return Effect.fail(
      new CommerceEnrollmentAttemptConflict({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_conflict',
        reason: 'The authoritative reconciliation does not match the original owner transition',
        retryable: false,
      }),
    );
  }
  if (row.attempt_outcome === 'INDETERMINATE') {
    return Effect.fail(
      new CommerceEnrollmentAttemptIndeterminate({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_indeterminate',
        ownerInvocationId: input.ownerInvocationId,
        reason: 'The original owner outcome remains indeterminate after reconciliation',
        retryable: true,
      }),
    );
  }
  return mapRecordedRow(row);
};

const mapTerminateRow = (
  input: TerminateEnrollmentAttemptInput,
  row: AttemptRoutineRow,
): Effect.Effect<AttemptTerminateResult, CommerceEnrollmentAttemptError> => {
  if (row.attempt_outcome === 'NOT_FOUND') {
    return Effect.fail(
      new CommerceEnrollmentAttemptNotFound({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_not_found',
        reason: ATTEMPT_NOT_FOUND_REASON,
        retryable: false,
      }),
    );
  }
  if (row.attempt_outcome === 'REVISION_CONFLICT') {
    return Effect.fail(
      new CommerceEnrollmentAttemptConflict({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_revision_conflict',
        reason: 'The Attempt revision is stale; termination did not change it',
        retryable: true,
      }),
    );
  }
  return mapAttempt(row).pipe(
    Effect.map((attempt) => ({
      attempt,
      outcome: row.attempt_outcome === 'ALREADY_TERMINAL' ? ('ALREADY_TERMINAL' as const) : ('TERMINATED' as const),
    })),
  );
};

const authorizeRowsForInput =
  (input: typeof AuthorizeAccountCreationInputSchema.Type) => (rows: readonly AuthorizeAccountCreationRow[]) =>
    authorizeAccountCreationRows(input.portalEnrollmentAttemptId, input.ownerInvocationId, rows);

export const commerceEnrollmentAttemptPersistenceForTransaction = (
  transaction: EnrollmentAttemptScopedRoutineInvoker,
  scope: OperationalScope,
): CommerceEnrollmentAttemptPersistence => {
  const invokeAttempt = <Parameters extends readonly ScopedRoutineParameter[]>(
    routine: ScopedRoutineDefinition<typeof AttemptRoutineRowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => transaction.invoke(routine, values).pipe(Effect.mapError(mapRoutineError));

  return {
    authorizeAccountCreation: (input) =>
      Schema.decodeEffect(AuthorizeAccountCreationInputSchema)(input).pipe(
        Effect.mapError((cause) => invalidWithCause('The account-creation authorization request is invalid', cause)),
        Effect.flatMap((decoded) =>
          ensureTenant(scope, decoded.tenantId).pipe(
            Effect.flatMap(() =>
              transaction
                .invoke(authorizeAccountCreationRoutine, [decoded.portalEnrollmentAttemptId, decoded.ownerInvocationId])
                .pipe(Effect.mapError(mapRoutineError), Effect.flatMap(authorizeRowsForInput(decoded))),
            ),
          ),
        ),
      ),
    claim: (input) =>
      ensureTenant(scope, input.tenantId).pipe(
        Effect.flatMap(() =>
          invokeAttempt(claimTransitionRoutine, [
            input.portalEnrollmentAttemptId,
            input.expectedRevision,
            input.workerId,
            input.ownerModuleKey,
            input.transitionKey,
            input.ownerInvocationId,
            input.requestDigest,
            input.actorPrincipalId,
            input.required,
            input.leaseDurationMs,
            input.accountSubject?.authenticationNamespaceId ?? null,
            input.accountSubject?.providerSubjectId ?? null,
          ]).pipe(
            Effect.flatMap((rows) =>
              requireAttemptRow(rows, 'claim_portal_enrollment_transition', input.portalEnrollmentAttemptId),
            ),
            Effect.flatMap((row) => mapClaimRow(input, row)),
          ),
        ),
      ),
    create: (input) =>
      ensureTenant(scope, input.tenantId).pipe(
        Effect.flatMap(() =>
          invokeAttempt(createAttemptRoutine, [
            input.actionInvocationId,
            input.actorPrincipalId,
            input.journey,
            input.intentKey,
            input.intentDigest,
            input.invitationId ?? null,
            input.targetLegalEntityId ?? null,
            input.targetResourceId ?? null,
          ]).pipe(
            Effect.flatMap((rows) => requireAttemptRow(rows, 'create_portal_enrollment_attempt')),
            Effect.flatMap(mapCreateRow),
          ),
        ),
      ),
    read: (input) =>
      ensureTenant(scope, input.tenantId).pipe(
        Effect.flatMap(() =>
          invokeAttempt(readAttemptRoutine, [input.portalEnrollmentAttemptId]).pipe(
            Effect.flatMap((rows) => {
              const [row] = rows;
              return row === undefined
                ? Effect.fail(
                    new CommerceEnrollmentAttemptNotFound({
                      attemptId: input.portalEnrollmentAttemptId,
                      code: 'attempt_not_found',
                      reason: ATTEMPT_NOT_FOUND_REASON,
                      retryable: false,
                    }),
                  )
                : mapAttempt(row);
            }),
          ),
        ),
      ),
    readOperation: (input) =>
      ensureTenant(scope, input.tenantId).pipe(
        Effect.flatMap(() =>
          transaction
            .invoke(readOwnerOperationRoutine, [
              input.portalEnrollmentAttemptId,
              input.ownerModuleKey,
              input.transitionKey,
            ])
            .pipe(
              Effect.mapError(mapRoutineError),
              Effect.flatMap((rows) => requireOwnerRow(rows, input.portalEnrollmentAttemptId)),
              Effect.flatMap(mapOperation),
            ),
        ),
      ),
    reconcile: (input) =>
      ensureTenant(scope, input.tenantId).pipe(
        Effect.flatMap(() =>
          invokeAttempt(reconcileOutcomeRoutine, [
            input.portalEnrollmentAttemptId,
            input.expectedRevision,
            input.ownerModuleKey,
            input.transitionKey,
            input.ownerInvocationId,
            input.reconciliationRef,
            input.actorPrincipalId,
            input.status,
            input.outcomeCode ?? null,
            input.resultReference ?? null,
            input.resultDigest ?? null,
            input.failureCode ?? null,
            input.failureReason ?? null,
            input.nextState ?? null,
            input.accountSubject?.authenticationNamespaceId ?? null,
            input.accountSubject?.providerSubjectId ?? null,
          ]).pipe(
            Effect.flatMap((rows) =>
              requireAttemptRow(rows, 'reconcile_portal_enrollment_outcome', input.portalEnrollmentAttemptId),
            ),
            Effect.flatMap((row) => mapReconcileRow(input, row)),
          ),
        ),
      ),
    record: (input) =>
      ensureTenant(scope, input.tenantId).pipe(
        Effect.flatMap(() =>
          invokeAttempt(recordOutcomeRoutine, [
            input.portalEnrollmentAttemptId,
            input.expectedRevision,
            input.workerId,
            input.leaseToken,
            input.ownerModuleKey,
            input.transitionKey,
            input.ownerInvocationId,
            input.actorPrincipalId,
            input.status,
            input.outcomeCode ?? null,
            input.resultReference ?? null,
            input.resultDigest ?? null,
            input.failureCode ?? null,
            input.failureReason ?? null,
            input.nextState ?? null,
            input.accountSubject?.authenticationNamespaceId ?? null,
            input.accountSubject?.providerSubjectId ?? null,
          ]).pipe(
            Effect.flatMap((rows) =>
              requireAttemptRow(rows, 'record_portal_enrollment_outcome', input.portalEnrollmentAttemptId),
            ),
            Effect.flatMap((row) => mapRecordRow(input, row)),
          ),
        ),
      ),
    terminate: (input) =>
      ensureTenant(scope, input.tenantId).pipe(
        Effect.flatMap(() =>
          invokeAttempt(terminateAttemptRoutine, [
            input.portalEnrollmentAttemptId,
            input.expectedRevision,
            input.actionInvocationId,
            input.actorPrincipalId,
            input.reason,
          ]).pipe(
            Effect.flatMap((rows) =>
              requireAttemptRow(rows, 'terminate_portal_enrollment', input.portalEnrollmentAttemptId),
            ),
            Effect.flatMap((row) => mapTerminateRow(input, row)),
          ),
        ),
      ),
  };
};
