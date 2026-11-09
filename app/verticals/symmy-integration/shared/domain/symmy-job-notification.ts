import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { SymmyItemOutcomeSchema } from '@app/shared-contracts/symmy';
import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Schema } from 'effect';

const reference = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(120));
const uuid = Schema.String.check(Schema.isUUID());
export const SymmyLifecycleRouteIdSchema = uuid.pipe(Schema.brand('SymmyExecutionRouteId'));
const policyId = reference.pipe(Schema.brand('SymmyJobLifecyclePolicyId'));
const recipientId = reference.pipe(Schema.brand('SymmyJobNotificationRecipientId'));
const positive = Schema.Int.check(Schema.isGreaterThan(0));

/** References are pinned from operator-owned route configuration, never from an ingress body. */
export const SymmyJobLifecyclePolicyRefSchema = Schema.Struct({
  notificationRequested: Schema.optionalKey(Schema.Boolean),
  policyId,
  revision: reference,
});
export type SymmyJobLifecyclePolicyRef = typeof SymmyJobLifecyclePolicyRefSchema.Type;

export const SymmyJobCompletionNotificationSchema = Schema.Struct({
  contract: Schema.Literal('INTERNAL_C14_NOTIFICATION_V1'),
  event: Schema.Literals(['symmy.import_job.completed', 'symmy.import_job.failed']),
  job: Schema.Struct({
    id: uuid,
    items: Schema.NonEmptyArray(
      SymmyItemOutcomeSchema.check(
        Schema.makeFilter(
          ({ effects }) =>
            (effects.length > 0 && effects.length <= 35) || 'A callback item must retain its bounded effect outcomes',
        ),
      ),
    ).check(Schema.isMaxLength(16)),
    status: Schema.Literals(['completed_all', 'completed_partial', 'completed_none']),
  }),
}).check(
  Schema.makeFilter(({ event, job }) => {
    const effects = job.items.flatMap(({ effects: outcomes }) => outcomes);
    if (effects.some(({ status }) => status === 'unavailable' || status === 'indeterminate')) {
      return 'Only terminal outcomes can be notified';
    }
    const accepted = effects.filter(
      ({ status }) => status === 'accepted_change' || status === 'accepted_no_change' || status === 'duplicate',
    ).length;
    let expected = 'completed_none';
    if (accepted === effects.length) {
      expected = 'completed_all';
    } else if (accepted > 0) {
      expected = 'completed_partial';
    }
    return (
      (job.status === expected &&
        event === (expected === 'completed_none' ? 'symmy.import_job.failed' : 'symmy.import_job.completed')) ||
      'Notification status must preserve the exact terminal per-effect outcomes'
    );
  }),
);
export type SymmyJobCompletionNotification = typeof SymmyJobCompletionNotificationSchema.Type;

const recipientUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
      ? undefined
      : 'A callback recipient must be an exact HTTPS URL without credentials, query, or fragment',
  ),
);

export const SymmyJobNotificationPolicySchema = Schema.Struct({
  ...SymmyJobLifecyclePolicyRefSchema.fields,
  authorization: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))),
  initialBackoffMs: positive.check(Schema.isLessThanOrEqualTo(3_600_000)),
  maxAttempts: positive.check(Schema.isLessThanOrEqualTo(20)),
  maxBackoffMs: positive.check(Schema.isLessThanOrEqualTo(86_400_000)),
  recipientId,
  recipientUrl,
  routeId: SymmyLifecycleRouteIdSchema,
  tenantId: TenantIdSchema,
  timeoutMs: positive.check(Schema.isLessThanOrEqualTo(60_000)),
}).check(
  Schema.makeFilter(
    ({ initialBackoffMs, maxBackoffMs }) =>
      initialBackoffMs <= maxBackoffMs || 'The maximum callback delay must cover the initial delay',
  ),
);
export type SymmyJobNotificationPolicy = typeof SymmyJobNotificationPolicySchema.Type;

export const SymmyJobNotificationClaimSchema = Schema.Struct({
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mode: Schema.Literals(['CLAIMED', 'DELIVERED', 'EXHAUSTED', 'BUSY', 'NOT_DUE', 'CONFLICT']),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SymmyJobNotificationClaim = typeof SymmyJobNotificationClaimSchema.Type;

export interface SymmyJobNotificationClaimInput {
  readonly claimToken: string;
  readonly context?: OutboxWorkerHandlerContext;
  readonly destinationDigest: string;
  readonly jobId: string;
  readonly payloadDigest: string;
  readonly policy: Pick<
    SymmyJobNotificationPolicy,
    'initialBackoffMs' | 'maxAttempts' | 'maxBackoffMs' | 'policyId' | 'recipientId' | 'revision' | 'timeoutMs'
  >;
}

export interface SymmyJobNotificationSettlement {
  readonly claimToken: string;
  readonly context?: OutboxWorkerHandlerContext;
  readonly delivered: boolean;
  readonly jobId: string;
  readonly retryable: boolean;
  readonly version: number;
}
