/* eslint-disable max-classes-per-file -- Authentication exposes one closed runtime failure vocabulary. */
import { Schema } from 'effect';

export class InvalidCredentialsError extends Schema.TaggedErrorClass<InvalidCredentialsError>()(
  'InvalidCredentialsError',
  {},
) {}

export class OntosIdentityForbiddenError extends Schema.TaggedErrorClass<OntosIdentityForbiddenError>()(
  'OntosIdentityForbiddenError',
  {},
) {}

export class TenantAccessForbiddenError extends Schema.TaggedErrorClass<TenantAccessForbiddenError>()(
  'TenantAccessForbiddenError',
  {},
) {}

export class AuthenticationUnavailableError extends Schema.TaggedErrorClass<AuthenticationUnavailableError>()(
  'AuthenticationUnavailableError',
  {},
) {}

export class AuthenticationInternalError extends Schema.TaggedErrorClass<AuthenticationInternalError>()(
  'AuthenticationInternalError',
  {},
) {}

export type AuthenticationRuntimeError =
  | InvalidCredentialsError
  | OntosIdentityForbiddenError
  | AuthenticationUnavailableError
  | AuthenticationInternalError;

export type SwitchTenantRuntimeError = AuthenticationRuntimeError | TenantAccessForbiddenError;
