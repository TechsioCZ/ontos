import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/http-api';
import { Schema } from 'effect';

import { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';

/** Both fields cross the wire as plain strings; the owner verifies the current one and never stores either. */
const CurrentPasswordSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(COMMERCE_PORTAL_AUTH_POLICY.password.maxLength),
);
const NewPasswordSchema = Schema.String.check(
  Schema.isMinLength(COMMERCE_PORTAL_AUTH_POLICY.password.minLength),
  Schema.isMaxLength(COMMERCE_PORTAL_AUTH_POLICY.password.maxLength),
);

export const UpdateCustomerPasswordSchema = Schema.Struct({
  currentPassword: CurrentPasswordSchema,
  newPassword: NewPasswordSchema,
});
export type UpdateCustomerPassword = typeof UpdateCustomerPasswordSchema.Type;

export const CustomerPasswordChangedSchema = Schema.Struct({
  outcome: Schema.Literal('PASSWORD_CHANGED'),
});

export const PasswordChangeInvalidProblemSchema = makeProblemDetailsSchema(
  'CustomerPasswordChangeInvalidProblem',
  400,
  { code: Schema.Literal('invalid_request') },
);
export const PasswordChangeCurrentInvalidProblemSchema = makeProblemDetailsSchema(
  'CustomerPasswordChangeCurrentInvalidProblem',
  400,
  { code: Schema.Literal('current_password_invalid') },
);
export const PasswordChangeAuthenticationProblemSchema = makeProblemDetailsSchema(
  'CustomerPasswordChangeAuthenticationProblem',
  401,
  { code: Schema.Literal('authentication_failed') },
);
export const PasswordChangeForbiddenProblemSchema = makeProblemDetailsSchema(
  'CustomerPasswordChangeForbiddenProblem',
  403,
  { code: Schema.Literal('password_change_forbidden') },
);
export const PasswordChangeRateLimitedProblemSchema = makeProblemDetailsSchema(
  'CustomerPasswordChangeRateLimitedProblem',
  429,
  { code: Schema.Literal('rate_limited') },
);
export const PasswordChangeUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CustomerPasswordChangeUnavailableProblem',
  503,
  { code: Schema.Literal('password_change_unavailable') },
);

export class CustomerOwnPasswordChangeSchemaError extends HttpApiMiddleware.Service<CustomerOwnPasswordChangeSchemaError>()(
  'commerce-customer-context/CustomerOwnPasswordChangeSchemaError',
  { error: PasswordChangeInvalidProblemSchema },
) {}

const errors = [
  PasswordChangeInvalidProblemSchema,
  PasswordChangeCurrentInvalidProblemSchema,
  PasswordChangeAuthenticationProblemSchema,
  PasswordChangeForbiddenProblemSchema,
  PasswordChangeRateLimitedProblemSchema,
  PasswordChangeUnavailableProblemSchema,
] as const;

const change = HttpApiGroup.make('customerOwnPasswordChange')
  .add(
    HttpApiEndpoint.post('execute', '/api/portal-auth/change-password', {
      error: errors,
      payload: UpdateCustomerPasswordSchema,
      success: CustomerPasswordChangedSchema,
    }),
  )
  .middleware(CustomerOwnPasswordChangeSchemaError);

export type CustomerOwnPasswordChangeGroup = HttpApiGroup.HttpApiGroup<
  'customerOwnPasswordChange',
  HttpApiGroup.Endpoints<typeof change>
>;

const declaredChange: CustomerOwnPasswordChangeGroup = change;

export const CustomerOwnPasswordChangeApi = HttpApi.make('CustomerOwnPasswordChangeApi')
  .add(declaredChange)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });
