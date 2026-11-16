import { Context, Effect } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';

/*
 * A client that puts a module, workload, tenant or gateway key in a request header never follows a redirect: fetch
 * follows 307/308 by default and sends the same headers to the new location. Both rules below apply together.
 */

/** Any redirect answer is an error; nothing is sent to its `Location`. */
export const refuseRedirects = <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
  HttpClient.filterStatus(client, (status) => status < 300 || status >= 400);

/**
 * Runs a key-carrying call with fetch handing every redirect back instead of following it. `RequestInit` is the fetch
 * transport's optional setting (read when present, never required), so this adds no requirement to the call.
 */
export const withoutFollowingRedirects = <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
) =>
  effect.pipe(
    Effect.updateContext((context: Context.Context<Requirements>) =>
      Context.add(context, FetchHttpClient.RequestInit, {
        ...Context.getOrUndefined(context, FetchHttpClient.RequestInit),
        redirect: 'manual',
      }),
    ),
  );
