import { Data } from 'effect';

/** The driver failure, when there is one, travels as the native `Error.cause` set by the constructor. */
export class CommerceMarketCatalogDatabaseConnectionError extends Data.TaggedError(
  'CommerceMarketCatalogDatabaseConnectionError',
)<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
