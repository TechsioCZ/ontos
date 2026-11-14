import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { HttpApiMiddleware } from 'effect/http-api';

export const CUSTOMER_PROFILE_STATUS = {
  authentication: 401,
  conflict: 409,
  forbidden: 403,
  invalid: 400,
  unavailable: 503,
} as const;

const contact = (maximum: number, pattern: RegExp) =>
  Schema.Trim.check(Schema.isMaxLength(maximum), Schema.isPattern(pattern));
export const CustomerOwnProfileSchema = Schema.Struct({
  contactEmail: Schema.String,
  displayName: Schema.String,
  phone: Schema.String,
  version: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type CustomerOwnProfile = typeof CustomerOwnProfileSchema.Type;

/** No Party, Tenant, contact-point reference, login email or credential can be submitted. */
export const UpdateCustomerOwnProfileSchema = Schema.Struct({
  ...CustomerOwnProfileSchema.fields,
  contactEmail: contact(320, /^(?:|[^\s@]+@[^\s@]+\.[^\s@]+)$/u),
  displayName: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  phone: contact(100, /^(?:|\+?[()0-9 .-]{3,100})$/u),
});
export type UpdateCustomerOwnProfile = typeof UpdateCustomerOwnProfileSchema.Type;

export const ProfileInvalidProblemSchema = makeProblemDetailsSchema(
  'CustomerOwnProfileInvalidProblem',
  CUSTOMER_PROFILE_STATUS.invalid,
  {
    code: Schema.Literal('invalid_request'),
  },
);
export const ProfileAuthenticationProblemSchema = makeProblemDetailsSchema(
  'CustomerOwnProfileAuthenticationProblem',
  CUSTOMER_PROFILE_STATUS.authentication,
  { code: Schema.Literal('authentication_failed') },
);
export const ProfileForbiddenProblemSchema = makeProblemDetailsSchema(
  'CustomerOwnProfileForbiddenProblem',
  CUSTOMER_PROFILE_STATUS.forbidden,
  {
    code: Schema.Literal('profile_forbidden'),
  },
);
export const ProfileConflictProblemSchema = makeProblemDetailsSchema(
  'CustomerOwnProfileConflictProblem',
  CUSTOMER_PROFILE_STATUS.conflict,
  {
    code: Schema.Literal('profile_conflict'),
  },
);
export const ProfileUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CustomerOwnProfileUnavailableProblem',
  CUSTOMER_PROFILE_STATUS.unavailable,
  { code: Schema.Literal('profile_unavailable') },
);
const errors = [
  ProfileInvalidProblemSchema,
  ProfileAuthenticationProblemSchema,
  ProfileForbiddenProblemSchema,
  ProfileConflictProblemSchema,
  ProfileUnavailableProblemSchema,
] as const;
export class CustomerOwnProfileSchemaError extends HttpApiMiddleware.Service<CustomerOwnProfileSchemaError>()(
  'commerce-customer-context/CustomerOwnProfileSchemaError',
  { error: ProfileInvalidProblemSchema },
) {}

const readGroup = HttpApiGroup.make('customerOwnProfileRead')
  .add(
    HttpApiEndpoint.get('execute', '/api/portal-auth/customer-profile', {
      error: errors,
      success: CustomerOwnProfileSchema,
    }),
  )
  .middleware(CustomerOwnProfileSchemaError);
const updateGroup = HttpApiGroup.make('customerOwnProfileUpdate')
  .add(
    HttpApiEndpoint.post('execute', '/api/portal-auth/customer-profile', {
      error: errors,
      payload: UpdateCustomerOwnProfileSchema,
      success: CustomerOwnProfileSchema,
    }),
  )
  .middleware(CustomerOwnProfileSchemaError);
export type CustomerOwnProfileReadGroup = HttpApiGroup.HttpApiGroup<
  'customerOwnProfileRead',
  HttpApiGroup.Endpoints<typeof readGroup>
>;
export type CustomerOwnProfileUpdateGroup = HttpApiGroup.HttpApiGroup<
  'customerOwnProfileUpdate',
  HttpApiGroup.Endpoints<typeof updateGroup>
>;
const declaredReadGroup: CustomerOwnProfileReadGroup = readGroup;
const declaredUpdateGroup: CustomerOwnProfileUpdateGroup = updateGroup;
export const CustomerOwnProfileReadApi = HttpApi.make('CustomerOwnProfileReadApi')
  .add(declaredReadGroup)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });
export const CustomerOwnProfileUpdateApi = HttpApi.make('CustomerOwnProfileUpdateApi')
  .add(declaredUpdateGroup)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });
