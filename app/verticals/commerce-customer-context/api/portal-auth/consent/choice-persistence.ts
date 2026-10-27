import { defineScopedRoutine } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { CustomerConsentRequestIdSchema, DEMO_NEWSLETTER_NOTICE } from '../../../shared/portal-auth/consent-api.ts';
import type { UpdateCustomerOwnConsent } from '../../../shared/portal-auth/consent-api.ts';
import { attemptUnavailable } from '../../../src/enrollment/attempts/errors.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../../src/enrollment/orchestration/owner-transition-production.ts';
import { consentConflict, consentUnavailable } from './problems.ts';

export const StoredChoiceSchema = Schema.Struct({
  changedAt: Schema.DateTimeUtcFromString,
  decision: Schema.Literals(['GRANTED', 'WITHDRAWN']),
  noticeVersionId: Schema.Literal(DEMO_NEWSLETTER_NOTICE.noticeVersionId),
  requestId: CustomerConsentRequestIdSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type StoredChoice = typeof StoredChoiceSchema.Type;

interface ChoiceScope {
  readonly legalEntityId: string;
  readonly partyId: string;
  readonly tenantId: string;
}

const readRoutine = defineScopedRoutine({
  name: 'read_demo_newsletter_choice',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ choice: StoredChoiceSchema }),
  routineKey: 'demo-newsletter.choice.read',
  schema: 'commerce_customer_context',
});
const writeRoutine = defineScopedRoutine({
  name: 'write_demo_newsletter_choice',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ choice: StoredChoiceSchema }),
  routineKey: 'demo-newsletter.choice.write',
  schema: 'commerce_customer_context',
});

export const readDemoNewsletterChoice = Effect.fn('DemoNewsletter.readChoice')(function* readChoice(
  scope: ChoiceScope,
) {
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const rows = yield* runner
    .run(scope, (transaction) =>
      transaction
        .invoke(readRoutine, [scope.partyId])
        .pipe(
          Effect.mapError((cause) => attemptUnavailable('Demo newsletter choice could not be read', undefined, cause)),
        ),
    )
    .pipe(Effect.mapError(consentUnavailable));
  if (rows.length > 1) {
    return yield* Effect.fail(consentUnavailable());
  }
  return Option.fromNullishOr(rows[0]?.choice);
});

export const writeDemoNewsletterChoice = Effect.fn('DemoNewsletter.writeChoice')(function* writeChoice(
  scope: ChoiceScope,
  input: UpdateCustomerOwnConsent,
) {
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const rows = yield* runner
    .run(scope, (transaction) =>
      transaction
        .invoke(writeRoutine, [
          scope.partyId,
          input.expectedRevision,
          input.decision,
          input.noticeVersionId,
          input.requestId,
        ])
        .pipe(
          Effect.mapError((cause) => attemptUnavailable('Demo newsletter choice could not be saved', undefined, cause)),
        ),
    )
    .pipe(Effect.mapError(consentUnavailable));
  if (rows.length === 0) {
    return yield* Effect.fail(consentConflict());
  }
  const retained = rows[0]?.choice;
  if (rows.length !== 1 || retained === undefined) {
    return yield* Effect.fail(consentUnavailable());
  }
  return retained;
});
