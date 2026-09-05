/**
 * A1/A9 target shape: the HttpApi client is constructed once, at Layer scope, from an injected
 * HttpClient. An adjacent arrow helper on the line above, and the idiomatic `Effect.gen(function* ...)`
 * Layer body, are not per-call construction — neither must report.
 */
export const renderClientLayer = (name: string): string => `import { Context, Effect, Layer } from 'effect';
import { HttpApiClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';

export class ${name}Client extends Context.Tag('${name}Client')<${name}Client, HttpApiClient.Client<typeof ${name}Api>>() {}

const transformClient = HttpClient.mapRequest((request) => HttpClientRequest.setHeader(request, 'x-tenant', tenant));
export const ${name}ClientLayer = Layer.effect(${name}Client)(HttpApiClient.make(${name}Api, { transformClient }));

export const ${name}ScopedClientLayer = Layer.effect(${name}Client)(
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(${name}Api);
    return client;
  }),
);
`;
