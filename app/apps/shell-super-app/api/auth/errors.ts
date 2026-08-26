/* eslint-disable max-classes-per-file -- Authentication exposes one closed runtime failure vocabulary. */
import { Schema } from 'effect';

export class InvalidCredentialsError extends Schema.TaggedError<InvalidCredentialsError>()(
  'InvalidCredentialsError',
  {},
) {}

export class OntosIdentityForbiddenError extends Schema.TaggedError<OntosIdentityForbiddenError>()(
  'OntosIdentityForbiddenError',
  {},
) {}

export class TenantAccessForbiddenError extends Schema.TaggedError<TenantAccessForbiddenError>()(
  'TenantAccessForbiddenError',
  {},
) {}

export class AuthenticationUnavailableError extends Schema.TaggedError<AuthenticationUnavailableError>()(
  'AuthenticationUnavailableError',
  {},
) {}

export class AuthenticationInternalError extends Schema.TaggedError<AuthenticationInternalError>()(
  'AuthenticationInternalError',
  {},
) {}

export type AuthenticationRuntimeError =
  | InvalidCredentialsError
  | OntosIdentityForbiddenError
  | AuthenticationUnavailableError
  | AuthenticationInternalError;

export type SwitchTenantRuntimeError = AuthenticationRuntimeError | TenantAccessForbiddenError;
