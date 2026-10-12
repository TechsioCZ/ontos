import { Data } from 'effect';

export class TaxDatabaseConnectionError extends Data.TaggedError('TaxDatabaseConnectionError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
