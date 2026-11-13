import { Effect } from 'effect';

import { CustomerOwnConsentUpdateExchange } from '../consent/update-exchange.ts';
import { CustomerOwnPasswordChangeExchange } from '../password-change/change-exchange.ts';
import { CustomerOwnProfileUpdateExchange } from '../profile/update-exchange.ts';

/*
 * The one place a portal route binds its own request to the one Action it invokes: the session reference, the result
 * cell and, for a password change, the redacted passwords. Each binding wraps exactly that invocation and nothing else,
 * so a request's exchange can never reach another request's Action, and none of it enters an Action payload.
 */

export const withProfileUpdateExchange =
  (exchange: typeof CustomerOwnProfileUpdateExchange.Service) =>
  <A, E, R>(invocation: Effect.Effect<A, E, R>) =>
    invocation.pipe(Effect.provideService(CustomerOwnProfileUpdateExchange, exchange));

export const withConsentUpdateExchange =
  (exchange: typeof CustomerOwnConsentUpdateExchange.Service) =>
  <A, E, R>(invocation: Effect.Effect<A, E, R>) =>
    invocation.pipe(Effect.provideService(CustomerOwnConsentUpdateExchange, exchange));

export const withPasswordChangeExchange =
  (exchange: typeof CustomerOwnPasswordChangeExchange.Service) =>
  <A, E, R>(invocation: Effect.Effect<A, E, R>) =>
    invocation.pipe(Effect.provideService(CustomerOwnPasswordChangeExchange, exchange));
