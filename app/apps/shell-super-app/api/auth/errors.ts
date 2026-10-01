import { Schema } from 'effect';

const InvalidCredentialsErrorSchema = Schema.TaggedStruct('InvalidCredentialsError', {});
export type InvalidCredentialsFailure = typeof InvalidCredentialsErrorSchema.Type;
export const InvalidCredentialsError = Schema.TaggedError<InvalidCredentialsFailure>()('InvalidCredentialsError', {});

const ontosIdentityForbiddenErrorFields = { cause: Schema.optionalKey(Schema.Defect()) };
const OntosIdentityForbiddenErrorSchema = Schema.TaggedStruct(
  'OntosIdentityForbiddenError',
  ontosIdentityForbiddenErrorFields,
);
export type OntosIdentityForbiddenFailure = typeof OntosIdentityForbiddenErrorSchema.Type;
export const OntosIdentityForbiddenError = Schema.TaggedError<OntosIdentityForbiddenFailure>()(
  'OntosIdentityForbiddenError',
  ontosIdentityForbiddenErrorFields,
);

const TenantAccessForbiddenErrorSchema = Schema.TaggedStruct('TenantAccessForbiddenError', {});
export type TenantAccessForbiddenFailure = typeof TenantAccessForbiddenErrorSchema.Type;
export const TenantAccessForbiddenError = Schema.TaggedError<TenantAccessForbiddenFailure>()(
  'TenantAccessForbiddenError',
  {},
);

/** Why authentication was unavailable. Only logged; the HTTP problem never carries it. */
const AuthenticationUnavailableReasonSchema = Schema.Literals([
  'auth_api_error',
  'auth_api_unavailable',
  'database_unavailable',
  'legal_entity_selection_unavailable',
  'principal_resolver_unavailable',
  'timeout',
]);
export type AuthenticationUnavailableReason = typeof AuthenticationUnavailableReasonSchema.Type;
const authenticationUnavailableErrorFields = { reason: Schema.optionalKey(AuthenticationUnavailableReasonSchema) };
const AuthenticationUnavailableErrorSchema = Schema.TaggedStruct(
  'AuthenticationUnavailableError',
  authenticationUnavailableErrorFields,
);
export type AuthenticationUnavailableFailure = typeof AuthenticationUnavailableErrorSchema.Type;
export const AuthenticationUnavailableError = Schema.TaggedError<AuthenticationUnavailableFailure>()(
  'AuthenticationUnavailableError',
  authenticationUnavailableErrorFields,
);

const AuthenticationInternalErrorSchema = Schema.TaggedStruct('AuthenticationInternalError', {});
export type AuthenticationInternalFailure = typeof AuthenticationInternalErrorSchema.Type;
export const AuthenticationInternalError = Schema.TaggedError<AuthenticationInternalFailure>()(
  'AuthenticationInternalError',
  {},
);

export type AuthenticationRuntimeError =
  | InvalidCredentialsFailure
  | OntosIdentityForbiddenFailure
  | AuthenticationUnavailableFailure
  | AuthenticationInternalFailure;

export type SwitchTenantRuntimeError = AuthenticationRuntimeError | TenantAccessForbiddenFailure;
