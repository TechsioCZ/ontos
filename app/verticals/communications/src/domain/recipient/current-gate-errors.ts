import { Data } from 'effect';

import type { UnavailableAuthority } from './recipient-assessment.ts';

/** Expected failure: a mandatory authority could not answer. It is uncertainty, never permission and never a ban. */
export class RecipientAuthorityUnavailable extends Data.TaggedError('RecipientAuthorityUnavailable')<{
  readonly authority: UnavailableAuthority;
}> {}
