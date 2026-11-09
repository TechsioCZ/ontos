import { readFileSync } from 'node:fs';
import nodePath from 'node:path';

import { describe } from 'effect-rstest';

import { appRoot, collectCases, effectNativeRule, fixtureOptions, virtualFile, withOptions } from './rule-tester.mts';

const cryptoProvision = 'Effect.provideService(Crypto.Crypto, crypto)';
const rootLayerField = 'layer: Layer.mergeAll';
const ruleName = 'no-effect-provide-in-library';
const filename = virtualFile('verticals/fixture/src/worker-host/entry.ts');
const source = `import { Crypto, Effect } from 'effect';
import { Layer } from 'effect';
import { HttpClient } from 'effect/http';
import { defineOutboxWorkerEntry } from '@app/core-runtime/outbox/worker';
import { Gateway, makeOperations } from '../services/gateway.ts';
const gatewayLayer = Layer.effect(Gateway, Effect.gen(function* bindRootTransport() {
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const operations = yield* makeOperations();
  return Gateway.of({ execute: () => operations.execute().pipe(
    Effect.provideService(Crypto.Crypto, crypto),
    Effect.provideService(HttpClient.HttpClient, httpClient),
  ) });
}));
export const entry = defineOutboxWorkerEntry({ layer: Layer.mergeAll(Base).pipe(Layer.provideMerge(gatewayLayer)) });
`;

describe('binds captured services only in a genuine registered worker Layer composition', () => {
  const { accept, register, reject } = collectCases(effectNativeRule(ruleName), `effect-native/${ruleName}`, {
    ...withOptions(fixtureOptions(ruleName)),
  });
  const at = { filename };
  accept(source, at);
  accept(source.replaceAll('Layer', 'Layers').replace('import { Layers }', 'import { Layer as Layers }'), at);
  accept(readFileSync(nodePath.join(appRoot, 'verticals/symmy-integration/src/worker-host/entry.ts'), 'utf-8'), at);
  reject(2, source.replace("'@app/core-runtime/outbox/worker'", "'./fake-worker.ts'"), at);
  reject(2, source.replace("import { Layer } from 'effect';", "import { Layer } from 'foreign-effect';"), at);
  reject(2, source.replace('export const entry', 'const entry'), at);
  reject(2, source.replace('Layer.provideMerge(gatewayLayer)', 'Layer.provideMerge(Base)'), at);
  reject(2, `${source}\nexport { gatewayLayer };`, at);
  reject(2, `${source}\nconsume(gatewayLayer);`, at);
  reject(2, `${source}\ngatewayLayer.pipe = replacement;`, at);
  reject(2, source.replace('Layer.provideMerge(gatewayLayer)', 'unknownComposition(gatewayLayer)'), at);
  reject(1, source.replace('const crypto = yield* Crypto.Crypto', 'let crypto = yield* Crypto.Crypto'), at);
  reject(1, source.replace('const crypto = yield* Crypto.Crypto', 'const crypto = makeCrypto()'), at);
  reject(1, source.replace(cryptoProvision, 'Effect.provideService(Crypto.Crypto, {})'), at);
  reject(1, source.replace(cryptoProvision, 'Effect.provideService(Crypto.Crypto, httpClient)'), at);
  reject(2, source.replace('const gatewayLayer', 'export const gatewayLayer'), at);
  reject(2, source.replace('const gatewayLayer', 'let gatewayLayer'), at);
  reject(2, source.replace(rootLayerField, 'unmounted: Layer.mergeAll'), at);
  reject(2, source.replace(rootLayerField, '...extra, layer: Layer.mergeAll'), at);
  reject(2, source.replace(rootLayerField, 'layer: Base, layer: Layer.mergeAll'), at);
  reject(2, source.replace('Layer.effect(Gateway', 'fakeEffect(Gateway'), at);
  reject(2, source.replace('Effect.gen(function*', 'fakeGen(function*'), at);
  reject(2, source.replace('export const entry = defineOutboxWorkerEntry', 'export const entry = makeLibrary'), at);
  reject(2, `${source}\nLayer.effect = replacement;`, at);
  reject(2, `${source}\nmutateNamespace(Layer);`, at);
  reject(2, `${source}\nEffect.gen = replacement;`, at);
  reject(1, `${source}\nCrypto.Crypto = replacement;`, at);
  reject(2, `${source}\ndefineOutboxWorkerEntry = replacement;`, at);
  accept(source.replace(rootLayerField, "'layer': Layer.mergeAll"), at);
  reject(
    2,
    source.replace(
      'Layer.provideMerge(gatewayLayer)) });',
      "Layer.provideMerge(gatewayLayer)), 'layer': replacement });",
    ),
    at,
  );
  reject(2, source.replace(rootLayerField, "'layer': replacement, layer: Layer.mergeAll"), at);
  reject(2, `${source}\nconst aliasedLayer = Layer; aliasedLayer.effect = replacement;`, at);
  reject(2, `${source}\nconst { effect } = Layer; effect.mutate = replacement;`, at);
  reject(2, `${source}\nmutator.effect(Layer);`, at);
  reject(2, `${source}\nmutator.provideService(Layer);`, at);
  accept(
    source
      .replace(
        "import { Crypto, Effect } from 'effect';",
        "import { Effect } from 'effect'; import { NativeCrypto } from '../services/token.ts';",
      )
      .replaceAll('Crypto.Crypto', 'NativeCrypto'),
    at,
  );
  register();
});
