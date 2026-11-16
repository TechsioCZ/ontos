import { Effect } from 'effect';
import { HttpEffect, HttpRouter, HttpServerResponse } from 'effect/http';

/**
 * No response the Shell sends carries `server-timing`: not a module owner's phases and counts (gate, SpiceDB, SQL),
 * whether from an owner it called or from a Core Action it ran in-process, and not the Shell's own gateway phases.
 * They time authorization and storage per request, a side channel no browser, storefront or MCP client needs; the
 * numbers go to the Shell's log. The hook is registered when the request's own handling ends, so it runs after every
 * hook that request added, on success and on failure alike.
 */
const removeServerTiming = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.removeHeader(response, 'server-timing')),
);

/** One request's handling, answered without `server-timing` whatever it added. */
export const withoutServerTiming = <A, E, R>(httpEffect: Effect.Effect<A, E, R>) =>
  httpEffect.pipe(Effect.onExit(() => removeServerTiming));

/** Every route of the Shell, its HTTP API and its own routes alike. */
export const NoServerTimingLive = HttpRouter.middleware(withoutServerTiming, { global: true });
