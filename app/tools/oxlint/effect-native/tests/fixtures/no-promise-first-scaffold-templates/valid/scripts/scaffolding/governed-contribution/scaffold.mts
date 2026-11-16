/** A9/A1 target shape: one long-lived client built once in a Layer, injected into every operation. */
export const renderApiClient = (name: string): string => `import { Context, Effect, Layer } from 'effect';
import { HttpApiClient } from 'effect/unstable/http';
import { ${name}Api } from '../../shared/apis/${name}.ts';

export class ${name}Client extends Context.Tag('${name}Client')<${name}Client, HttpApiClient.Client<typeof ${name}Api>>() {}

export const ${name}ClientLayer = Layer.effect(${name}Client)(HttpApiClient.make(${name}Api));

export const execute${name} = (payload: ${name}Request) =>
  Effect.gen(function* () {
    const client = yield* ${name}Client;
    return yield* client.reads.execute({ payload });
  });
`;
