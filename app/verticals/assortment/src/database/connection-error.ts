import { Data } from 'effect';

export class AssortmentDatabaseConnectionError extends Data.TaggedError('AssortmentDatabaseConnectionError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
