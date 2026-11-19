import type { AntiResurrectionAttempt } from '@app/privacy/domain/anti-resurrection';
import { Data } from 'effect';

/** The guard refused. `blockedResourceRefs` names exactly what may not be re-exposed; nothing was changed. */
export class ResurrectionBlocked extends Data.TaggedError('ResurrectionBlocked')<{
  readonly blockedResourceRefs: readonly string[];
  readonly matchedProtectionIds: readonly string[];
  readonly operation: AntiResurrectionAttempt['operation'];
  readonly unaffectedResourceRefs: readonly string[];
}> {}
