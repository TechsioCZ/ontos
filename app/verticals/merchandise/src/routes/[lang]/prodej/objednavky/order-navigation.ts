import type { Cause } from 'effect';
import { Match } from 'effect';

/** Message key of a failed open of an order page. A timeout reads differently from any other failure. */
export const orderNavigationFailureKey = Match.type<Cause.TimeoutError | Cause.UnknownError>().pipe(
  Match.tag('TimeoutError', () => 'detail.navigationTimeout'),
  Match.tag('UnknownError', () => 'detail.navigationFailed'),
  Match.exhaustive,
);
