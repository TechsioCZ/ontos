/* eslint-disable max-classes-per-file -- The resolver error union is one closed failure vocabulary. */
import { Schema } from 'effect';

export class PrincipalBindingMissingError extends Schema.TaggedError<PrincipalBindingMissingError>()(
  'PrincipalBindingMissingError',
  {},
) {}

export class PrincipalBindingAmbiguousError extends Schema.TaggedError<PrincipalBindingAmbiguousError>()(
  'PrincipalBindingAmbiguousError',
  {},
) {}

export class PrincipalBindingInactiveError extends Schema.TaggedError<PrincipalBindingInactiveError>()(
  'PrincipalBindingInactiveError',
  {},
) {}

export class PrincipalInactiveError extends Schema.TaggedError<PrincipalInactiveError>()(
  'PrincipalInactiveError',
  {},
) {}

export class TenantInactiveError extends Schema.TaggedError<TenantInactiveError>()(
  'TenantInactiveError',
  {},
) {}

export class PrincipalResolverUnavailableError extends Schema.TaggedError<PrincipalResolverUnavailableError>()(
  'PrincipalResolverUnavailableError',
  {
    reason: Schema.String,
  },
) {}

export type PrincipalResolutionError =
  | PrincipalBindingMissingError
  | PrincipalBindingAmbiguousError
  | PrincipalBindingInactiveError
  | PrincipalInactiveError
  | TenantInactiveError
  | PrincipalResolverUnavailableError;
