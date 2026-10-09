import { Schema } from 'effect';

/**
 * A deployment that named some `COMMERCE_CORE_IDENTITY_*` value but not all of them, or named one
 * this vertical cannot use. The reason is bounded operator-facing text and never carries the
 * credential or any part of it.
 */
export class CommerceCoreIdentityClientConfigError extends Schema.TaggedError<CommerceCoreIdentityClientConfigError>()(
  'CommerceCoreIdentityClientConfigError',
  {
    reason: Schema.String,
  },
) {}
