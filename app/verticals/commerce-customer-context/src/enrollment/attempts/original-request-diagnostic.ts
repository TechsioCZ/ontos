import { defineScopedRoutine } from '@app/core-runtime';
import type { ActionRuntime, TrustedPrincipalContext } from '@app/core-runtime';
import { computeActionRequestHash } from '@app/core-runtime/actions/runtime-wiring';
import { Context, Effect, Schema } from 'effect';

import { StartPortalEnrollmentPayloadSchema } from '../../../shared/actions/start-portal-enrollment.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../../../shared/enrollment-contracts.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../orchestration/owner-transition-production.ts';
import { attemptUnavailable } from './errors.ts';

const requestId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('OriginalEnrollmentRequestId'));
const startActionKey = 'commerce.customer-context.start-portal-enrollment';

/** Operator input is the original credential-free Action intent, never a new registration request. */
export const OriginalEnrollmentRequestSchema = Schema.Struct({
  expectedScope: Schema.Struct({
    legalEntityId: EnrollmentLegalEntityIdSchema,
    principalId: EnrollmentPrincipalIdSchema,
    tenantId: EnrollmentTenantIdSchema,
  }),
  expectedStartInvocationId: EnrollmentActionInvocationIdSchema,
  originalIntent: StartPortalEnrollmentPayloadSchema,
  requestId,
});

const failureFields = {
  code: Schema.Literals(['ORIGINAL_REQUEST_NOT_AVAILABLE', 'ORIGINAL_REQUEST_DIAGNOSTIC_UNAVAILABLE']),
};
const failureContract = Schema.TaggedStruct('OriginalEnrollmentDiagnosticError', failureFields);
export const OriginalEnrollmentDiagnosticError = Schema.TaggedError<typeof failureContract.Type>()(
  'OriginalEnrollmentDiagnosticError',
  failureFields,
);

const notAvailable = () => new OriginalEnrollmentDiagnosticError({ code: 'ORIGINAL_REQUEST_NOT_AVAILABLE' });
const unavailable = () => new OriginalEnrollmentDiagnosticError({ code: 'ORIGINAL_REQUEST_DIAGNOSTIC_UNAVAILABLE' });

type OriginalReceiptLookup = Parameters<typeof ActionRuntime.Service.resolveActionExecution>[0] & {
  readonly expectedRequestHash: string;
};

/** No Action execution, provider, delivery, reconciliation or grant capability is exposed here. */
export class OriginalEnrollmentReceiptRead extends Context.Service<
  OriginalEnrollmentReceiptRead,
  {
    readonly resolveActionExecution: (
      input: OriginalReceiptLookup,
    ) => ReturnType<typeof ActionRuntime.Service.resolveActionExecution>;
  }
>()('@app/commerce-customer-context/enrollment/attempts/original-request-diagnostic/OriginalEnrollmentReceiptRead') {}

export const originalEnrollmentRequestRoutine = defineScopedRoutine({
  name: 'read_original_portal_enrollment',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({ portal_enrollment_attempt_id: EnrollmentAttemptIdSchema }),
  routineKey: 'portal-enrollment.original-request.read',
  schema: 'commerce_customer_context',
});

/**
 * Operator-only orchestration. The entrypoint must supply a fresh, redeemed gateway Principal.
 * The legacy shared database role can forge session settings; this is not DB operator isolation.
 */
export const readOriginalEnrollmentRequest = Effect.fn('OriginalEnrollmentRequest.read')(
  function* readOriginalEnrollmentRequest(
    input: typeof OriginalEnrollmentRequestSchema.Encoded,
    principal: TrustedPrincipalContext,
  ) {
    const request = yield* Schema.decodeUnknownEffect(OriginalEnrollmentRequestSchema, {
      onExcessProperty: 'error',
    })(input).pipe(Effect.catchTag('SchemaError', () => Effect.fail(notAvailable())));
    const { expectedScope, originalIntent } = request;
    if (
      principal.authMethod !== 'api_key' ||
      principal.principalId !== expectedScope.principalId ||
      principal.tenantId !== expectedScope.tenantId ||
      principal.legalEntityId !== expectedScope.legalEntityId ||
      originalIntent.journey !== 'RETAIL_SELF_ENROLLMENT' ||
      originalIntent.targetLegalEntityId !== principal.legalEntityId ||
      originalIntent.retailRegistration === undefined
    ) {
      return yield* notAvailable();
    }
    const normalizedPayload = yield* Schema.encodeEffect(StartPortalEnrollmentPayloadSchema)(originalIntent).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(notAvailable())),
    );
    // The start descriptor has no permission target, and its HTTP transport supplies no target.
    // Use the identical Core canonicalizer and payload codec; do not log either hash or payload.
    const expectedRequestHash = computeActionRequestHash({
      actionKey: startActionKey,
      normalizedPayload,
      owningModuleKey: 'commerce.customer-context',
      principal,
      schemaVersion: '1',
      target: {},
    });
    const receipt = yield* (yield* OriginalEnrollmentReceiptRead)
      .resolveActionExecution({
        actionKey: startActionKey,
        expectedRequestHash,
        idempotencyKey: `storefront-enrollment:${request.requestId}`,
        principal,
      })
      .pipe(
        Effect.catchTags({
          ActionInvocationPersistenceError: () => Effect.fail(unavailable()),
          ActionPayloadValidationError: () => Effect.fail(notAvailable()),
          ActionTrustedContextValidationError: () => Effect.fail(notAvailable()),
        }),
      );
    if (
      receipt.state !== 'COMMITTED' ||
      receipt.invocationId !== request.expectedStartInvocationId ||
      receipt.actionKey !== startActionKey
    ) {
      return yield* notAvailable();
    }
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    const rows = yield* runner
      .run({ legalEntityId: principal.legalEntityId, tenantId: principal.tenantId }, (transaction) =>
        transaction
          .invoke(originalEnrollmentRequestRoutine, [
            principal.principalId,
            originalIntent.intentKey,
            originalIntent.intentDigest,
          ])
          .pipe(
            Effect.catchTag('ScopedRoutineInvocationError', () =>
              Effect.fail(attemptUnavailable('Original request diagnostic unavailable')),
            ),
          ),
      )
      .pipe(
        Effect.catchTags({
          CommerceEnrollmentAttemptConflict: () => Effect.fail(unavailable()),
          CommerceEnrollmentAttemptIndeterminate: () => Effect.fail(unavailable()),
          CommerceEnrollmentAttemptNotFound: () => Effect.fail(unavailable()),
          CommerceEnrollmentAttemptRejected: () => Effect.fail(unavailable()),
          CommerceEnrollmentAttemptUnavailable: () => Effect.fail(unavailable()),
        }),
      );
    const [row] = rows;
    if (row === undefined || rows.length !== 1) {
      return yield* notAvailable();
    }
    return { portalEnrollmentAttemptId: row.portal_enrollment_attempt_id };
  },
);
