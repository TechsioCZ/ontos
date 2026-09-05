// expect-count: 2
/**
 * A9/A1 evasion: every generated operation still builds its own HttpApi client, but a blank line
 * inside the emitted function body resets the rule's `sinceBlankLine` window, so the `=>`/`function`
 * context test sees only `  const client = ` and the per-call construction escapes.
 */
export const renderApiClient = (name: string): string => `import { Effect } from 'effect';
import { HttpApiClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';

export function execute${name}(payload: ${name}Request, authorization: string) {
  const transform = HttpClient.mapRequest(HttpClientRequest.setHeaders({ authorization }));

  const client = makeEffectHttpApiClient(${name}Api, { transformClient: transform });
  return Effect.flatMap(client, (resolved) => resolved.reads.execute({ payload }));
}

export function load${name}Report(payload: ${name}Request) {
  const options = { label: 'report' };

  const client = HttpApiClient.make(${name}Api);
  return Effect.flatMap(client, (resolved) => resolved.reports.execute({ payload, options }));
}
`;
