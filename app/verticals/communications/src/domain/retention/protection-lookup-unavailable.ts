import { Data } from 'effect';

/** The Privacy proof store for this owner could not answer. Use of stale material is refused, because currency is unproven. */
export class ProtectionLookupUnavailable extends Data.TaggedError('ProtectionLookupUnavailable')<{
  readonly reason: 'PROTECTION_STORE_NOT_AVAILABLE';
}> {}
