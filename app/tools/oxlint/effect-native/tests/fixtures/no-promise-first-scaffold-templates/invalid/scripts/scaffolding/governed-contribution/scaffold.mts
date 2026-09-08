// expect-count: 2
/** A9/A1: every generated operation builds its own HttpApi client instead of reusing a long-lived one. */
export const renderApiClient = (name: string): string => {
	const value = `${name}Api`;
	return `import { Effect } from 'effect';
import { HttpApiClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';

export const execute${name}WithAuthorization = (
  payload: ${name}Request,
  authorization: string,
) =>
  makeEffectHttpApiClient(${value}, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders({ authorization })),
  }).pipe(Effect.flatMap((client) => client.reads.execute({ payload })));

export const load${name}Report = (payload: ${name}Request) =>
  HttpApiClient.make(${value}).pipe(Effect.flatMap((client) => client.reports.execute({ payload })));
`;
};
