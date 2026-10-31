import { Data } from 'effect';

export class LegalEntityNavigationExclusionsUnavailableError extends Data.TaggedError(
  'LegalEntityNavigationExclusionsUnavailableError',
)<{
  readonly cause?: unknown;
  readonly code: 'legal_entity_navigation_exclusions_unavailable';
  readonly reason: string;
}> {}
