/* eslint-disable max-classes-per-file -- The resolver error union is one closed failure vocabulary. */
import { Schema } from 'effect';

export class PrincipalBindingMissingError extends Schema.TaggedErrorClass<PrincipalBindingMissingError>()(
  'PrincipalBindingMissingError',
  {},
) {}

export class PrincipalBindingAmbiguousError extends Schema.TaggedErrorClass<PrincipalBindingAmbiguousError>()(
  'PrincipalBindingAmbiguousError',
  {},
) {}

export class PrincipalBindingInactiveError extends Schema.TaggedErrorClass<PrincipalBindingInactiveError>()(
  'PrincipalBindingInactiveError',
  {},
) {}

export class PrincipalInactiveError extends Schema.TaggedErrorClass<PrincipalInactiveError>()(
  'PrincipalInactiveError',
  {},
) {}

export class TenantInactiveError extends Schema.TaggedErrorClass<TenantInactiveError>()(
  'TenantInactiveError',
  {},
) {}

export class PrincipalResolverUnavailableError extends Schema.TaggedErrorClass<PrincipalResolverUnavailableError>()(
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
