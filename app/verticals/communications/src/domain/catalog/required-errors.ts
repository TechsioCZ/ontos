import { Data } from 'effect';

import type { CommunicationPurposeKey } from './vocabulary.ts';

/** Typed failure: no approved type usable by the issuer carries the purpose, so no required communication exists. */
export class CommunicationRequirednessUnknown extends Data.TaggedError('CommunicationRequirednessUnknown')<{
  readonly purpose: CommunicationPurposeKey;
}> {}
