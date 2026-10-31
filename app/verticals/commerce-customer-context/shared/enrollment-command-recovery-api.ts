import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  CommercePortalAuthEnrollmentAuthenticationProblemSchema,
  CommercePortalAuthEnrollmentInvalidProblemSchema,
  CommercePortalAuthEnrollmentSchemaErrorMiddleware,
  CommercePortalAuthEnrollmentUnavailableProblemSchema,
} from './portal-auth/enrollment-api.ts';
import { EnrollmentActionInvocationIdSchema } from './enrollment-contracts.ts';

const EnrollmentCommandRecoveryKeySchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
).pipe(Schema.brand('EnrollmentCommandRecoveryKey'));

export const EnrollmentCommandRecoveryInputSchema = Schema.Struct({
  actionKey: Schema.Literals([
    'commerce.customer-context.ensure-retail-customer-profile',
    'commerce.customer-context.bind-retail-portal-profile',
  ]),
  idempotencyKey: EnrollmentCommandRecoveryKeySchema,
});
export const EnrollmentCommandRecoveryResultSchema = Schema.Union([
  Schema.Struct({ retryCommand: Schema.Literal(true), state: Schema.Literal('NOT_STARTED') }),
  Schema.Struct({
    invocationId: EnrollmentActionInvocationIdSchema,
    retryCommand: Schema.Literal(true),
    state: Schema.Literal('RETRYABLE'),
  }),
  Schema.Struct({
    invocationId: EnrollmentActionInvocationIdSchema,
    retryCommand: Schema.Literal(false),
    state: Schema.Literals(['RUNNING', 'COMMITTED', 'REJECTED']),
  }),
]);
export const EnrollmentCommandRecoveryApi = HttpApi.make('EnrollmentCommandRecoveryApi').add(
  HttpApiGroup.make('enrollmentCommandRecovery')
    .add(
      HttpApiEndpoint.post('resolve', '/api/enrollment/commands/resolve', {
        error: [
          CommercePortalAuthEnrollmentAuthenticationProblemSchema,
          CommercePortalAuthEnrollmentInvalidProblemSchema,
          CommercePortalAuthEnrollmentUnavailableProblemSchema,
        ],
        payload: EnrollmentCommandRecoveryInputSchema,
        success: EnrollmentCommandRecoveryResultSchema,
      }),
    )
    .middleware(CommercePortalAuthEnrollmentSchemaErrorMiddleware),
);
