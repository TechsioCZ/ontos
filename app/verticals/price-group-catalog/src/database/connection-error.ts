import { Data } from 'effect';

/** The driver failure, when there is one, travels as the native `Error.cause` set by the constructor. */
export class PriceGroupCatalogDatabaseConnectionError extends Data.TaggedError(
  'PriceGroupCatalogDatabaseConnectionError',
)<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
