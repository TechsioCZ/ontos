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

const AuthenticationUnavailableErrorSchema = Schema.TaggedStruct('AuthenticationUnavailableError', {});
export type AuthenticationUnavailableFailure = typeof AuthenticationUnavailableErrorSchema.Type;
export const AuthenticationUnavailableError = Schema.TaggedError<AuthenticationUnavailableFailure>()(
  'AuthenticationUnavailableError',
  {},
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
