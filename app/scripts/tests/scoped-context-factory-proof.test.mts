import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { Clock, Crypto, Data, Effect, Logger, Path, References, Tracer } from 'effect';
import { PgClient } from '@effect/sql-pg';
import { NodeServices } from '@effect/platform-node';
import { collectDatabaseAccessRuntimeInputs } from '../check-database-access-boundaries.mts';
import { SqlClient } from 'effect/sql';
import { Reactivity } from 'effect/reactivity';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { parseSync, Visitor } from 'oxc-parser';
import type { Expression } from 'oxc-parser';
import { makeScopedContextFactoryResolver } from '../scoped-context-factory-proof.mts';
import { describeNativeSqlDatabase } from '../native-sql-success-proof.mts';
import type { NativeSqlProofEnvironment } from '../native-sql-success-proof.mts';
import type { PgDecoderImportEdge } from '../pg-decoder-custody-proof.mts';

const root = '/context-factory';
const owner = `${root}/verticals/owner`;
const tagFile = `${owner}/shared/port.ts`;
const producerFile = `${owner}/src/producer.ts`;
const consumerFile = `${owner}/src/consumer.ts`;
const rootFile = `${owner}/api/index.ts`;
const tagSource = `import { Context } from 'effect'; export class Factory extends Context.Service<Factory,{readonly make:(input:{transaction:unknown})=>unknown}>()('@app/owner/Factory') {}`;
const producerSource = `import { Effect, Layer } from 'effect'; import { Factory } from '../shared/port.ts'; export const provider=Layer.effect(Factory,Effect.gen(function*(){return Object.freeze({make:(input)=>({run:()=>input.transaction.invoke()})});}));`;
const consumerSource = `import { Effect } from 'effect'; import { Factory } from '../shared/port.ts'; export const use=Effect.fn('use')(function*(transaction){const factory=yield* Factory;return factory.make({transaction});});`;
const effectFixtureImport = 'import { Effect }';
const provideProvider = 'Layer.provide(provider)';
const layerEmpty = 'Layer.empty';
const factoryInvocation = 'factory.make({transaction})';
const rootSource = `import { Layer } from 'effect';import {makeActionRuntimeLive} from '@app/core-runtime';import {assembleEffectBffRuntime} from '@modern-js/bff-effect/assembly';import {provider} from '../src/producer.ts';export default assembleEffectBffRuntime({api,handlers:makeActionRuntimeLive(unit,registration).pipe(Layer.provide(provider))});`;
const sources = () =>
  new Map([
    [tagFile, tagSource],
    [producerFile, producerSource],
    [consumerFile, consumerSource],
    [rootFile, rootSource],
  ]);
const callee = (source: string, method = 'make'): Expression | undefined => {
  const { program } = parseSync(consumerFile, source);
  let found: Expression | undefined;
  new Visitor({
    CallExpression(node) {
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' &&
        ['factory', 'bound', 'currentness'].includes(node.callee.object.name) &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === method
      ) {
        found ??= node.callee;
      }
    },
  }).visit(program);

  return found;
};
const resolve = (snapshot: ReadonlyMap<string, string>, method = 'make') =>
  Effect.gen(function* fixtureResolution() {
    const path = yield* Path.Path;
    const call = callee(snapshot.get(consumerFile) ?? '', method);
    return call === undefined
      ? undefined
      : makeScopedContextFactoryResolver(snapshot, root, path, new Map()).resolve({
          callee: call,
          file: consumerFile,
        });
  }).pipe(Effect.provide(Path.layer));
const withResolver = <Result,>(
  snapshot: ReadonlyMap<string, string>,
  inspect: (resolver: ReturnType<typeof makeScopedContextFactoryResolver>) => Result,
) =>
  Effect.gen(function* inspectResolver() {
    const path = yield* Path.Path;
    return inspect(makeScopedContextFactoryResolver(snapshot, root, path, new Map()));
  }).pipe(Effect.provide(Path.layer));
const conditionalTagFile = `${owner}/shared/conditional-service.ts`;
const conditionalSourceBody = 'input=>Effect.succeed(true)';
const conditionalSourceLayer = `Layer.succeed(Conditional,{authorize:${conditionalSourceBody}})`;
const conditionalLocalContext = 'known local function';
const conditionalSourceRead = 'const conditional=yield*Conditional;';
const conditionalProtectedCall = 'conditional.authorize(use({}))';
const conditionalSourceCall = 'conditional.authorize(unknownInput.value)';
const conditionalConsumerSources = () => {
  const snapshot = sources();
  snapshot.set(
    conditionalTagFile,
    "import {Context} from 'effect';export class Conditional extends Context.Service<Conditional,{}>()('conditional-consumer'){}",
  );
  snapshot.set(
    rootFile,
    `import {Effect,Context} from 'effect';import {Conditional} from '../shared/conditional-service.ts';const conditionalLive=${conditionalSourceLayer};${rootSource}`,
  );
  snapshot.set(
    consumerFile,
    `${consumerSource}import {Conditional} from '../shared/conditional-service.ts';export const attempt=Effect.gen(function*(){${conditionalSourceRead}return yield*${conditionalSourceCall};});`,
  );
  return snapshot;
};
it.effect('uses a closed unmounted service body only as a consumer source, never factory authority', () =>
  resolve(conditionalConsumerSources()).pipe(Effect.map((result) => expect(result).toHaveLength(1))),
);
it.effect('follows an exact private same-owner named re-export for a consumer source', () => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(
    `${owner}/shared/conditional-facade.ts`,
    "export {Conditional as Renamed} from './conditional-service.ts';",
  );
  snapshot.set(
    consumerFile,
    (snapshot.get(consumerFile) ?? '').replace(
      "import {Conditional} from '../shared/conditional-service.ts';",
      "import {Renamed as Conditional} from '../shared/conditional-facade.ts';",
    ),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  [
    'duplicate provider',
    rootFile,
    `const conditionalLive=${conditionalSourceLayer};`,
    `const conditionalLive=${conditionalSourceLayer};const duplicate=${conditionalSourceLayer};`,
  ],
  [
    'native effect provider',
    rootFile,
    conditionalSourceLayer,
    `Layer.effect(Conditional,Effect.succeed({authorize:${conditionalSourceBody}}))`,
  ],
  [
    'same-key impostor',
    rootFile,
    `const conditionalLive=${conditionalSourceLayer};`,
    `const conditionalLive=${conditionalSourceLayer};class Impostor extends Context.Service<Impostor,{}>()('conditional-consumer'){}const impostor=Layer.succeed(Impostor,{authorize:${conditionalSourceBody}});`,
  ],
  [
    'tag escape',
    rootFile,
    `const conditionalLive=${conditionalSourceLayer};`,
    `const conditionalLive=${conditionalSourceLayer};escape(Conditional);`,
  ],
  [
    'getter source method',
    rootFile,
    conditionalSourceLayer,
    `Layer.succeed(Conditional,{get authorize(){return ${conditionalSourceBody};}})`,
  ],
  ['mutated receiver', consumerFile, conditionalSourceRead, `${conditionalSourceRead}conditional.authorize=foreign;`],
  ['escaped receiver', consumerFile, conditionalSourceRead, `${conditionalSourceRead}escape(conditional);`],
  ['spread call', consumerFile, conditionalSourceCall, 'conditional.authorize(...[unknownInput.value])'],
  ['protected direct input', rootFile, conditionalSourceBody, 'input=>Effect.runSync(input)'],
  ['protected destructured input', rootFile, conditionalSourceBody, '({request})=>Effect.runSync(request)'],
  ['protected opaque input', rootFile, conditionalSourceBody, 'input=>unknownProc(input.request)'],
  [
    'body Context replacement',
    rootFile,
    conditionalSourceBody,
    'input=>input.pipe(Effect.provideContext(unknownContext))',
  ],
])('rejects an unproved conditional consumer source: %s', ([name, file, before, after]) => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(file, (snapshot.get(file) ?? '').replace(before, after));
  if (name === 'protected direct input' || name === 'body Context replacement') {
    snapshot.set(
      consumerFile,
      (snapshot.get(consumerFile) ?? '').replace(conditionalSourceCall, conditionalProtectedCall),
    );
  }
  if (name === 'protected destructured input' || name === 'protected opaque input') {
    snapshot.set(
      consumerFile,
      (snapshot.get(consumerFile) ?? '').replace(conditionalSourceCall, 'conditional.authorize({request:use({})})'),
    );
  }
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['native body', 'return Effect.succeed(input);', true],
  ['synchronous runner', 'return Effect.runSync(input);', false],
  ['opaque execution', 'return unknownProc(input);', false],
  ['implicit arguments', 'return Effect.runSync(arguments[0]);', false],
  ['implicit receiver', 'return this.run(input);', false],
])('checks original bound data declaration body and actual input: %s', ([_mode, body, allowed]) => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(
    rootFile,
    `${(snapshot.get(rootFile) ?? '').replace(conditionalSourceBody, 'input=>bound.run(input)')}const bind=()=>{function run(input){${body}}return {run};};const bound=bind();`,
  );
  snapshot.set(
    consumerFile,
    (snapshot.get(consumerFile) ?? '').replace(conditionalSourceCall, conditionalProtectedCall),
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed === true ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect.each([conditionalLocalContext, 'service source'])(
  'checks direct body Context replacement under actual input: %s',
  (mode) => {
    const snapshot = mode === conditionalLocalContext ? sources() : conditionalConsumerSources();
    if (mode === conditionalLocalContext) {
      snapshot.set(
        consumerFile,
        `${snapshot.get(consumerFile) ?? ''}const provide=input=>Effect.provideContext(input,unknownContext);provide(use({}));`,
      );
    } else {
      snapshot.set(
        rootFile,
        (snapshot.get(rootFile) ?? '').replace(
          conditionalSourceBody,
          'input=>Effect.provideContext(input,unknownContext)',
        ),
      );
      snapshot.set(
        consumerFile,
        (snapshot.get(consumerFile) ?? '').replace(conditionalSourceCall, conditionalProtectedCall),
      );
    }
    return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
  },
);
const defaultDataParameters = 'input,options={}';
const defaultUnknownArgs = 'input,unknownInput.value';
const defaultUndefinedArgs = 'input,undefined';
const defaultAliasParameters = 'input,options=input';
const defaultProtectedParameters = 'input,options=Effect.runSync(input)';
const defaultRunBody = 'return Effect.runSync(options);';
const defaultExplicitArgs = 'input,{}';
const defaultDataBody = 'return Effect.succeed(options);';
const defaultDataSources = (parameters: string, body: string, args: string) => {
  const snapshot = conditionalConsumerSources();
  const invocation = `input=>bound.run(${args})`;
  const base = (snapshot.get(rootFile) ?? '').replace(conditionalSourceBody, invocation);
  snapshot.set(
    rootFile,
    `${base}const bind=()=>{function run(${parameters}){${body}}return {run};};const bound=bind();`,
  );
  snapshot.set(
    consumerFile,
    (snapshot.get(consumerFile) ?? '').replace(conditionalSourceCall, conditionalProtectedCall),
  );
  return snapshot;
};
it.effect.each([
  ['explicit empty options', defaultDataParameters, defaultDataBody, defaultExplicitArgs, true],
  ['omitted empty options', defaultDataParameters, defaultDataBody, 'input', true],
  ['explicit undefined options', defaultDataParameters, defaultDataBody, defaultUndefinedArgs, true],
  ['unknown actual and safe default', defaultDataParameters, defaultDataBody, defaultUnknownArgs, true],
  ['earlier formal alias', defaultAliasParameters, defaultDataBody, 'input', true],
  ['later default preserves earlier default', 'input,first={},options=first', defaultDataBody, 'input', true],
  ['unused protected initializer', defaultProtectedParameters, defaultDataBody, defaultExplicitArgs, true],
  ['taken protected initializer', defaultProtectedParameters, defaultDataBody, 'input', false],
  ['undefined takes protected initializer', defaultProtectedParameters, defaultDataBody, defaultUndefinedArgs, false],
  ['unknown may take protected initializer', defaultProtectedParameters, defaultDataBody, defaultUnknownArgs, false],
  ['earlier protected formal executed', defaultAliasParameters, defaultRunBody, 'input', false],
  ['actual overrides default', defaultDataParameters, defaultRunBody, 'input,input', false],
  [
    'earlier default capture survives later actual',
    'input,options=input,later={}',
    defaultRunBody,
    'input,undefined,{}',
    false,
  ],
  ['opaque initializer', 'input,options=opaque()', defaultDataBody, 'input', false],
  ['reassigned options', defaultDataParameters, 'options=input;return Effect.runSync(options);', 'input', false],
  ['spread initializer', 'input,options={...input}', defaultDataBody, 'input', false],
  ['rest formal', 'input,...options', defaultDataBody, defaultExplicitArgs, false],
  ['destructured default', 'input,{options}={}', defaultDataBody, 'input', false],
  ['forward default reference', 'input,options=later,later={}', defaultDataBody, 'input', false],
  ['missing required plain formal', defaultDataParameters, defaultDataBody, '', false],
  ['extra default-call argument', defaultDataParameters, defaultDataBody, 'input,{},{}', false],
  ['spread actual', defaultDataParameters, defaultDataBody, '...[input,{}]', false],
])(
  'binds private data-call defaults without inventing argument authority: %s',
  ([_name, parameters, body, args, allowed]) =>
    resolve(defaultDataSources(String(parameters), String(body), String(args))).pipe(
      Effect.map((result) => (allowed === true ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
    ),
);
it.effect.each([
  ['omitted', 'input'],
  ['explicit undefined', defaultUndefinedArgs],
])('preserves a default-returned protected Effect carrier: %s', ([_name, args]) => {
  const snapshot = defaultDataSources(defaultAliasParameters, 'return options;', args);
  snapshot.set(
    rootFile,
    (snapshot.get(rootFile) ?? '').replace(
      `bound.run(${args})`,
      `bound.run(${args}).pipe(Effect.provideContext(unknownContext))`,
    ),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
const readonlyOptionsForward = 'function forward(input,options={}){return Effect.succeed(options.environment);}';
const readonlyOptionsSources = (
  forward: string,
  invocation = 'forward(input,options)',
  consume = 'value=>Effect.succeed(true)',
) => {
  const snapshot = defaultDataSources(
    'input,options',
    `${invocation};return options.redemption.consume(input);`,
    `input,{redemption:{consume:${consume}}}`,
  );
  snapshot.set(rootFile, `${snapshot.get(rootFile) ?? ''}${forward}`);
  return snapshot;
};
it.effect.each([
  ['readonly declaration default', readonlyOptionsForward, true],
  [
    'readonly deferred forwarding',
    "function forward(input,options={}){return Effect.succeed(1).pipe(Effect.flatMap(()=>nested(input,options)));}const nested=Effect.fn('nested')(function*(input,options){return options.currentTimeSeconds ?? 1;});",
    true,
  ],
  [
    'body mutation',
    'function forward(input,options={}){options.redemption=foreign;return Effect.succeed(true);}',
    false,
  ],
  [
    'alias mutation',
    'function forward(input,options={}){const alias=options;alias.redemption=foreign;return Effect.succeed(true);}',
    false,
  ],
  [
    'implicit arguments',
    'function forward(input,options={}){arguments[1].redemption=foreign;return Effect.succeed(true);}',
    false,
  ],
  ['implicit this', 'function forward(input,options={}){this.redemption=options;return Effect.succeed(true);}', false],
  ['opaque escape', 'function forward(input,options={}){escape(options);return Effect.succeed(true);}', false],
  [
    'selected field escape',
    'function forward(input,options={}){escape(options.redemption);return Effect.succeed(true);}',
    false,
  ],
  ['whole record return', 'function forward(input,options={}){return options;}', false],
  ['array escape', 'function forward(input,options={}){escape([options]);return Effect.succeed(true);}', false],
  ['spread escape', 'function forward(input,options={}){escape({...options});return Effect.succeed(true);}', false],
  ['returned capture', 'function forward(input,options={}){return ()=>options;}', false],
  ['frozen return escape', 'function forward(input,options={}){return Object.freeze(options);}', false],
  ['frozen member escape', 'function forward(input,options={}){return Object.freeze(options).redemption;}', false],
])('proves private readonly options forwarding without service authority: %s', ([_name, forward, allowed]) =>
  resolve(readonlyOptionsSources(String(forward))).pipe(
    Effect.map((result) => (allowed === true ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  ),
);
it.effect('rejects an executed default that mutates the borrowed record', () =>
  resolve(
    readonlyOptionsSources(
      'function forward(input,options={},later=(options.redemption=foreign)){return Effect.succeed(later);}',
      'forward(input,options,undefined)',
    ),
  ).pipe(Effect.map((result) => expect(result).toBeUndefined())),
);
it.effect('keeps the consumed protected payload visible after readonly forwarding', () =>
  resolve(
    readonlyOptionsSources(readonlyOptionsForward, 'forward(input,options)', 'value=>Effect.runSync(value)'),
  ).pipe(Effect.map((result) => expect(result).toBeUndefined())),
);
const readonlyIdentifierSources = (setup = '', method = 'value=>Effect.succeed(true)') => {
  const snapshot = readonlyOptionsSources(readonlyOptionsForward);
  snapshot.set(
    rootFile,
    `${(snapshot.get(rootFile) ?? '').replace('input,{redemption:{consume:value=>Effect.succeed(true)}}', 'input,{redemption}')}const redemption={consume:${method}};${setup}`,
  );
  return snapshot;
};
it.effect('follows an original local record initializer after its readonly loan proof', () =>
  resolve(readonlyIdentifierSources()).pipe(Effect.map((result) => expect(result).toHaveLength(1))),
);
it.effect.each([
  ['method mutation', 'redemption.consume=foreign;'],
  ['opaque record escape', 'escape(redemption);'],
  ['array record escape', 'escape([redemption]);'],
  ['reflective mutation', 'Reflect.set(redemption,"consume",foreign);'],
])('rejects an unsafe original record initializer loan: %s', ([_name, setup]) =>
  resolve(readonlyIdentifierSources(setup)).pipe(Effect.map((result) => expect(result).toBeUndefined())),
);
it.effect('preserves protected method input after following an original record initializer', () =>
  resolve(readonlyIdentifierSources('', 'value=>Effect.runSync(value)')).pipe(
    Effect.map((result) => expect(result).toBeUndefined()),
  ),
);
const yieldedReadonlyRecordSources = (mutation = '', method = 'check') => {
  const snapshot = readonlyIdentifierSources();
  const program = (snapshot.get(rootFile) ?? '')
    .replace(
      'input=>bound.run(input,{redemption})',
      `input=>Effect.gen(function*(){const redemption=yield*LoanPort;const packet={redemption,check:value=>Effect.succeed(true)};${mutation}return yield*bound.run(input,packet);})`,
    )
    .replace(
      'return options.redemption.consume(input);',
      method === 'check' ? 'return options.check(input);' : 'return options.redemption.consume(input);',
    );
  snapshot.set(rootFile, `${program}class LoanPort extends Context.Service<LoanPort,{}>()('loan-port'){}`);
  return snapshot;
};
it.effect('keeps a yielded service in a readonly record beside an owned callable source', () =>
  resolve(yieldedReadonlyRecordSources()).pipe(Effect.map((result) => expect(result).toHaveLength(1))),
);
it.effect.each([
  ['owned method mutation', 'packet.check=foreign;'],
  ['record escape', 'escape(packet);'],
])('rejects mutation or escape of the yielded-service loan record: %s', ([_name, mutation]) =>
  resolve(yieldedReadonlyRecordSources(mutation)).pipe(Effect.map((result) => expect(result).toBeUndefined())),
);
it.effect('does not turn a yielded service method into an owned data method', () =>
  resolve(yieldedReadonlyRecordSources('', 'consume')).pipe(Effect.map((result) => expect(result).toBeUndefined())),
);
const configConstructor = 'ConfigProvider.fromUnknown(options.environment)';
const configProviderSources = (
  expression: string,
  parameters = defaultDataParameters,
  args = defaultExplicitArgs,
  setup = '',
) => {
  const snapshot = defaultDataSources(parameters, `return ${expression};`, args);
  snapshot.set(rootFile, `import {ConfigProvider} from 'effect';${snapshot.get(rootFile) ?? ''}${setup}`);
  return snapshot;
};
it.effect('recognizes exact native ConfigProvider construction under actual captured options', () =>
  resolve(configProviderSources(configConstructor)).pipe(Effect.map((result) => expect(result).toHaveLength(1))),
);
it.effect.each([
  ['opaque root', configConstructor, defaultUnknownArgs],
  ['retained provider forwarded', `unknownConsumer(${configConstructor})`, defaultUnknownArgs],
  [
    'retained load result',
    `(${configConstructor}).load(["entry"]).pipe(Effect.provideContext(unknownContext))`,
    defaultUnknownArgs,
  ],
])('checks ConfigProvider retained-input behavior: %s', ([name, expression, args]) =>
  resolve(configProviderSources(expression, defaultDataParameters, args)).pipe(
    Effect.map((result) => (name === 'opaque root' ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  ),
);
it.effect.each([
  ['foreign namespace', 'ForeignConfig.fromUnknown(options.environment)', ''],
  ['optional call', 'ConfigProvider.fromUnknown?.(options.environment)', ''],
  ['spread argument', 'ConfigProvider.fromUnknown(...[options.environment])', ''],
  [
    'extra getter options',
    'ConfigProvider.fromUnknown(options.environment,{get preserveEmptyStrings(){return Effect.runSync(input);}})',
    '',
  ],
  ['mutated namespace', configConstructor, 'ConfigProvider.fromUnknown=foreign;'],
  ['aliased namespace mutation', configConstructor, 'const alias=ConfigProvider;alias.fromUnknown=foreign;'],
  ['shadow namespace', configConstructor, 'const ConfigProvider=foreign;'],
  ['executed protected runner', 'ConfigProvider.fromUnknown(Effect.runSync(input))', ''],
  ['eager getter input', 'ConfigProvider.fromUnknown(({get value(){return Effect.runSync(input);}}).value)', ''],
  ['retained protected getter', 'ConfigProvider.fromUnknown({get entry(){return Effect.runSync(input);}})', ''],
  ['retained proxy', 'ConfigProvider.fromUnknown(new Proxy({}, {get(){return Effect.runSync(input);}}))', ''],
])('rejects an unproved ConfigProvider constructor use: %s', ([_name, expression, setup]) =>
  resolve(configProviderSources(expression, defaultDataParameters, defaultExplicitArgs, setup)).pipe(
    Effect.map((result) => expect(result).toBeUndefined()),
  ),
);
it.effect('preserves the existing treatment of an unrelated conditional receiver', () => {
  const snapshot = configProviderSources(
    '(flag?unknownA:unknownB).load(["entry"]).pipe(Effect.provideContext(unknownContext))',
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  [
    'stable instance alias',
    'const provider=ConfigProvider.fromUnknown(options.environment);const alias=provider;return alias.load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'captured instance alias',
    'const provider=ConfigProvider.fromUnknown(options.environment);const read=alias=>alias.load(["entry"]);return read(provider).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'returned instance alias',
    'const provider=ConfigProvider.fromUnknown(options.environment);const relay=alias=>alias;return relay(provider).load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'conditional instance origin',
    'const provider=flag?ConfigProvider.fromUnknown(options.environment):foreign;return provider.load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'logical instance origin',
    'const provider=foreign||ConfigProvider.fromUnknown(options.environment);return provider.load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'sequence instance origin',
    'const provider=(foreign,ConfigProvider.fromUnknown(options.environment));return provider.load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'unsupported captured default origin',
    'const provider=ConfigProvider.fromUnknown(options.environment);const give=(p=provider)=>p;return give().load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'captured return instance origin',
    'const provider=ConfigProvider.fromUnknown(options.environment);const give=()=>provider;return give().load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'record instance projection',
    'const holder={provider:ConfigProvider.fromUnknown(options.environment)};return holder.provider.load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'reassigned instance origin',
    'let provider=foreign;provider=ConfigProvider.fromUnknown(options.environment);return provider.load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'mutated instance',
    'const provider=ConfigProvider.fromUnknown(options.environment);provider.load=foreign;return provider.load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'escaped instance',
    'const provider=ConfigProvider.fromUnknown(options.environment);foreign(provider);return provider.load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'unknown retained method',
    'const provider=ConfigProvider.fromUnknown(options.environment);return provider.unknown().pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'mapped retained instance',
    'const provider=ConfigProvider.fromUnknown(options.environment);return provider.mapInput(unknownTransform).load(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'explicit load argument runner',
    'const provider=ConfigProvider.fromUnknown(options.environment);return provider.load(Effect.runSync(input));',
  ],
  [
    'optional load',
    'const provider=ConfigProvider.fromUnknown(options.environment);return provider.load?.(["entry"]).pipe(Effect.provideContext(unknownContext));',
  ],
  [
    'spread load',
    'const provider=ConfigProvider.fromUnknown(options.environment);return provider.load(...paths).pipe(Effect.provideContext(unknownContext));',
  ],
])('preserves ConfigProvider retained-root provenance: %s', ([_name, body]) => {
  const snapshot = defaultDataSources(defaultDataParameters, body, defaultUnknownArgs);
  snapshot.set(rootFile, `import {ConfigProvider} from 'effect';${snapshot.get(rootFile) ?? ''}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('preserves protected input captured by a bound data factory before an empty-argument method call', () => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(
    rootFile,
    `${(snapshot.get(rootFile) ?? '').replace(conditionalSourceBody, 'input=>{const bound=bind(input);return bound.run();}')}const bind=captured=>({run:()=>Effect.runSync(captured)});`,
  );
  snapshot.set(
    consumerFile,
    (snapshot.get(consumerFile) ?? '').replace(conditionalSourceCall, conditionalProtectedCall),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  'function(input){const captured=arguments[0];return {run:()=>Effect.runSync(captured)};}',
  'function(input){const captured=arguments;return {run:()=>Effect.runSync(...captured)};}',
  'captured=>({captured,run:function(){return Effect.runSync(this.captured);}})',
])('rejects implicit constructor or empty-call method capture: %s', (binder) => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(
    rootFile,
    `${(snapshot.get(rootFile) ?? '').replace(conditionalSourceBody, 'input=>{const bound=bind(input);return bound.run();}')}const bind=${binder};`,
  );
  snapshot.set(
    consumerFile,
    (snapshot.get(consumerFile) ?? '').replace(conditionalSourceCall, conditionalProtectedCall),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('invalidates a completed proof depending only on a bound data-source body after snapshot mutation', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `${snapshot.get(consumerFile) ?? ''}const bind=()=>{function run(input){return Effect.succeed(input);}return {run};};const bound=bind();bound.run(unknownInput.value);`,
  );
  return withResolver(snapshot, (resolver) => {
    const call = callee(snapshot.get(consumerFile) ?? '');
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    expect(resolver.resolve({ callee: call, file: consumerFile })).toHaveLength(1);
    snapshot.set(`${owner}/src/new-data-source.ts`, 'export const changed=true;');
    expect(resolver.resolve({ callee: call, file: consumerFile })).toBeUndefined();
  });
});
it.effect('rejects the equivalent direct local return of a protected Effect under Context replacement', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `${snapshot.get(consumerFile) ?? ''}const direct=input=>use({});direct(0).pipe(Effect.provideContext(unknownContext));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('retains preserving consumption of a pure source service result', () => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(
    consumerFile,
    (snapshot.get(consumerFile) ?? '').replace(
      conditionalSourceCall,
      'conditional.authorize(0).pipe(Effect.map(value=>value))',
    ),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect('rejects Context replacement around an unknown service method returning the protected Effect', () => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(
    rootFile,
    `${(snapshot.get(rootFile) ?? '').replace(conditionalSourceBody, 'input=>use({})')}import {use} from '../src/consumer.ts';`,
  );
  snapshot.set(
    consumerFile,
    (snapshot.get(consumerFile) ?? '').replace(
      conditionalSourceCall,
      'conditional.authorize(0).pipe(Effect.provideContext(unknownContext))',
    ),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
const conditionalUnsafeOverride = '{authorize:input=>Effect.runSync(input)}';
it.effect.each([
  ['baseline', '', true],
  ['unknown pipe', `attempt.pipe(Effect.provideService(unknownKey,${conditionalUnsafeOverride}));`, false],
  ['unknown direct', `Effect.provideService(attempt,unknownKey,${conditionalUnsafeOverride});`, false],
  ['unknown curried', `Effect.provideService(unknownKey,${conditionalUnsafeOverride})(attempt);`, false],
  [
    'unrelated unknown',
    `Effect.succeed(true).pipe(Effect.provideService(unknownKey,${conditionalUnsafeOverride}));`,
    true,
  ],
  [
    'fixed disjoint',
    `import {Context} from 'effect';class Other extends Context.Service<Other,{}>()('other'){}attempt.pipe(Effect.provideService(Other,${conditionalUnsafeOverride}));`,
    true,
  ],
])('checks consumer receiver provision with ignored protected input: %s', ([_mode, provision, allowed]) => {
  const snapshot = conditionalConsumerSources();
  const invocation = (snapshot.get(consumerFile) ?? '').replace(conditionalSourceCall, conditionalProtectedCall);
  snapshot.set(consumerFile, `${invocation}${provision}`);
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed === true ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect.each(['Context', 'unknown consumer'])(
  'checks every reaching %s replacement around the acquisition',
  (kind) => {
    const snapshot = conditionalConsumerSources();
    const transform = kind === 'Context' ? 'Effect.provideContext(unknownContext)' : 'foreignTransform';
    snapshot.set(consumerFile, `${snapshot.get(consumerFile) ?? ''}attempt.pipe(${transform});`);
    return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
  },
);
it.effect.each(['namespace', 'foreign import', 'foreign re-export'])(
  'checks candidate-only %s without activating it',
  (kind) => {
    const snapshot = conditionalConsumerSources();
    const file = kind === 'namespace' ? `${owner}/src/candidate.ts` : `${root}/verticals/other/src/candidate.ts`;
    const route =
      kind === 'namespace' ? '../shared/conditional-service.ts' : '../../owner/shared/conditional-service.ts';
    snapshot.set(
      file,
      kind === 'namespace' ? `import * as service from '${route}';` : `import {Conditional} from '${route}';`,
    );
    if (kind === 'foreign re-export') {
      snapshot.set(file, `export {Conditional} from '${route}';`);
    }
    return withResolver(snapshot, (resolver) => {
      const call = callee(snapshot.get(consumerFile) ?? '');
      expect(call === undefined ? undefined : resolver.resolve({ callee: call, file: consumerFile })).toBeUndefined();
      expect(resolver.runtimeProofModules().some((module) => module.file === file)).toBe(false);
    });
  },
);
it.effect('rejects a candidate-only star re-export of the private consumer tag', () => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(`${owner}/shared/star.ts`, "export * from './conditional-service.ts';");
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('checks custody of every yielded consumer receiver without activating candidates', () => {
  const snapshot = conditionalConsumerSources();
  const file = `${owner}/src/other-receiver.ts`;
  snapshot.set(
    file,
    "import {Effect} from 'effect';import {Conditional} from '../shared/conditional-service.ts';export const mutate=Effect.gen(function*(){const other=yield*Conditional;other.authorize=foreign;});",
  );
  return withResolver(snapshot, (resolver) => {
    const call = callee(snapshot.get(consumerFile) ?? '');
    expect(call === undefined ? undefined : resolver.resolve({ callee: call, file: consumerFile })).toBeUndefined();
    expect(resolver.runtimeProofModules().some((module) => module.file === file)).toBe(false);
  });
});
it.effect('rejects a newly added provider after a completed consumer-source proof', () => {
  const snapshot = conditionalConsumerSources();
  return withResolver(snapshot, (resolver) => {
    const call = callee(snapshot.get(consumerFile) ?? '');
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    expect(resolver.resolve({ callee: call, file: consumerFile })).toHaveLength(1);
    snapshot.set(
      `${owner}/src/late.ts`,
      "import {Layer} from 'effect';import {Conditional} from '../shared/conditional-service.ts';export const late=Layer.succeed(Conditional,{authorize:foreign});",
    );
    expect(resolver.resolve({ callee: call, file: consumerFile })).toBeUndefined();
  });
});
it.effect.each([
  "import {Service as MakeService} from 'effect/Context';class Impostor extends MakeService()('conditional-consumer'){}",
  "import * as C from 'effect/Context';class Impostor extends C.Service()('conditional-consumer'){}",
  "import * as E from 'effect';class Impostor extends E.Context.Service()('conditional-consumer'){}",
  "import * as H from 'effect/http-api';class Other extends H.HttpApiMiddleware.Service()('conditional-consumer'){}",
  "import * as E from '@modern-js/bff-effect/effect-edge';class Other extends E.Context.Service()('conditional-consumer'){}",
  "export {Context as Hidden} from '@modern-js/bff-effect/effect-edge';",
  "export * from '@modern-js/bff-effect/effect-edge';",
  "import {Context} from 'effect';class Other extends Context.Service<Other,{}>()('other'){}Other.key='conditional-consumer';",
  "export {Context as Hidden} from 'effect';",
  "import {Context} from 'effect';class Other extends Context.Service<Other,{}>()('other'){}Reflect.set(Other,'key','conditional-consumer');",
  "import {Context} from 'effect';class Other extends Context.Service<Other,{}>()('other'){}const alias=Other;Reflect.set(alias,'key','conditional-consumer');",
  "import {Context} from 'effect';class Other extends Context.Service<Other,{}>()('other'){}Object.defineProperty(Other,'key',{value:'conditional-consumer'});",
  "export * from 'effect';",
  "import {Context} from 'effect';class Other extends Context.Service<Other,{}>()('other'){static key='conditional-consumer';}",
  "import {Context} from 'effect';@mutate class Other extends Context.Service<Other,{}>()('other'){}",
  "import {Context} from 'effect';class Other extends Context.Service<Other,{}>()('other'){}const getOther=()=>Other;Reflect.set(getOther(),'key','conditional-consumer');",
  "import {Context} from 'effect';class Other extends Context.Service<Other,{}>()('other'){}const echo=tag=>tag;const alias=echo(Other);Reflect.set(alias,'key','conditional-consumer');",
])('rejects an unclosed candidate key surface: %s', (declaration) => {
  const snapshot = conditionalConsumerSources();
  const candidateFile = `${owner}/src/key-candidate.ts`;
  snapshot.set(candidateFile, declaration);
  if (declaration.includes('class Other')) {
    snapshot.set(candidateFile, `${declaration}export {Other};`);
    snapshot.set(
      consumerFile,
      `${snapshot.get(consumerFile) ?? ''}import {Other} from './key-candidate.ts';attempt.pipe(Effect.provideService(Other,{authorize:foreign}));`,
    );
  }
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects a relevant constructor star barrel without activating an unrelated mutator candidate', () => {
  const snapshot = conditionalConsumerSources();
  const otherTagFile = `${owner}/shared/other-key.ts`;
  snapshot.set(
    otherTagFile,
    "import {Context} from 'effect';export class Other extends Context.Service<Other,{}>()('other'){}",
  );
  snapshot.set(`${owner}/shared/other-star.ts`, "export * from './other-key.ts';");
  const mutationFile = `${owner}/src/other-key-mutation.ts`;
  snapshot.set(
    mutationFile,
    "import {Other} from '../shared/other-star.ts';Reflect.set(Other,'key','conditional-consumer');",
  );
  snapshot.set(
    consumerFile,
    `${snapshot.get(consumerFile) ?? ''}import {Other} from '../shared/other-star.ts';attempt.pipe(Effect.provideService(Other,{authorize:foreign}));`,
  );
  return withResolver(snapshot, (resolver) => {
    const call = callee(snapshot.get(consumerFile) ?? '');
    expect(call).toBeDefined();
    expect(call === undefined ? undefined : resolver.resolve({ callee: call, file: consumerFile })).toBeUndefined();
    expect(resolver.runtimeProofModules().some((module) => module.file === mutationFile)).toBe(false);
  });
});
it.effect('permits an irrelevant mutable constructor star barrel without activating its candidates', () => {
  const snapshot = conditionalConsumerSources();
  const otherTagFile = `${owner}/shared/irrelevant-other.ts`;
  const mutationFile = `${owner}/src/irrelevant-key-mutation.ts`;
  snapshot.set(
    otherTagFile,
    "import {Context} from 'effect';export class Other extends Context.Service<Other,{}>()('other'){}",
  );
  snapshot.set(`${owner}/shared/irrelevant-star.ts`, "export * from './irrelevant-other.ts';");
  snapshot.set(
    mutationFile,
    "import {Other} from '../shared/irrelevant-star.ts';Reflect.set(Other,'key','conditional-consumer');",
  );
  return withResolver(snapshot, (resolver) => {
    const call = callee(snapshot.get(consumerFile) ?? '');
    expect(call).toBeDefined();
    expect(call === undefined ? undefined : resolver.resolve({ callee: call, file: consumerFile })).toHaveLength(1);
    expect(
      resolver.runtimeProofModules().some((module) => module.file === mutationFile || module.file === otherTagFile),
    ).toBe(false);
  });
});
it.effect('permits an unrelated data-key write while constructor keys retain custody', () => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(`${owner}/src/key-data.ts`, "const data={key:'before'};data.key='after';");
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect('retains an unrelated runtime tag borrowed by a closed native-layer arrow', () => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(
    rootFile,
    `${snapshot.get(rootFile) ?? ''}class Other extends Context.Service<Other,{}>()('other'){}const borrowed=tag=>Layer.succeed(tag,{});const other=borrowed(Other);`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  "const getOther=()=>Other;Reflect.set(getOther(),'key','conditional-consumer');",
  "const echo=tag=>tag;const alias=echo(Other);Reflect.set(alias,'key','conditional-consumer');",
  "function helper(tag){Reflect.set(arguments[0],'key','conditional-consumer');return Layer.succeed(tag,{});}helper(Other);",
])('rejects a runtime constructor key returned through a callable: %s', (keyEscape) => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(
    rootFile,
    `${snapshot.get(rootFile) ?? ''}class Other extends Context.Service<Other,{}>()('other'){}${keyEscape}export {Other};`,
  );
  snapshot.set(
    consumerFile,
    `${snapshot.get(consumerFile) ?? ''}import {Other} from '../api/index.ts';attempt.pipe(Effect.provideService(Other,{authorize:foreign}));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
const retainedKeyFile = `${owner}/src/retained-key.ts`;
const retainedMetadataSource =
  "import {Context,Schema} from 'effect';import {HttpApiGroup,HttpApiEndpoint} from 'effect/http-api';export class Other extends Context.Service<Other,{}>()('metadata-other'){}const endpoint=HttpApiEndpoint.get('entry','/entry',{success:Schema.String});const group=HttpApiGroup.make('group').add(endpoint).middleware(Other);const [alias]=group.endpoints.entry.middlewares;Reflect.set(alias,'key','conditional-consumer');";
it.effect(
  'permits unrelated retained metadata and mutation without treating its key as disjoint provider evidence',
  () => {
    const snapshot = conditionalConsumerSources();
    snapshot.set(retainedKeyFile, retainedMetadataSource);
    return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
  },
);
it.effect.each([
  'attempt.pipe(Effect.provideService(Other,{authorize:foreign}));',
  'Effect.provideService(attempt,Other,{authorize:foreign});',
  'Effect.provideService(Other,{authorize:foreign})(attempt);',
  'attempt.pipe(Effect.provideContext(Context.make(Other,{authorize:foreign})));',
  'attempt.pipe(Effect.provideContext(Context.add(Context.empty(),Other,{authorize:foreign})));',
  'attempt.pipe(Effect.provideContext(Context.empty().pipe(Context.add(Other,{authorize:foreign}))));',
  'attempt.pipe(Effect.provideContext(Other.context({authorize:foreign})));',
  "class Container extends Context.Service<Container,{}>()('container'){}Layer.effect(Container,attempt).pipe(Layer.provide(Layer.succeed(Other,{authorize:foreign})));",
])('rejects a reaching provider whose metadata-retained key has no custody: %s', (provision) => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(retainedKeyFile, retainedMetadataSource);
  snapshot.set(
    consumerFile,
    `${snapshot.get(consumerFile) ?? ''}import {Context,Layer} from 'effect';import {Other} from './retained-key.ts';${provision}`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects an unknown provider relayed through another source-only service result', () => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(
    rootFile,
    `import {attempt} from '../src/consumer.ts';export class Executor extends Context.Service<Executor,{}>()('executor'){}const executorLive=Layer.succeed(Executor,{run:()=>attempt});${(snapshot.get(rootFile) ?? '').replace(provideProvider, 'Layer.provide(Layer.mergeAll(provider,executorLive))')}`,
  );
  snapshot.set(
    consumerFile,
    `${(snapshot.get(consumerFile) ?? '').replace(conditionalSourceCall, conditionalProtectedCall)}import {Executor} from '../api/index.ts';const relay=Effect.gen(function*(){const executor=yield*Executor;return yield*executor.run();});relay.pipe(Effect.provideService(unknownKey,{authorize:input=>Effect.runSync(input)}));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
const tagObservationFile = `${owner}/src/tag-observation.ts`;
const nativeObservationPipeline = 'Effect.exit,Effect.andThen(operation)';
const withTagObservation = (transform = nativeObservationPipeline, mutation = '') => {
  const snapshot = conditionalConsumerSources();
  snapshot.set(
    tagObservationFile,
    `import {Context,Effect} from 'effect';export class Observer extends Context.Service<Observer,(reason:string)=>unknown>()('observer'){}export const observe=operation=>Observer.pipe(Effect.flatMap(read=>Effect.suspend(()=>read('reason'))),${transform});${mutation}`,
  );
  snapshot.set(
    consumerFile,
    `${snapshot.get(consumerFile) ?? ''}import {Observer} from './tag-observation.ts';attempt.pipe(Effect.provideService(Observer,{}));`,
  );
  return snapshot;
};
it.effect('keeps native Tag key custody through exit and one-argument andThen observation', () =>
  resolve(withTagObservation()).pipe(Effect.map((result) => expect(result).toHaveLength(1))),
);
it.effect('keeps observation key custody under an exact renamed native Effect namespace', () => {
  const snapshot = withTagObservation();
  snapshot.set(
    tagObservationFile,
    (snapshot.get(tagObservationFile) ?? '')
      .replace('{Context,Effect}', '{Context,Effect as NativeEffect}')
      .replaceAll('Effect.', 'NativeEffect.'),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  ['opaque operator', 'opaque', ''],
  ['foreign operator', 'foreign.exit', ''],
  ['called exit', 'Effect.exit(operation)', ''],
  ['empty andThen', 'Effect.andThen()', ''],
  ['extra andThen argument', 'Effect.andThen(operation,second)', ''],
  ['spread andThen', 'Effect.andThen(...operations)', ''],
  ['optional andThen', 'Effect.andThen?.(operation)', ''],
  ['optional namespace', 'Effect?.exit', ''],
  ['mutated exit', nativeObservationPipeline, 'Effect.exit=opaque;'],
  ['aliased mutation', nativeObservationPipeline, 'const alias=Effect;alias.andThen=opaque;'],
  ['shadowed namespace', nativeObservationPipeline, 'const Effect=foreign;'],
  ['key mutation', nativeObservationPipeline, "Observer.key='conditional-consumer';"],
  ['tag escape', nativeObservationPipeline, 'escape(Observer);'],
])('rejects unclosed native Tag observation: %s', ([_name, transform, mutation]) =>
  resolve(withTagObservation(transform, mutation)).pipe(Effect.map((result) => expect(result).toBeUndefined())),
);
it.effect('resolves the real returned method body from the unique mounted native Context producer', () =>
  resolve(sources()).pipe(
    Effect.map((result) => {
      expect(result).toHaveLength(1);
      expect(result?.[0]?.file).toBe(producerFile);
      expect(result?.[0]?.implementation.params[0]?.type).toBe('Identifier');
      return result;
    }),
  ),
);
it.effect.each([
  ['self receiver', 'return factory.make(factory);'],
  ['mutual receivers', 'const peer=yield*Factory;factory.make(peer);return peer.make(factory);'],
])('rejects recursive service custody without overflowing: %s', ([_name, invocation]) => {
  const snapshot = sources();
  snapshot.set(consumerFile, consumerSource.replace('return factory.make({transaction});', invocation));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('keeps a later disjoint valid proof available after rejecting cyclic service custody', () =>
  Effect.gen(function* disjointCustodyProofs() {
    const cyclic = sources();
    cyclic.set(consumerFile, consumerSource.replace(factoryInvocation, 'factory.make(factory)'));
    expect(yield* resolve(cyclic)).toBeUndefined();
    const valid = yield* resolve(sources());
    expect(valid).toHaveLength(1);
    expect(valid?.[0]?.file).toBe(producerFile);
  }),
);
it.effect.each([
  ['unmounted producer', rootSource.replace(provideProvider, 'Layer.provide(other)')],
  ['hidden unused producer', rootSource.replace('makeActionRuntimeLive(unit,registration)', layerEmpty)],
  ['foreign assembler', rootSource.replace('@modern-js/bff-effect/assembly', 'foreign')],
  ['aliased mutable namespace', `${rootSource}\nconst alias=Layer;alias.provide=replacement;`],
  ['mutated native namespace', `${rootSource}\nLayer.provide=replacement;`],
])('refuses runtime %s', ([_name, source]) => {
  const snapshot = sources();
  snapshot.set(rootFile, source);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['counterfeit Context', tagSource.replace("from 'effect'", "from 'foreign'")],
  [
    'ordinary class',
    tagSource.replace(
      "extends Context.Service<Factory,{readonly make:(input:{transaction:unknown})=>unknown}>()('@app/owner/Factory')",
      '',
    ),
  ],
])('refuses tag %s', ([_name, source]) => {
  const snapshot = sources();
  snapshot.set(tagFile, source);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['custom provider', producerSource.replace('Layer.effect', 'custom.effect')],
  ['mutable provider', producerSource.replace('export const provider', 'export let provider')],
  ['mutated Layer namespace', `${producerSource}\nLayer.effect=replacement;`],
  [
    'duplicate mounted providers',
    `${producerSource}\nexport const second=Layer.effect(Factory,Effect.gen(function*(){return {make:(input)=>input};}));`,
  ],
])('refuses provider %s', ([name, source]) => {
  const snapshot = sources();
  snapshot.set(producerFile, source);
  if (name === 'duplicate mounted providers') {
    snapshot.set(
      rootFile,
      rootSource
        .replace('{provider}', '{provider,second}')
        .replace(provideProvider, 'Layer.provide(Layer.mergeAll(provider,second))'),
    );
  }
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('returns raw result bodies for the caller to reject rather than declaring a factory safe', () => {
  const snapshot = sources();
  snapshot.set(producerFile, producerSource.replace('({run:()=>input.transaction.invoke()})', 'input.transaction'));
  return resolve(snapshot).pipe(
    Effect.map((result) => {
      expect(result).toHaveLength(1);
      expect(result?.[0]?.implementation.body?.type).toBe('MemberExpression');
      return result;
    }),
  );
});

it.effect('retains the bound self object and the exact captured transaction expression', () => {
  const snapshot = sources();
  snapshot.set(
    producerFile,
    `import { Effect,Layer } from 'effect';import {Factory} from '../shared/port.ts';export const provider=Layer.effect(Factory,Effect.gen(function*(){return {make:(transaction)=>{const bound={forTransaction:()=>bound,run:()=>transaction.invoke(routine,[]),raw:transaction};return bound;}};}));`,
  );
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=Effect.fn('use')(function*(transaction){const factory=yield* Factory;const bound=factory.make(transaction);return bound.forTransaction(transaction);});`,
  );
  return resolve(snapshot, 'forTransaction').pipe(
    Effect.map((result) => {
      expect(result).toHaveLength(1);
      expect(result?.[0]?.capturedBindings.get('transaction')?.file).toBe(consumerFile);
      expect(result?.[0]?.capturedBindings.get('bound')?.expression.type).toBe('ObjectExpression');
      return result;
    }),
  );
});
it.effect('proves absence only for an exact optional call on the closed mounted service object', () => {
  const snapshot = sources();
  snapshot.set(consumerFile, consumerSource.replace(factoryInvocation, 'factory.missing?.(transaction)'));
  return resolve(snapshot, 'missing').pipe(Effect.map((result) => expect(result).toEqual([])));
});
it.effect('does not prove absence for a required missing method', () => {
  const snapshot = sources();
  snapshot.set(consumerFile, consumerSource.replace(factoryInvocation, 'factory.missing(transaction)'));
  return resolve(snapshot, 'missing').pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('follows a native Effect.all flatMap parameter rather than a structural service annotation', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';const close=(factory)=>factory.make(transaction);export const use=Effect.all({factory:Factory}).pipe(Effect.flatMap(({factory})=>close(factory)));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});

it.live('returns unknown for all three actual CCC factory queries without caller Context', () =>
  Effect.gen(function* unframedOwnerFactories() {
    const path = yield* Path.Path;
    const app = nodePath.resolve(import.meta.dirname, '../..');
    const ownerPath = nodePath.join(app, 'verticals/commerce-customer-context');
    const inputs = yield* collectDatabaseAccessRuntimeInputs(app);
    const snapshot = inputs.sources;
    const resolver = makeScopedContextFactoryResolver(
      snapshot,
      app,
      path,
      inputs.packageExports,
      inputs.conditionalPackageExports,
      inputs.contractSources,
      inputs.nativeSqlRuntimeProofEnvironment,
    );
    // Native client callbacks can inspect public HTTP metadata, including middleware tags.
    // The original file/callee requests do not establish the caller's effective Context.
    const results: ('resolved' | 'unknown')[] = [];
    for (const [relative, receiver, method] of [
      ['src/profile-service-factory.ts', 'reactivationEvaluatorFactory', 'make'],
      ['src/persistence/purchase-limit-persistence.ts', 'currentness', 'forOperation'],
      ['src/persistence/purchase-approval-currentness-persistence.ts', 'currentness', 'forTransaction'],
    ]) {
      const file = nodePath.join(ownerPath, relative ?? '');
      let actual: Expression | undefined;
      new Visitor({
        CallExpression(node) {
          if (
            node.callee.type === 'MemberExpression' &&
            node.callee.object.type === 'Identifier' &&
            node.callee.object.name === receiver &&
            node.callee.property.type === 'Identifier' &&
            node.callee.property.name === method
          ) {
            actual ??= node.callee;
          }
        },
      }).visit(parseSync(file, snapshot.get(file) ?? '').program);
      expect(actual).toBeDefined();
      if (actual === undefined) {
        return;
      }
      const started = yield* Clock.currentTimeMillis;
      const candidates = resolver.resolve({ callee: actual, file });
      const result = candidates === undefined ? 'unknown' : 'resolved';
      results.push(result);
      yield* Effect.logInfo('Actual scoped Context factory proof', {
        candidateCount: candidates?.length ?? 0,
        durationMs: (yield* Clock.currentTimeMillis) - started,
        file: relative,
        method,
        result,
      });
    }
    expect(results).toEqual(['unknown', 'unknown', 'unknown']);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect('does not infer a parameter solely from known calls when the function also escapes', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';const close=(factory)=>factory.make(transaction);export const leaked=close;export const use=Effect.all({factory:Factory}).pipe(Effect.flatMap(({factory})=>close(factory)));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['aliased service mutation', `const alias=service;alias.make=replacement;`],
  ['unknown service mutator', `mutate(service);`],
])('refuses %s inside the native producer', ([_name, mutation]) => {
  const snapshot = sources();
  snapshot.set(
    producerFile,
    `import {Effect,Layer} from 'effect';import {Factory} from '../shared/port.ts';export const provider=Layer.effect(Factory,Effect.gen(function*(){const service={make:input=>input};${mutation}return service;}));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('does not resolve a custom object solely because its method happens to be named make', () => {
  const snapshot = sources();
  snapshot.set(consumerFile, `const factory={make:transaction=>transaction};factory.make(transaction);`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('does not replace an unknown nullish receiver branch with the known native service', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    consumerSource.replace(
      'return factory.make({transaction})',
      'const selected=unknown()??factory;return selected.make({transaction})',
    ),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

const namedCall = (source: string, name: string): Expression | undefined => {
  let found: Expression | undefined;
  new Visitor({
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === name) {
        found = node.callee;
      }
    },
  }).visit(parseSync(consumerFile, source).program);
  return found;
};
it.effect('resolves immutable same-named helpers in their actual separate lexical scopes', () => {
  const source = `export const first=transaction=>{const helper=value=>value.first;return helper(transaction);};export const second=transaction=>{const helper=value=>value.second;return helper(transaction);};`;
  const snapshot = sources();
  snapshot.set(consumerFile, source);
  return withResolver(snapshot, (resolver) => {
    const call = namedCall(source, 'helper');
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    const candidate = resolver.resolveDeclaredFunction({ callee: call, file: consumerFile });
    expect(
      candidate === undefined ? undefined : source.slice(candidate.implementation.start, candidate.implementation.end),
    ).toBe('value=>value.second');
  });
});
it.effect('resolves a real imported native Effect.fn implementation and preserves its source', () => {
  const snapshot = sources();
  snapshot.set(
    producerFile,
    `import {Effect} from 'effect';export const helper=Effect.fn('helper')(function*(transaction){return transaction.invoke(routine,[]);});`,
  );
  const source = `import {helper as execute} from './producer.ts';execute(transaction);`;
  snapshot.set(consumerFile, source);
  return withResolver(snapshot, (resolver) => {
    const call = namedCall(source, 'execute');
    if (call === undefined) {
      expect(call).toBeDefined();
      return;
    }
    const result = resolver.resolveDeclaredFunction({ callee: call, file: consumerFile });
    expect(result?.file).toBe(producerFile);
    expect(result?.implementation.generator).toBe(true);
  });
});
it.effect.each(['let', 'const'])('refuses a mutable or reassigned %s helper', (kind) => {
  const source = `${kind} helper=value=>value;helper=replacement;helper(transaction);`;
  const snapshot = sources();
  snapshot.set(consumerFile, source);
  return withResolver(snapshot, (resolver) => {
    const call = namedCall(source, 'helper');
    expect(
      call === undefined ? undefined : resolver.resolveDeclaredFunction({ callee: call, file: consumerFile }),
    ).toBeUndefined();
  });
});
it.effect('reports an outer lexical parameter separately from the nested helper arguments', () => {
  const source = `const outer=transaction=>{const helper=payload=>transaction.invoke(routine,[payload]);return helper(input);};`;
  const snapshot = sources();
  snapshot.set(consumerFile, source);
  return withResolver(snapshot, (resolver) => {
    const call = namedCall(source, 'helper');
    if (call === undefined) {
      expect(call).toBeDefined();
      return;
    }
    const result = resolver.resolveDeclaredFunction({ callee: call, file: consumerFile });
    expect(result?.capturedParameters.get('transaction')?.index).toBe(0);
    expect(result?.capturedParameters.get('transaction')?.file).toBe(consumerFile);
  });
});
it.effect('materializes immutable captured aliases while preserving the native cast and parameter frame', () => {
  const source = `const outer=transaction=>{const scopedTransaction=transaction as ScopedTransactionExecutor;const alias=scopedTransaction;return alias.invoke(routine,[]);};`;
  const snapshot = sources();
  snapshot.set(consumerFile, source);
  let reference: Expression | undefined;
  new Visitor({
    MemberExpression(node) {
      if (node.object.type === 'Identifier' && node.object.name === 'alias') {
        reference = node.object;
      }
    },
  }).visit(parseSync(consumerFile, source).program);
  return withResolver(snapshot, (resolver) => {
    if (reference === undefined) {
      expect(reference).toBeDefined();
      return;
    }
    const result = resolver.resolveCapturedValue({ expression: reference, file: consumerFile });
    expect(result?.expression.type).toBe('TSAsExpression');
    expect(result?.frames.length).toBe(3);
    expect(result?.parameter?.index).toBe(0);
    expect(result?.parameter?.file).toBe(consumerFile);
  });
});
it.effect('does not materialize a captured alias whose binding is mutable', () => {
  const source = `const outer=transaction=>{let alias=transaction;return alias.invoke(routine,[]);};`;
  const snapshot = sources();
  snapshot.set(consumerFile, source);
  let reference: Expression | undefined;
  new Visitor({
    MemberExpression(node) {
      if (node.object.type === 'Identifier' && node.object.name === 'alias') {
        reference = node.object;
      }
    },
  }).visit(parseSync(consumerFile, source).program);
  return withResolver(snapshot, (resolver) =>
    expect(
      reference === undefined
        ? undefined
        : resolver.resolveCapturedValue({ expression: reference, file: consumerFile }),
    ).toBeUndefined(),
  );
});
it.effect.each([
  [
    'named function self',
    `const outer=function Effect(){const helper=Effect.fn('helper')(function*(transaction){return transaction;});return helper(input);};`,
  ],
  [
    'catch parameter',
    `try{throw failure;}catch(Effect){const helper=Effect.fn('helper')(function*(transaction){return transaction;});helper(input);}`,
  ],
  [
    'class expression self',
    `const outer=class Effect{run(){const helper=Effect.fn('helper')(function*(transaction){return transaction;});return helper(input);}};`,
  ],
  [
    'function-scoped var',
    `const outer=()=>{if(false){var Effect=counterfeit;}const helper=Effect.fn('helper')(function*(transaction){return transaction;});return helper(input);};`,
  ],
])('rejects native wrapper shadowing by %s', ([_name, body]) => {
  const source = `import {Effect} from 'effect';${body}`;
  const snapshot = sources();
  snapshot.set(consumerFile, source);
  return withResolver(snapshot, (resolver) => {
    const call = namedCall(source, 'helper');
    expect(
      call === undefined ? undefined : resolver.resolveDeclaredFunction({ callee: call, file: consumerFile }),
    ).toBeUndefined();
  });
});
it.effect.each([
  ['duplicate string method', `{make:input=>safe,'make':input=>input.transaction}`],
  ['computed method', `{make:input=>safe,[key]:input=>input.transaction}`],
  ['getter method', `{get make(){return input=>input.transaction}}`],
  ['prototype setter', `{__proto__:{make:input=>input.transaction}}`],
])('rejects %s in a mounted service object', ([_name, body]) => {
  const snapshot = sources();
  snapshot.set(
    producerFile,
    `import {Effect,Layer} from 'effect';import {Factory} from '../shared/port.ts';export const provider=Layer.effect(Factory,Effect.gen(function*(){return ${body};}));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('does not prove optional absence of an inherited Object method', () => {
  const snapshot = sources();
  snapshot.set(consumerFile, consumerSource.replace(factoryInvocation, 'factory.toString?.(transaction)'));
  return resolve(snapshot, 'toString').pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('does not omit an earlier raw-capability return branch in a native producer', () => {
  const snapshot = sources();
  snapshot.set(
    producerFile,
    producerSource.replace(
      'return Object.freeze',
      'if(condition){return {make:input=>input.transaction};}return Object.freeze',
    ),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['Layer alias', `import {Layer as OtherLayer} from 'effect';OtherLayer.effect=counterfeit;`],
  ['Context alias', `import {Context as OtherContext} from 'effect';OtherContext.Service=counterfeit;`],
  ['Effect alias', `import {Effect as OtherEffect} from 'effect';OtherEffect.gen=counterfeit;`],
  ['namespace import', `import * as effect from 'effect';effect.Layer.effect=counterfeit;`],
  ['dynamic native import', `import('effect').then(module=>module.Layer.effect=counterfeit);`],
  ['native namespace reexport', `export {Layer as OtherLayer} from 'effect';`],
])('rejects a competing native identity through %s', ([_name, mutation]) => {
  const snapshot = sources();
  snapshot.set(rootFile, `${rootSource}${mutation}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('checks native import custody through an executed side-effect dependency', () => {
  const snapshot = sources();
  snapshot.set(rootFile, `${rootSource}import './native-mutation.ts';`);
  snapshot.set(`${owner}/api/native-mutation.ts`, `import {Layer as Alias} from 'effect';Alias.effect=counterfeit;`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['direct yielded service', `mutate(factory);`],
  ['nested yielded service', `mutate({factory});`],
])('rejects unknown custody of a %s before a factory call', ([_name, mutation]) => {
  const snapshot = sources();
  snapshot.set(consumerFile, consumerSource.replace('return factory.make', `${mutation}return factory.make`));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('does not call an inherited optional mutator absent', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    consumerSource.replace(factoryInvocation, `factory.__defineGetter__?.('make',()=>rawExtractor)`),
  );
  return resolve(snapshot, '__defineGetter__').pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['unknown sibling', rootSource.replace(provideProvider, 'Layer.provide(Layer.mergeAll(provider,unknownProvider))')],
  [
    'unknown later provider',
    rootSource.replace(provideProvider, 'Layer.provide(provider),Layer.provide(unknownProvider)'),
  ],
  [
    'unknown tag provider',
    rootSource.replace(provideProvider, 'Layer.provide(Layer.mergeAll(provider,Layer.succeed(unknownTag,rawService)))'),
  ],
])('rejects a competing unproved Layer through %s', ([_name, source]) => {
  const snapshot = sources();
  snapshot.set(rootFile, source);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects replacing Object.freeze through an inherited global Object mutator', () => {
  const snapshot = sources();
  snapshot.set(producerFile, `${producerSource}Object.__defineGetter__('freeze',()=>counterfeitFreeze);`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects a Context tag that overrides its native service iterator', () => {
  const snapshot = sources();
  snapshot.set(
    tagFile,
    tagSource.replace(' {}', ` {static *[Symbol.iterator](){return {make:input=>input.transaction};}}`),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['aliased specifier', `const specifier='effect';import(specifier).then(module=>module.Layer.effect=counterfeit);`],
  ['template specifier', `import(\`effect\`).then(module=>module.Layer.effect=counterfeit);`],
])('rejects a dynamic native import through %s', ([_name, mutation]) => {
  const snapshot = sources();
  snapshot.set(rootFile, `${rootSource}${mutation}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['assignment storage', `let stash;stash=factory;stash.make=raw;`],
  ['constructor consumption', `new Mutator(factory);`],
  ['tagged template consumption', `tag\`value \${factory}\`;`],
  ['class-field storage', `class Holder{field=factory;}new Holder();`],
])('rejects a yielded factory escape through %s', ([_name, mutation]) => {
  const snapshot = sources();
  snapshot.set(consumerFile, consumerSource.replace('return factory.make', `${mutation}return factory.make`));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('includes a foreign caller of an exported helper before inferring its Context receiver', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const close=factory=>factory.make({transaction});export const use=Effect.all({factory:Factory}).pipe(Effect.flatMap(({factory})=>close(factory)));`,
  );
  snapshot.set(
    `${root}/verticals/foreign/src/use.ts`,
    `import {close} from '../../owner/src/consumer.ts';close({make:input=>input.transaction});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('keeps an unrelated same-named browser helper outside the executed caller closure', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const resolve=value=>Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction:value});});export const use=transaction=>resolve(transaction);`,
  );
  snapshot.set(
    `${owner}/src/api/consumer-client.ts`,
    `import {Effect} from 'effect';export {Effect} from 'effect';export const resolve=value=>value;resolve('unrelated');`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect('retains the forward runtime import closure regardless of a client-like filename', () => {
  const snapshot = sources();
  snapshot.set(`${owner}/src/api/consumer-client.ts`, `import {Layer} from 'effect';Layer.effect=counterfeit;`);
  snapshot.set(rootFile, `import '../src/api/consumer-client.ts';${rootSource}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['iterator replacement', `Object.defineProperty(Factory,Symbol.iterator,{value:counterfeitIterator});`],
  ['opaque class mutation', `Object.assign(Factory,{key:'counterfeit'});`],
  ['inherited key mutator', `Factory.__defineGetter__('key',()=> 'counterfeit');`],
])('rejects a native tag after %s', ([_name, mutation]) => {
  const snapshot = sources();
  snapshot.set(tagFile, `${tagSource}${mutation}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('keeps the same tag provider proof separate for two receiving composition roots', () => {
  const snapshot = sources();
  const other = `${root}/verticals/other`;
  const otherProducer = `${other}/src/producer.ts`;
  const otherConsumer = `${other}/src/consumer.ts`;
  snapshot.set(`${other}/api/index.ts`, rootSource);
  snapshot.set(
    otherProducer,
    producerSource
      .replace("'../shared/port.ts'", "'../../owner/shared/port.ts'")
      .replace('({run:()=>input.transaction.invoke()})', 'input.transaction'),
  );
  const otherSource = consumerSource.replace("'../shared/port.ts'", "'../../owner/shared/port.ts'");
  snapshot.set(otherConsumer, otherSource);
  return withResolver(snapshot, (resolver) => {
    const first = callee(consumerSource);
    const second = callee(otherSource);
    if (first === undefined || second === undefined) {
      expect(first).toBeDefined();
      return;
    }
    expect(resolver.resolve({ callee: first, file: consumerFile })?.[0]?.file).toBe(producerFile);
    const candidate = resolver.resolve({ callee: second, file: otherConsumer })?.[0];
    expect(candidate?.file).toBe(otherProducer);
    expect(candidate?.implementation.body?.type).toBe('MemberExpression');
  });
});
it.effect('does not overwrite a nested captured layer invocation with a different wrapper input', () => {
  const snapshot = sources();
  snapshot.set(
    producerFile,
    `import {Effect,Layer} from 'effect';import {Factory} from '../shared/port.ts';const provide=service=>Layer.effect(Factory,Effect.gen(function*(){return service;}));export const wrap=service=>provide(service);`,
  );
  snapshot.set(
    rootFile,
    rootSource
      .replace('{provider}', '{wrap}')
      .replace(
        'makeActionRuntimeLive(unit,registration).pipe(Layer.provide(provider))',
        `Layer.provide(wrap({make:input=>input.transaction}),wrap({make:input=>({ok:true})}))`,
      ),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

const nativeImports = `import {Crypto,Logger,Tracer,References,Layer} from 'effect';import {PgClient} from '@effect/sql-pg';import {Reactivity} from 'effect/reactivity';import {FetchHttpClient,HttpClient} from 'effect/http';`;
const nativeFetchLayer = 'FetchHttpClient.layer';
const nativePgLayer = 'PgClient.layerFrom(acquire)';
const nativeDependencies = [
  ['Crypto tag', 'Layer.succeed(Crypto.Crypto,crypto)', Crypto.Crypto.key],
  ['PgClient tag', 'Layer.succeed(PgClient.PgClient,pg)', PgClient.PgClient.key],
  ['Reactivity layer', 'Reactivity.layer', Reactivity.Reactivity.key],
  ['FetchHttpClient layer', nativeFetchLayer, HttpClient.HttpClient.key],
  ['RequestInit tag', 'Layer.succeed(FetchHttpClient.RequestInit,{})', FetchHttpClient.RequestInit.key],
  ['PgClient layerFrom PgClient output', nativePgLayer, PgClient.PgClient.key],
  ['PgClient layerFrom SqlClient output', nativePgLayer, SqlClient.SqlClient.key],
  ['Logger layer', 'Logger.layer([logger])', Logger.CurrentLoggers.key],
  ['Tracer tag', 'Layer.succeed(Tracer.Tracer,tracer)', Tracer.Tracer.key],
  ['Tracer yieldable Effect', 'Layer.effect(Tracer.Tracer,Tracer.Tracer)', Tracer.Tracer.key],
  ['MinimumLogLevel tag', 'Layer.succeed(References.MinimumLogLevel,level)', References.MinimumLogLevel.key],
] as const;
const withNativeDependency = (dependency: string) => {
  const snapshot = sources();
  snapshot.set(
    rootFile,
    rootSource
      .replace("import { Layer } from 'effect';", nativeImports)
      .replace(provideProvider, `Layer.provide(Layer.mergeAll(provider,${dependency}))`),
  );
  return snapshot;
};
it.effect.each(nativeDependencies)('accepts the exact installed native output of %s', ([_name, dependency]) =>
  resolve(withNativeDependency(dependency)).pipe(Effect.map((result) => expect(result).toHaveLength(1))),
);
it.effect.each(nativeDependencies)('rejects a target key collision with %s', ([_name, dependency, key]) => {
  const snapshot = withNativeDependency(dependency);
  snapshot.set(tagFile, tagSource.replace('@app/owner/Factory', key));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['wrong namespace', `import {PgClient as Other} from 'foreign';`, 'Other.layerFrom(acquire)'],
  ['wrong member', '', 'PgClient.unknownLayer(acquire)'],
  ['extra argument', '', 'PgClient.layerFrom(acquire,other)'],
  ['spread acquire', '', 'PgClient.layerFrom(...acquire)'],
  ['mutated alias', `import {PgClient as Other} from '@effect/sql-pg';Other.layerFrom=foreign;`, nativePgLayer],
  [
    'inherited native tag mutation',
    `import {PgClient as P} from '@effect/sql-pg/PgClient';P.__defineGetter__('key',()=> 'owner');`,
    nativePgLayer,
  ],
  ['shadowed native namespace', 'const FetchHttpClient=foreign;', nativeFetchLayer],
  [
    'mutated Fetch cohort',
    `import {FetchHttpClient as Other} from 'effect/http';Other.layer=foreign;`,
    nativeFetchLayer,
  ],
  [
    'mutated Reactivity cohort',
    `import {Reactivity as Other} from 'effect/reactivity';Other.layer=foreign;`,
    'Reactivity.layer',
  ],
])('refuses native dependency output proof after %s', ([_name, extra, dependency]) => {
  const snapshot = withNativeDependency(dependency);
  snapshot.set(rootFile, `${snapshot.get(rootFile) ?? ''}${extra}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
const conditionalOwner = `${root}/packages/dependency`;
const conditionalTag = `${conditionalOwner}/src/tag.ts`;
const variantNode = `${conditionalOwner}/src/node.ts`;
const variantWorker = `${conditionalOwner}/src/worker.ts`;
const conditionalSnapshot = () => {
  const snapshot = sources();
  snapshot.set(
    rootFile,
    `${rootSource.replace(provideProvider, 'Layer.provide(Layer.mergeAll(provider,dependency))')}import {dependency} from '@app/dependency/platform';`,
  );
  snapshot.set(
    conditionalTag,
    `import {Context} from 'effect';export class Dependency extends Context.Service<Dependency,{}>()('dependency') {}`,
  );
  snapshot.set(
    variantNode,
    `import {Layer,Effect} from 'effect';import {Dependency} from './tag.ts';export const dependency=Layer.effect(Dependency)(Effect.succeed({}));`,
  );
  snapshot.set(
    variantWorker,
    `import {Layer} from 'effect';import {Dependency} from './tag.ts';export const dependency=Layer.succeed(Dependency,{});`,
  );
  return snapshot;
};
const resolveConditional = (
  snapshot: ReadonlyMap<string, string>,
  variants: readonly string[] = [variantNode, variantWorker],
) =>
  Effect.gen(function* conditionalFixture() {
    const path = yield* Path.Path;
    const call = callee(snapshot.get(consumerFile) ?? '');
    return call === undefined
      ? undefined
      : makeScopedContextFactoryResolver(
          snapshot,
          root,
          path,
          new Map([['@app/dependency', conditionalTag]]),
          new Map([['@app/dependency/platform', variants]]),
        ).resolve({ callee: call, file: consumerFile });
  }).pipe(Effect.provide(Path.layer));
it.effect('proves every real node/workerd conditional Layer variant with the same produced tag', () =>
  resolveConditional(conditionalSnapshot()).pipe(Effect.map((result) => expect(result).toHaveLength(1))),
);
it.effect.each([
  ['missing export', `export const other=unknown;`],
  ['unknown value', `export const dependency=unknown;`],
  ['non Layer value', `export const dependency={};`],
  [
    'fake native Layer',
    `import {Layer} from 'foreign';import {Dependency} from './tag.ts';export const dependency=Layer.succeed(Dependency,{});`,
  ],
  [
    'different output key',
    `import {Context,Layer} from 'effect';class Other extends Context.Service<Other,{}>()('other'){} export const dependency=Layer.succeed(Other,{});`,
  ],
  [
    'target key collision',
    `import {Layer} from 'effect';import {Factory} from '../../../verticals/owner/shared/port.ts';export const dependency=Layer.succeed(Factory,{});`,
  ],
])('rejects a conditional variant with %s', ([_name, source]) => {
  const snapshot = conditionalSnapshot();
  snapshot.set(variantWorker, source);
  return resolveConditional(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects a missing declared conditional variant', () =>
  resolveConditional(conditionalSnapshot(), [variantNode, `${conditionalOwner}/src/missing.ts`]).pipe(
    Effect.map((result) => expect(result).toBeUndefined()),
  ),
);
it.effect('rejects a conditional variant that escapes its actual package', () =>
  resolveConditional(conditionalSnapshot(), [variantNode, producerFile]).pipe(
    Effect.map((result) => expect(result).toBeUndefined()),
  ),
);
it.effect('proves a genuine native schema-error middleware only as its exact tag output', () => {
  const snapshot = withNativeDependency(
    `HttpApiMiddleware.layerSchemaErrorTransform(Middleware,()=>Effect.fail(ProblemSchema.make({code:'INVALID'})))`,
  );
  snapshot.set(
    rootFile,
    `${snapshot.get(rootFile) ?? ''}import {Effect} from 'effect';import {HttpApiMiddleware} from 'effect/http-api';import {ProblemSchema} from '../shared/problem.ts';class Middleware extends HttpApiMiddleware.Service<Middleware>()('middleware',{error:ProblemSchema}) {}`,
  );
  snapshot.set(
    `${owner}/shared/problem.ts`,
    `import {Schema} from 'effect';export const ProblemSchema=Schema.Struct({code:Schema.Literal('INVALID')});`,
  );
  snapshot.set(
    `${owner}/package.json`,
    '{"name":"@app/owner","type":"module","exports":{"./problem":"./shared/problem.ts"}}',
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
const callbackMemoFixture = (second: 'capture' | 'mutation') => {
  const snapshot = withNativeDependency(
    'HttpApiMiddleware.layerSchemaErrorTransform(Middleware,()=>Effect.fail(problems.invalid()))',
  );
  snapshot.set(
    rootFile,
    `${snapshot.get(rootFile) ?? ''}import {Effect} from 'effect';import {HttpApiMiddleware} from 'effect/http-api';import {ProblemSchema} from '../shared/problem.ts';import {buildInvalid} from '../shared/support.ts';const problems={invalid:buildInvalid(value=>ProblemSchema.make(value))};class Middleware extends HttpApiMiddleware.Service<Middleware>()('middleware',{error:ProblemSchema}){}`,
  );
  snapshot.set(
    `${owner}/shared/problem.ts`,
    "import {Schema} from 'effect';export const ProblemSchema=Schema.Struct({code:Schema.Literal('INVALID')});",
  );
  snapshot.set(`${owner}/shared/support.ts`, "export const buildInvalid=make=>()=>make({code:'INVALID'});");
  snapshot.set(
    `${owner}/package.json`,
    '{"name":"@app/owner","type":"module","exports":{"./problem":"./shared/problem.ts"}}',
  );
  const secondOwner = `${root}/verticals/second`;
  snapshot.set(`${secondOwner}/shared/port.ts`, "export {Factory} from '../../owner/shared/port.ts';");
  snapshot.set(`${secondOwner}/shared/problem.ts`, "export {ProblemSchema} from '../../owner/shared/problem.ts';");
  snapshot.set(`${secondOwner}/shared/support.ts`, "export {buildInvalid} from '../../owner/shared/support.ts';");
  snapshot.set(`${secondOwner}/src/producer.ts`, producerSource);
  snapshot.set(`${secondOwner}/src/consumer.ts`, consumerSource);
  const original = snapshot.get(rootFile) ?? '';
  snapshot.set(
    `${secondOwner}/api/index.ts`,
    second === 'capture'
      ? `${original.replace('buildInvalid(value=>ProblemSchema.make(value))', 'buildInvalid(value=>BadSchema.make(value))')}const BadSchema={make:unknownFactory};`
      : `${original}import '../shared/mutate.ts';`,
  );
  snapshot.set(
    `${secondOwner}/shared/mutate.ts`,
    "import {ProblemSchema} from '../../owner/shared/problem.ts';ProblemSchema.make=unknownFactory;",
  );
  snapshot.set(`${secondOwner}/package.json`, '{"name":"@app/second","type":"module"}');
  return { secondOwner, snapshot };
};
it.effect.each(['capture', 'mutation'])('does not reuse completed middleware data proof across unsafe %s', (mode) =>
  Effect.gen(function* callbackMemoResolution() {
    const { secondOwner, snapshot } = callbackMemoFixture(mode === 'capture' ? 'capture' : 'mutation');
    const path = yield* Path.Path;
    const resolver = makeScopedContextFactoryResolver(snapshot, root, path, new Map());
    const call = callee(consumerSource);
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    expect(resolver.resolve({ callee: call, file: consumerFile })).toHaveLength(1);
    expect(resolver.resolve({ callee: call, file: consumerFile })).toHaveLength(1);
    expect(resolver.resolve({ callee: call, file: `${secondOwner}/src/consumer.ts` })).toBeUndefined();
  }).pipe(Effect.provide(Path.layer)),
);
it.effect('rejects an opaque native schema-error transform body', () => {
  const snapshot = withNativeDependency('HttpApiMiddleware.layerSchemaErrorTransform(Middleware,transform)');
  snapshot.set(
    rootFile,
    `${snapshot.get(rootFile) ?? ''}import {HttpApiMiddleware} from 'effect/http-api';class Middleware extends HttpApiMiddleware.Service<Middleware>()('middleware') {}`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  [
    'foreign middleware namespace',
    `import {HttpApiMiddleware} from 'foreign';class Middleware extends HttpApiMiddleware.Service<Middleware>()('middleware') {}`,
  ],
  [
    'wrong tag constructor',
    `import {HttpApiMiddleware} from 'effect/http-api';class Middleware extends Custom.Service()('middleware') {}`,
  ],
  [
    'tag body override',
    `import {HttpApiMiddleware} from 'effect/http-api';class Middleware extends HttpApiMiddleware.Service<Middleware>()('middleware') {static key='different';}`,
  ],
  [
    'colliding tag key',
    `import {HttpApiMiddleware} from 'effect/http-api';class Middleware extends HttpApiMiddleware.Service<Middleware>()('@app/owner/Factory') {}`,
  ],
])('rejects schema-error middleware with %s', ([_name, declaration]) => {
  const snapshot = withNativeDependency('HttpApiMiddleware.layerSchemaErrorTransform(Middleware,transform)');
  snapshot.set(rootFile, `${snapshot.get(rootFile) ?? ''}${declaration}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

it.effect.each([
  ['direct Effect service override', `Effect.provideService(Factory,{make:input=>input.transaction})`],
  ['native Context service override', `Effect.provide(Context.make(Factory,{make:input=>input.transaction}))`],
  ['tag context override', `Effect.provideContext(Factory.context({make:input=>input.transaction}))`],
  [
    'unsafe native key context override',
    `Effect.provideContext(Context.makeUnsafe(new Map([[Factory.key,{make:input=>input.transaction}]])))`,
  ],
  [
    'unsafe literal key context override',
    `Effect.provideContext(Context.makeUnsafe(new Map([['@app/owner/Factory',{make:input=>input.transaction}]])))`,
  ],
])('rejects root-provider inference across a requested-tag %s', ([_name, override]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction});}).pipe(${override});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

const computedClassMutator = 'computed inherited class mutator';
it.effect.each([
  [computedClassMutator, `Factory['__defineGetter__']('key',()=>counterfeit);`],
  [
    'computed native tag mutator',
    `import {PgClient as P} from '@effect/sql-pg/PgClient';P['__defineGetter__']('key',()=>counterfeit);`,
  ],
])('rejects tagidentity through %s', ([name, mutation]) => {
  const snapshot = name === computedClassMutator ? sources() : withNativeDependency(nativePgLayer);
  snapshot.set(
    name === computedClassMutator ? tagFile : rootFile,
    `${name === computedClassMutator ? tagSource : (snapshot.get(rootFile) ?? '')}${mutation}`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
const builderImports = `import {HttpApi,HttpApiGroup,HttpApiEndpoint} from 'effect/http-api';`;
const taggedBuilder = (definition: string, mutation = '') => {
  const snapshot = sources();
  snapshot.set(
    tagFile,
    `${tagSource}${builderImports}const endpoint=HttpApiEndpoint.get('get','/get');const group=HttpApiGroup.make('group').add(endpoint);const api=HttpApi.make('api').add(group);${definition}.middleware(Factory);${mutation}`,
  );
  return snapshot;
};
it.effect.each(['endpoint', 'group', 'api', "HttpApi.make('outer').addHttpApi(api)"])(
  'accepts native immutable fluent %s only as a readonly tag consumer',
  (definition) => resolve(taggedBuilder(definition)).pipe(Effect.map((result) => expect(result).toHaveLength(1))),
);
it.effect.each([
  ['unknown endpoint', `HttpApiGroup.make('g').add(unknownEndpoint)`, ''],
  ['unknown group', `HttpApi.make('a').add(unknownGroup)`, ''],
  ['unknown api', `HttpApi.make('a').addHttpApi(unknownApi)`, ''],
  ['unknown receiver method', `group.custom()`, ''],
  ['mutated receiver', 'group', 'group.middleware=mutator;'],
  ['receiver unknown mutator', 'group', 'mutate(group);'],
  ['aliased receiver mutator', 'group', 'const alias=group;mutate(alias);'],
  ['container receiver escape', 'group', 'const holder={group};mutate(holder);'],
  ['mutated native constructor', 'group', 'HttpApiGroup.make=foreign;'],
])('rejects a readonly tag consumer with %s', ([_name, definition, mutation]) =>
  resolve(taggedBuilder(definition, mutation)).pipe(Effect.map((result) => expect(result).toBeUndefined())),
);
it.effect('rejects a counterfeit native HTTP builder import', () => {
  const snapshot = taggedBuilder('group');
  snapshot.set(tagFile, (snapshot.get(tagFile) ?? '').replace("from 'effect/http-api'", "from 'foreign'"));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

it.effect.each([
  ['nested inherited mutator', `PgClient.PgClient.__defineGetter__('key',()=>counterfeit);`],
  ['nested computed mutator', `PgClient.PgClient['__defineGetter__']('key',()=>counterfeit);`],
  ['unknown native class mutator', `Object.defineProperty(PgClient.PgClient,'key',{value:counterfeit});`],
  ['aliased native class mutator', `const P=PgClient.PgClient;Object.assign(P,{key:counterfeit});`],
])('rejects fixed native tag identity after %s', ([_name, mutation]) => {
  const snapshot = withNativeDependency(nativePgLayer);
  snapshot.set(rootFile, `${snapshot.get(rootFile) ?? ''}${mutation}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

const sdkClientReexport = '@modern-js/bff-effect/effect-client';
it.effect.each([
  'native',
  'foreign source',
  'different native source',
  'missing canonical edge',
  'mutated borrowed Effect',
])('keeps SDK Effect reexport provenance and custody: %s', (variant) =>
  Effect.gen(function* sdkReexportCustody() {
    const path = yield* Path.Path;
    const snapshot = sources();
    const barrel = `${owner}/shared/sdk.ts`;
    let source = sdkClientReexport;
    if (variant === 'foreign source') {
      source = 'foreign';
    } else if (variant === 'different native source') {
      source = 'effect';
    }
    snapshot.set(
      barrel,
      `import {Effect} from '${source}';export {Effect,runEffectRequest} from '${source}';const effect=Effect.succeed(1);`,
    );
    snapshot.set(
      consumerFile,
      consumerSource.replace(`${effectFixtureImport} from 'effect';`, "import {Effect} from '../shared/sdk.ts';"),
    );
    snapshot.set(
      producerFile,
      producerSource.replace(
        "import { Effect, Layer } from 'effect';",
        "import {Layer} from 'effect';import {Effect} from '../shared/sdk.ts';",
      ),
    );
    if (variant === 'mutated borrowed Effect') {
      snapshot.set(consumerFile, `${snapshot.get(consumerFile) ?? ''}Effect.provideContext=foreignTransform;`);
    }
    const imports = new Map<string, ReadonlyMap<string, PgDecoderImportEdge>>([
      [barrel, new Map(variant === 'missing canonical edge' ? [] : [[source, { kind: 'other-native' }]])],
      [consumerFile, new Map([['../shared/sdk.ts', { file: barrel, kind: 'module' }]])],
      [producerFile, new Map([['../shared/sdk.ts', { file: barrel, kind: 'module' }]])],
    ]);
    const call = callee(snapshot.get(consumerFile) ?? '');
    expect(call).toBeDefined();
    const result =
      call === undefined
        ? undefined
        : makeScopedContextFactoryResolver(snapshot, root, path, new Map(), new Map(), snapshot, { imports }).resolve({
            callee: call,
            file: consumerFile,
          });
    if (variant === 'native') {
      expect(result).toHaveLength(1);
    } else {
      expect(result).toBeUndefined();
    }
  }).pipe(Effect.provide(Path.layer)),
);

it.effect('accepts the installed effect-client HTTP builder reexports as readonly tag consumers', () => {
  const snapshot = taggedBuilder('group');
  snapshot.set(
    tagFile,
    (snapshot.get(tagFile) ?? '').replace("from 'effect/http-api'", "from '@modern-js/bff-effect/effect-client'"),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});

it.effect('permits native read-only Context tag lookup and Effect.as service accessor transformation', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `${consumerSource}const read=Context.get(context,Factory);const projected=Factory.pipe(Effect.flatMap(service=>service.make(input)),Effect.as('complete'));`.replace(
      effectFixtureImport,
      'import {Context,Effect}',
    ),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect('keeps an unrelated local service override separate from the requested factory', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `${consumerSource}class Other extends Context.Service<Other,{}>()('other'){}Effect.provideService(Other,{});`.replace(
      effectFixtureImport,
      'import {Context,Effect}',
    ),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});

it.effect.each([
  ['object container', `const box={tag:PgClient.PgClient};Object.defineProperty(box.tag,'key',{value:counterfeit});`],
  ['array container', `const box=[PgClient.PgClient];Object.defineProperty(box[0],'key',{value:counterfeit});`],
  [
    'wrong native tag slot',
    `class Other extends Context.Service<Other,{}>()('other'){}Layer.succeed(Other,PgClient.PgClient);`,
  ],
  ['class field storage', `class Holder{field=PgClient.PgClient;}Object.assign(new Holder().field,{key:counterfeit});`],
  ['tagged storage', `stash\`value \${PgClient.PgClient}\`;`],
])('rejects native fixed tag storage through %s', ([_name, mutation]) => {
  const snapshot = withNativeDependency(nativePgLayer);
  snapshot.set(rootFile, `${snapshot.get(rootFile) ?? ''}import {Context} from 'effect';${mutation}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

it.effect('allows a known unrelated native Context on the actual factory consumer', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';class Other extends Context.Service<Other,{}>()('other'){}export const use=transaction=>Effect.gen(function*(){const factory=yield* Factory;return factory.make({transaction});}).pipe(Effect.provideContext(Context.make(Other,{})));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});

it.effect('rejects mutation through a namespace of a barrel that reexports the native owner tag', () => {
  const snapshot = sources();
  snapshot.set(`${owner}/shared/barrel.ts`, `export {Factory} from './port.ts';`);
  snapshot.set(
    rootFile,
    `${rootSource}import * as tags from '../shared/barrel.ts';Object.defineProperty(tags.Factory,'key',{value:counterfeit});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

const snapshotConsumer = (context: string, mutation = '') =>
  `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';class Other extends Context.Service<Other,{}>()('other'){}export const use=transaction=>Effect.gen(function*(){const original=yield*Effect.context();const alias=original;${mutation}return yield*Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction});}).pipe(Effect.provideContext(${context}));});`;
it.effect.each([
  ['native snapshot', 'original'],
  ['immutable alias', 'alias'],
  ['exact unrelated add', 'Context.add(alias,Other,{})'],
])('preserves actual current Context from %s', ([_name, context]) => {
  const snapshot = sources();
  snapshot.set(consumerFile, snapshotConsumer(context));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  ['unsafe map mutation', `alias.mapUnsafe.set('@app/owner/Factory',fake);`],
  ['Reflect escape', `Reflect.get(alias,'mapUnsafe').set('@app/owner/Factory',fake);`],
  ['unknown mutation', `mutate(alias);`],
  ['container escape', `const holder={alias};mutate(holder);`],
  ['getter escape', `const getter=()=>alias;escape(getter);`],
])('rejects native snapshot custody after %s', ([_name, mutation]) => {
  const snapshot = sources();
  snapshot.set(consumerFile, snapshotConsumer('alias', mutation));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects writing the requested key into an original native snapshot', () => {
  const snapshot = sources();
  snapshot.set(consumerFile, snapshotConsumer('Context.add(alias,Factory,fake)'));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('checks local overrides that precede an actual native context snapshot', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    snapshotConsumer('alias').replace(
      /;$/u,
      `.pipe(Effect.provideContext(Context.makeUnsafe(new Map([['@app/owner/Factory',fake]]))));`,
    ),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
const innerFactoryRead = `Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction});})`;
const unsafeFactoryContext = `Context.makeUnsafe(new Map([['@app/owner/Factory',fake]]))`;
const mountedRoleMethod = 'make:(scope,execute)=>makeResolver(scope,{crypto,execute})';
const mountedRoleFactorySources = () => {
  const snapshot = sources();
  snapshot.set(
    `${owner}/shared/role.ts`,
    `import {Context} from 'effect';export class RoleFactory extends Context.Service<RoleFactory,{}>()('@app/owner/RoleFactory'){}`,
  );
  snapshot.set(
    `${owner}/src/role.ts`,
    `import {Effect,Layer} from 'effect';import {RoleFactory} from '../shared/role.ts';const makeResolver=(scope,{crypto,execute})=>Object.freeze({check:()=>Effect.succeed(crypto)});export const roleProvider=Layer.effect(RoleFactory,Effect.gen(function*(){const crypto=yield*Effect.succeed('crypto');return Object.freeze({make:(scope,execute)=>makeResolver(scope,{crypto,execute})});}));`,
  );
  snapshot.set(
    rootFile,
    `${rootSource.replace(provideProvider, 'Layer.provide(Layer.mergeAll(provider,roleProvider))')}import {roleProvider} from '../src/role.ts';`,
  );
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';import {RoleFactory} from '../shared/role.ts';export const use=Effect.fn('use')(function*(transaction,scope){const roleFactory=yield*RoleFactory;const role=roleFactory.make({operationalScope:scope,requestCorrelation:scope.correlationId});const factory=yield*Factory;return factory.make({transaction});});`,
  );
  return snapshot;
};
it.effect('follows the actual mounted role factory method body and captured dependencies', () =>
  resolve(mountedRoleFactorySources()).pipe(Effect.map((result) => expect(result).toHaveLength(1))),
);
it.effect.each([
  ['getter method', mountedRoleMethod, 'get make(){return (scope,execute)=>makeResolver(scope,{crypto,execute});}'],
  ['foreign method', mountedRoleMethod, 'make:foreign'],
  ['counterfeit provider', 'Layer.effect(RoleFactory', 'foreign.effect(RoleFactory'],
  ['counterfeit tag', `from 'effect';`, `from 'foreign';`],
])('rejects mounted role factory %s', ([name, before, after]) => {
  const snapshot = mountedRoleFactorySources();
  const file = name === 'counterfeit tag' ? `${owner}/shared/role.ts` : `${owner}/src/role.ts`;
  snapshot.set(file, (snapshot.get(file) ?? '').replace(before, after));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['replaced method', 'roleFactory.make=foreign;'],
  ['escaped method owner', 'mutate(roleFactory);'],
])('rejects mounted role factory %s', ([_name, mutation]) => {
  const snapshot = mountedRoleFactorySources();
  snapshot.set(consumerFile, (snapshot.get(consumerFile) ?? '').replace('const role=', `${mutation}const role=`));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['leading', '...[use(transaction)],0', 'input'],
  ['trailing', '0,...[use(transaction)]', 'unused'],
])('rejects a mounted role factory with an unknown %s spread argument', ([_name, argumentsSource, returned]) => {
  const snapshot = mountedRoleFactorySources();
  const file = `${owner}/src/role.ts`;
  snapshot.set(file, (snapshot.get(file) ?? '').replace(mountedRoleMethod, `make:(input,unused)=>${returned}`));
  snapshot.set(
    consumerFile,
    `${consumerSource}import {RoleFactory} from '../shared/role.ts';export const evaluate=Effect.fn(function*(transaction){const roleFactory=yield*RoleFactory;const value=roleFactory.make(${argumentsSource});return yield*foreignPipe(value);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects a locally overridden mounted role factory', () => {
  const snapshot = mountedRoleFactorySources();
  snapshot.set(
    consumerFile,
    (snapshot.get(consumerFile) ?? '').replace(/;$/u, `.pipe(Effect.provideService(RoleFactory,fake));`),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects duplicate providers for the mounted role factory', () => {
  const snapshot = mountedRoleFactorySources();
  const file = `${owner}/src/role.ts`;
  snapshot.set(
    file,
    `${snapshot.get(file) ?? ''}export const second=Layer.effect(RoleFactory,Effect.gen(function*(){return {make:scope=>scope};}));`,
  );
  snapshot.set(
    rootFile,
    (snapshot.get(rootFile) ?? '')
      .replace('{roleProvider}', '{roleProvider,second}')
      .replace('provider,roleProvider)', 'provider,roleProvider,second)'),
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  [
    'immutable extracted provider',
    `const provide=Effect.provideContext;export const use=transaction=>${innerFactoryRead}.pipe(provide(${unsafeFactoryContext}));`,
  ],
  [
    'renamed native provider',
    `const provide=Fx.provideContext;export const use=transaction=>${innerFactoryRead}.pipe(provide(${unsafeFactoryContext}));`,
  ],
  [
    'mutable extracted provider',
    `let provide=Effect.provideContext;export const use=transaction=>${innerFactoryRead}.pipe(provide(${unsafeFactoryContext}));`,
  ],
  [
    'known direct wrapper',
    `const wrap=effect=>Effect.provideContext(effect,${unsafeFactoryContext});export const use=transaction=>wrap(${innerFactoryRead});`,
  ],
  [
    'known pipe wrapper',
    `const wrap=effect=>Effect.provideContext(effect,${unsafeFactoryContext});export const use=transaction=>${innerFactoryRead}.pipe(wrap);`,
  ],
])('rejects requested context override through %s', ([_name, body]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Context,Effect,Effect as Fx} from 'effect';import {Factory} from '../shared/port.ts';${body}`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['pipe transform', `${innerFactoryRead}.pipe(unknownTransform)`],
  ['direct transform', `unknownTransform(${innerFactoryRead})`],
  ['array effect aggregate', `Effect.all([${innerFactoryRead}]).pipe(unknownTransform)`],
  ['record effect aggregate', `Effect.all({work:${innerFactoryRead}}).pipe(unknownTransform)`],
  ['foreign array borrower', `unknownTransform([${innerFactoryRead}])`],
  ['foreign record borrower', `unknownTransform({work:${innerFactoryRead}})`],
  [
    'function constructor pipeable',
    `Effect.fn('use')(function*(transaction){const factory=yield*Factory;return factory.make({transaction});},unknownTransform)(transaction)`,
  ],
  [
    'inline function transform pipeable',
    `${innerFactoryRead}.pipe(Effect.fn('wrap')(function*(effect){return yield*effect;},unknownTransform))`,
  ],
])('rejects unknown consumer Effect custody through %s', ([_name, expression]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';import {unknownTransform} from 'foreign';export const use=transaction=>${expression};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['native transform', '', `${innerFactoryRead}.pipe(Effect.orDie)`],
  ['actual local wrapper', 'const wrap=effect=>effect.pipe(Effect.map(value=>value));', `wrap(${innerFactoryRead})`],
  [
    'actual pipe wrapper',
    'const wrap=effect=>effect.pipe(Effect.map(value=>value));',
    `${innerFactoryRead}.pipe(wrap)`,
  ],
])('preserves factory context through %s', ([_name, declaration, expression]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';${declaration}export const use=transaction=>${expression};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  ['forged native operator', `import {Effect as OtherEffect} from 'foreign';`, 'OtherEffect.orDie'],
  ['mutable transform alias', 'let preserve=Effect.orDie;preserve=foreign;', 'preserve'],
  ['opaque extracted transform', 'const preserve=unknownTransform;', 'preserve'],
])('rejects consumer Effect transformation by %s', ([_name, declaration, transform]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';${declaration}export const use=transaction=>${innerFactoryRead}.pipe(${transform});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['another service class', `Effect.provideService(Other,fake)`],
  ['another tag context', `Effect.provideContext(Other.context(fake))`],
  ['another native key context', `Effect.provideContext(Context.make(Other,fake))`],
])('rejects the requested runtime key written through %s', ([_name, transform]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';class Other extends Context.Service<Other,{}>()('@app/owner/Factory'){}export const use=transaction=>${innerFactoryRead}.pipe(${transform});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  [
    'parent span writer',
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>${innerFactoryRead}.pipe(Effect.withParentSpan(fake));`,
    Tracer.ParentSpan.key,
  ],
  ['named function span', consumerSource, Tracer.ParentSpan.key],
  ['function stack frame', consumerSource, References.CurrentStackFrame.key],
])('rejects a colliding native %s', ([_name, source, key]) => {
  const snapshot = sources();
  snapshot.set(tagFile, tagSource.replace('@app/owner/Factory', key));
  snapshot.set(consumerFile, source);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
const fakeFactoryLayerApplication = 'consumer.pipe(Layer.provide(fakeFactoryLayer))';
const layerReadPrefix = `import {Context,Effect,Layer} from 'effect';import {Factory} from '../shared/port.ts';import {provider} from './producer.ts';class Other extends Context.Service<Other,{}>()('other'){}class Collision extends Context.Service<Collision,{}>()('@app/owner/Factory'){}const consumer=Layer.effect(Other,Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction});}));`;
it.effect('proves a Layer acquisition only with the same exact mounted factory provider frame', () => {
  const snapshot = sources();
  snapshot.set(consumerFile, `${layerReadPrefix}export const use=consumer.pipe(Layer.provide(provider));`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect('proves the genuine curried Layer constructor with the same mounted dependency frame', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `${layerReadPrefix.replace('Layer.effect(Other,', 'Layer.effect(Other)(')}export const use=consumer.pipe(Layer.provide(provider));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect('rejects a same-key fake dependency around a genuine curried Layer constructor', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `${layerReadPrefix.replace('Layer.effect(Other,', 'Layer.effect(Other)(')}const fakeFactoryLayer=Layer.succeed(Collision,{make:input=>input.transaction});export const use=${fakeFactoryLayerApplication};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  [
    'same tag replacement',
    `const fakeFactoryLayer=Layer.succeed(Factory,{make:input=>input.transaction});`,
    fakeFactoryLayerApplication,
  ],
  [
    'same runtime key replacement',
    `const fakeFactoryLayer=Layer.succeed(Collision,{make:input=>input.transaction});`,
    fakeFactoryLayerApplication,
  ],
  [
    'direct dependency replacement',
    `const fakeFactoryLayer=Layer.succeed(Collision,{make:input=>input.transaction});`,
    'Layer.provide(consumer,fakeFactoryLayer)',
  ],
  ['unknown dependency', '', 'consumer.pipe(Layer.provide(unknownLayer))'],
  ['mutable dependency', `let fakeFactoryLayer=provider;fakeFactoryLayer=foreign;`, fakeFactoryLayerApplication],
])('rejects a Layer-role acquisition with %s', ([_name, declaration, expression]) => {
  const snapshot = sources();
  snapshot.set(consumerFile, `${layerReadPrefix}${declaration}export const use=${expression};`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects treating an actual Effect as a Layer through a native Layer transform', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect,Layer} from 'effect';import {Factory} from '../shared/port.ts';import {provider} from './producer.ts';export const use=transaction=>${innerFactoryRead}.pipe(Layer.provide(provider));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['direct returned alias', 'unknownTransform(getConsumer())'],
  ['piped returned alias', 'getConsumer().pipe(unknownTransform)'],
  ['provided returned alias', `Effect.provideContext(getConsumer(),${unsafeFactoryContext})`],
])('rejects protected Effect transport through %s', ([_name, expression]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const getConsumer=()=>protectedEffect;return ${expression};};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['unknown borrower', 'unknownTransform(effect)'],
  ['context replacement', `Effect.provideContext(effect,${unsafeFactoryContext})`],
])('tracks the exact native fn pipeable self into %s', ([_name, expression]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';const wrap=effect=>${expression};export const use=Effect.fn(function*(transaction){const factory=yield*Factory;return factory.make({transaction});},wrap);`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('keeps a yielded plain DTO separate from the Effect that computed it', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const dto=yield*Effect.gen(function*(){const factory=yield*Factory;factory.make({transaction});return{ok:true};});return unknownData(dto);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  ['success-preserving error mapping', 'compute().pipe(Effect.mapError(error=>error))'],
  [
    'actual map result after an opaque data producer',
    'compute().pipe(Effect.flatMap(value=>opaqueDataEffect(value)),Effect.map(value=>({digest:value})),Effect.mapError(error=>error))',
  ],
])('separates computed data success from execution through %s', ([_name, producer]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const compute=()=>Effect.gen(function*(){const factory=yield*Factory;factory.make({transaction});return{ok:true};});const dto=yield*${producer};return unknownData(dto);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  'Effect.succeed(protectedEffect).pipe(Effect.mapError(error=>error))',
  'opaqueEffect(protectedEffect).pipe(Effect.map(value=>value),Effect.mapError(error=>error))',
  'Effect.succeed(0).pipe(()=>Effect.succeed(protectedEffect))',
  'Effect.succeed(0).pipe(Effect.flatMap(()=>opaqueEffect(protectedEffect)),Effect.map(value=>value))',
])('retains actual protected output origin through unresolved success transport', (producer) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const hidden=yield*${producer};return yield*hidden.pipe(unknownTransform);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  [
    'declared native generator',
    'const compute=Effect.fn(function*(value){const factory=yield*Factory;factory.make({transaction});return{ok:value};});',
    'Effect.forEach([1],value=>compute(value))',
  ],
  [
    'native generator callback',
    '',
    'Effect.forEach([1],Effect.fn(function*(value){const factory=yield*Factory;factory.make({transaction});return{ok:value};}),{concurrency:1})',
  ],
])('proves actual data successes from an effectful traversal through %s', ([_name, declaration, producer]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){${declaration}const dto=yield*${producer};return unknownData(dto);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  'Effect.forEach([1],()=>Effect.succeed(protectedEffect))',
  'Effect.forEach([1],Effect.fn(function*(){return protectedEffect;}))',
  'Effect.forEach([protectedEffect],value=>Effect.succeed(value))',
])('retains genuine nested Effect success inside an effectful traversal', (producer) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const hidden=yield*${producer};return unknownTransform(hidden);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('checks the actual traversal callback input even when its success is plain data', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};return Effect.forEach([protectedEffect],value=>{unknownTransform(value);return Effect.succeed({ok:true});});};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['ordinary function callback', '[1].map(()=>protectedEffect)'],
  ['native Effect.fn callback', '[1].map(Effect.fn(function*(){return yield*protectedEffect;}))'],
  ['native map does not flatten', 'yield*Effect.succeed(0).pipe(Effect.map(()=>protectedEffect))'],
  ['wrong traversal constructor', 'yield*foreignForEach([1],()=>protectedEffect)'],
  [
    'unproved native function output transform',
    'yield*Effect.fn(function*(){return{ok:true};},()=>Effect.succeed(protectedEffect))()',
  ],
])('does not declassify output from %s', ([_name, producer]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const hidden=${producer};return unknownTransform(hidden);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  ['unchanged captured program', 'protectedEffect', true],
  [
    'program with local authority replacement',
    'protectedEffect.pipe(Effect.provideService(Factory,{make:input=>input.transaction}))',
    false,
  ],
])('separates the success value from %s', ([_name, program, allowed]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const dto=yield*Effect.forEach([1],Effect.fn(function*(){return yield*${program};}));return unknownData(dto);});`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed === true ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect.each([
  'Effect.map(compute(1),value=>({value}))',
  'Effect.map(value=>({value}))(compute(1))',
  'Effect.as(compute(1),{ok:true})',
  'Effect.as({ok:true})(compute(1))',
  'Effect.catch(compute(1),()=>Effect.succeed({ok:true}))',
  'Effect.catch(()=>Effect.succeed({ok:true}))(compute(1))',
  'Effect.forEach(value=>compute(value))([1])',
  'Effect.provideContext(compute(1),Context.make(Other,{}))',
  'Effect.provideContext(Context.make(Other,{}))(compute(1))',
  'Effect.forEach([1],Effect.fn(function*(value){return yield*compute(value).pipe(Effect.as(value),Effect.catch(()=>Effect.succeed(value)));}))',
])('proves data through the actual SDK constructor/application level', (producer) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';class Other extends Context.Service<Other,{}>()('other'){}export const use=transaction=>Effect.gen(function*(){const compute=Effect.fn(function*(value){const factory=yield*Factory;factory.make({transaction});return{value};});const dto=yield*${producer};return unknownData(dto);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  'Effect.as(protectedEffect)',
  'Effect.map(()=>protectedEffect)',
  'Effect.catch(()=>Effect.succeed(protectedEffect))',
  'Effect.forEach(()=>Effect.succeed(protectedEffect))',
])('retains protected captures in a native pipeable closure', (producer) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const operator=${producer};return unknownTransform(operator);};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  'Effect.fail("bad").pipe(Effect.catch(()=>Effect.succeed(protectedEffect)))',
  'Effect.fail(protectedEffect).pipe(Effect.catch(error=>Effect.succeed(error)))',
  'Effect.fail("bad").pipe(unknownWrap,Effect.catch(()=>Effect.succeed(protectedEffect)))',
  'Effect.provideContext(Context.makeUnsafe(new Map([["@app/owner/Factory",{make:input=>input.transaction}]])))(protectedEffect)',
  'protectedEffect.pipe(Effect.map())',
])('rejects unsafe or unproved actual SDK application output', (producer) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const hidden=yield*${producer};return unknownTransform(hidden);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  [
    'safe then protected',
    'nested({ok:true});const result=nested(protectedEffect);return unknownTransform(result);',
    false,
  ],
  ['protected then safe', 'nested(protectedEffect);const result=nested({ok:true});return unknownData(result);', true],
])('evaluates current arguments and captures for one raw return AST: %s', ([_name, body, allowed]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const identity=value=>value;const nested=value=>identity(value);${body}};`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed === true ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect('recomputes structural caller candidates when the source corpus grows', () =>
  Effect.gen(function* callerCorpusGrowth() {
    const snapshot = sources();
    const source = `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const close=(factory,transaction)=>factory.make({transaction});export const use=transaction=>Effect.gen(function*(){const factory=yield*Factory;return close(factory,transaction);});`;
    snapshot.set(consumerFile, source);
    const path = yield* Path.Path;
    const resolver = makeScopedContextFactoryResolver(snapshot, root, path, new Map());
    const call = callee(source);
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    expect(resolver.resolve({ callee: call, file: consumerFile })).toHaveLength(1);
    snapshot.set(
      `${root}/verticals/foreign/src/caller.ts`,
      "import {close} from '../../owner/src/consumer.ts';export const unsafe=transaction=>close({make:input=>input.transaction},transaction);",
    );
    expect(resolver.resolve({ callee: call, file: consumerFile })).toBeUndefined();
  }).pipe(Effect.provide(Path.layer)),
);
it.effect.each(['direct import', 'reexport', 'unresolved import'])(
  'invalidates canonical caller identities after package metadata changes: %s',
  (kind) =>
    Effect.gen(function* canonicalPackageMetadataChange() {
      const snapshot = sources();
      const source = `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const close=(factory,transaction)=>factory.make({transaction});export const use=transaction=>Effect.gen(function*(){const factory=yield*Factory;return close(factory,transaction);});`;
      snapshot.set(consumerFile, source);
      const unrelated = `${owner}/shared/unrelated.ts`;
      snapshot.set(unrelated, 'export const close=(factory,transaction)=>({ok:true});');
      const specifier = '@app/caller-contract';
      const packageExports = new Map<string, string>();
      if (kind !== 'unresolved import') {
        packageExports.set(specifier, unrelated);
      }
      const caller = `${root}/verticals/foreign/src/caller.ts`;
      if (kind === 'reexport') {
        snapshot.set(`${owner}/shared/caller-barrel.ts`, `export {close} from '${specifier}';`);
        snapshot.set(
          caller,
          `import {close} from '../../owner/shared/caller-barrel.ts';export const unsafe=transaction=>close({make:input=>input.transaction},transaction);`,
        );
      } else {
        snapshot.set(
          caller,
          `import {close} from '${specifier}';export const unsafe=transaction=>close({make:input=>input.transaction},transaction);`,
        );
      }
      const path = yield* Path.Path;
      const resolver = makeScopedContextFactoryResolver(snapshot, root, path, packageExports);
      const call = callee(source);
      expect(call).toBeDefined();
      if (call === undefined) {
        return;
      }
      expect(resolver.resolve({ callee: call, file: consumerFile })).toHaveLength(1);
      expect(resolver.resolve({ callee: call, file: consumerFile })).toHaveLength(1);
      packageExports.set(specifier, consumerFile);
      expect(resolver.resolve({ callee: call, file: consumerFile })).toBeUndefined();
    }).pipe(Effect.provide(Path.layer)),
);
const newReexportSource = 'new reexport source';
it.effect.each([newReexportSource, 'new package mapping'])(
  'rechecks lazy canonical reexports after outer inventory growth: %s',
  (kind) =>
    Effect.gen(function* lazyCanonicalInventoryGrowth() {
      const snapshot = sources();
      const source = `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const close=(factory,transaction)=>factory.make({transaction});export const use=transaction=>Effect.gen(function*(){const factory=yield*Factory;return close(factory,transaction);});`;
      snapshot.set(consumerFile, source);
      const barrel = `${owner}/shared/late-caller-contract.ts`;
      const specifier = '@app/late-caller-contract';
      const packageExports = new Map<string, string>();
      const barrelSource = "export {close} from '../src/consumer.ts';";
      if (kind === newReexportSource) {
        packageExports.set(specifier, barrel);
      } else {
        snapshot.set(barrel, barrelSource);
      }
      snapshot.set(
        `${root}/verticals/foreign/src/caller.ts`,
        `import {close} from '${specifier}';export const unsafe=transaction=>close({make:input=>input.transaction},transaction);`,
      );
      const path = yield* Path.Path;
      const resolver = makeScopedContextFactoryResolver(snapshot, root, path, packageExports);
      const call = callee(source);
      expect(call).toBeDefined();
      if (call === undefined) {
        return;
      }
      expect(resolver.resolve({ callee: call, file: consumerFile })).toHaveLength(1);
      expect(resolver.resolve({ callee: call, file: consumerFile })).toHaveLength(1);
      if (kind === newReexportSource) {
        snapshot.set(barrel, barrelSource);
      } else {
        packageExports.set(specifier, barrel);
      }
      expect(resolver.resolve({ callee: call, file: consumerFile })).toBeUndefined();
    }).pipe(Effect.provide(Path.layer)),
);
it.effect('keeps same-named helper reference custody independent across actual Programs', () =>
  Effect.gen(function* helperReferenceIdentity() {
    const prefix = `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';const close=(factory,transaction)=>factory.make({transaction});`;
    const use = `export const use=transaction=>Effect.gen(function*(){const factory=yield*Factory;return close(factory,transaction);});`;
    const safe = sources();
    safe.set(consumerFile, `${prefix}${use}`);
    const unsafe = sources();
    unsafe.set(consumerFile, `${prefix}unknownRetain(close);${use}`);
    expect(yield* resolve(safe)).toHaveLength(1);
    expect(yield* resolve(unsafe)).toBeUndefined();
    expect(yield* resolve(safe)).toHaveLength(1);
  }),
);
const absentHelperInvocation = "failure('reason')";
it.effect.each([
  [
    'optional missing cause',
    'const failure=(reason,cause?:unknown)=>createFailure({reason},cause);',
    absentHelperInvocation,
    true,
  ],
  [
    'required missing cause',
    'const failure=(reason,cause)=>createFailure({reason},cause);',
    absentHelperInvocation,
    true,
  ],
  [
    'provided protected cause',
    'const failure=(reason,cause?:unknown)=>createFailure({reason},cause);',
    "failure('reason',protectedEffect)",
    false,
  ],
  [
    'protected default cause',
    'const failure=(reason,cause=protectedEffect)=>createFailure({reason},cause);',
    absentHelperInvocation,
    false,
  ],
  [
    'earlier data argument default',
    'const failure=(initial,cause=initial)=>createFailure({},cause);',
    'failure({ok:true})',
    true,
  ],
  [
    'earlier protected argument default',
    'const failure=(initial,cause=initial)=>createFailure({},cause);',
    'failure(protectedEffect)',
    false,
  ],
  [
    'unmodeled missing destructure',
    'const failure=({cause}={cause:protectedEffect})=>createFailure({},cause);',
    'failure()',
    false,
  ],
  ['unmodeled missing rest', 'const failure=(...causes)=>createFailure({},causes);', 'failure()', false],
])('binds an absent ordinary error-helper formal correctly: %s', ([_name, declaration, invocation, allowed]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const createFailure=(details,cause)=>({...details,cause});${declaration}const body=Effect.fn(function*(){return ${invocation};});return unknownExecutor(body);};`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed === true ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect.each([
  'const get=(value=protectedEffect)=>value;const hidden=get();',
  'const get=(value=protectedEffect)=>value;const hidden=get(undefined);',
  'const get=(first,second=first)=>second;const hidden=get(protectedEffect);',
])('traces an absent ordinary helper default into its actual returned carrier', (declaration) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};${declaration}return unknownTransform(hidden);};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  'const args=[protectedEffect] as const;const pick=(first,second,chosen=first)=>chosen;const hidden=pick(...args,"data");',
  'const pick=(value=protectedEffect)=>value;const missing=undefined;const hidden=pick(missing);',
  'const pick=(value=protectedEffect)=>value;const hidden=pick(void 0);',
  'const undefined=protectedEffect;const pick=(value={ok:true})=>value;const hidden=pick(undefined);',
])('retains protected defaults across supplied undefined and unexpanded argument slots', (declaration) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};${declaration}return unknownTransform(hidden);};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  'Effect.map(Effect.succeed(undefined),(value=protectedEffect)=>value)',
  'Effect.succeed(undefined).pipe(Effect.map((value=protectedEffect)=>value))',
  'Effect.map(Effect.succeed(undefined),(value=protectedEffect)=>{unknownTransform(value);return{ok:true};})',
])('binds the actual default at a native callback input slot', (producer) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const hidden=yield*${producer};return unknownTransform(hidden);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  'const pick=(value=protectedEffect)=>value;const hidden=pick({ok:true});',
  'const undefined={ok:true};const pick=(value=protectedEffect)=>value;const hidden=pick(undefined);',
])('keeps a definitely defined argument separate from an unused default', (declaration) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};${declaration}return unknownData(hidden);};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
const soleRestTargetForward = 'return target(...args);';
const soleRestDataInvocation = "forward('first',{ok:true},3,4,5,6);";
it.effect.each([
  ['six data arguments', soleRestTargetForward, soleRestDataInvocation, true],
  ['protected second argument', soleRestTargetForward, "forward('first',protectedEffect,3,4,5,6);", false],
  ['mutated vector', 'args.reverse();return target(...args);', soleRestDataInvocation, false],
  ['escaping vector', 'unknownMutation(args);return target(...args);', soleRestDataInvocation, false],
  ['unknown caller vector', soleRestTargetForward, 'forward(...unknownVector);', false],
  ['escaping wrapper', soleRestTargetForward, "unknownMutation(forward);forward('first',{ok:true},3,4,5,6);", false],
  ['mixed target spread', "return target('prefix',...args);", soleRestDataInvocation, false],
])('proves only a closed sole-rest forwarding vector: %s', ([_name, body, invocation, allowed]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const target=Effect.fn(function*(first,second,third,fourth,fifth,sixth){unknownObserve(second);return{ok:true};});const forward=(...args)=>{${body}};${invocation}return Effect.void;};`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed === true ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect.each([
  ['plain nonzero index', 'unknownData(args[1]);return target(...args);', true],
  ['protected nonzero index', 'unknownTransform(args[1]);return target(...args);', false],
  ['protected index pipe', 'target(...args);return args[1].pipe(unknownTransform);', false],
])('traces actual rest-vector elements at %s', ([_name, body, allowed]) => {
  const snapshot = sources();
  const argument = allowed === true ? '{ok:true}' : 'protectedEffect';
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const target=(first,second)=>({ok:true});const forward=(...args)=>{${body}};return forward('data',${argument});};`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed === true ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect.each([
  "unknownTransform(forward('data',protectedEffect))",
  "forward('data',protectedEffect)[1].pipe(unknownTransform)",
])('retains captured whole-rest elements after returning the vector', (expression) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const target=(first,second)=>({ok:true});const forward=(...args)=>{target(...args);return args;};return ${expression};};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  'Array.prototype[Symbol.iterator]=counterfeit;',
  'Object.defineProperty(Array.prototype,Symbol.iterator,{value:counterfeit});',
  'const iterator=[][Symbol.iterator]();Object.getPrototypeOf(iterator).next=counterfeit;',
  'const nativeArray=Array;Object.defineProperty(nativeArray.prototype,Symbol.iterator,{value:counterfeit});',
])('requires genuine implicit Array iteration for a closed rest vector', (mutation) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';${mutation}export const use=transaction=>{const protectedEffect=${innerFactoryRead};const target=Effect.fn(function*(first,second){unknownObserve(second);return{ok:true};});const forward=(...args)=>target(...args);forward('first',{ok:true});return Effect.void;};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('checks Array iterator identity in executed side-effect dependencies', () => {
  const snapshot = sources();
  snapshot.set(`${owner}/shared/iterator-mutation.ts`, 'Array.prototype[Symbol.iterator]=counterfeit;');
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';import '../shared/iterator-mutation.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const target=Effect.fn(function*(first,second){unknownObserve(second);return{ok:true};});const forward=(...args)=>target(...args);forward('first',{ok:true});return Effect.void;};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  { allowed: true, name: 'nested shadow', source: `${producerSource}{const Effect={};Effect.gen=counterfeit;}` },
  {
    allowed: false,
    name: 'captured genuine write',
    source: `${producerSource}const mutate=()=>{Effect.gen=counterfeit;};`,
  },
  {
    allowed: true,
    name: 'readonly local data',
    source: `${producerSource}const readonlyValue={value:1} as const;const read=()=>readonlyValue.value;`,
  },
])('preserves lexical write classification for %s', ({ allowed, source }) => {
  const snapshot = sources();
  snapshot.set(producerFile, source);
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect('keeps equal write spans in distinct immutable Programs independent', () =>
  Effect.gen(function* distinctProgramWrites() {
    const prefix = `${producerSource}const Other_={};`;
    const safe = sources();
    safe.set(producerFile, `${prefix}Other_.gen=counterfeit;`);
    const unsafe = sources();
    unsafe.set(producerFile, `${prefix}Effect.gen=counterfeit;`);
    expect(yield* resolve(safe)).toHaveLength(1);
    expect(yield* resolve(unsafe)).toBeUndefined();
    expect(yield* resolve(safe)).toHaveLength(1);
  }),
);
it.effect.each([
  {
    allowed: true,
    name: 'sibling lexical declarations',
    source: `${producerSource}{const Layer={effect:counterfeit};const local=Layer.effect;}{const Layer={effect:other};const local=Layer.effect;}`,
  },
  {
    allowed: false,
    name: 'inner declaration shadows a native import',
    source: producerSource
      .replace('export const provider=Layer.effect', 'const build=()=>{const Layer=foreign;return Layer.effect')
      .replace(';}));', ';}));};export const provider=build();'),
  },
  {
    allowed: false,
    name: 'ambiguous equal-scope var declarations',
    source: producerSource.replace(
      'export const provider=Layer.effect',
      'var selected=Layer;var selected=foreign;export const provider=selected.effect',
    ),
  },
])('preserves binding index lexical decisions for %s', ({ allowed, source }) => {
  const snapshot = sources();
  snapshot.set(producerFile, source);
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect.each([
  {
    allowed: true,
    body: 'effect.pipe(Effect.catchCause(()=>Effect.succeed({ok:true})))',
    input: 'Effect.succeed({ok:true})',
    name: 'data input',
  },
  {
    allowed: false,
    body: 'effect.pipe(Effect.catchCause(()=>Effect.succeed({ok:true})))',
    input: 'protectedEffect',
    name: 'protected input',
  },
  { allowed: false, body: 'unknownTransform(effect)', input: 'protectedEffect', name: 'unknown transform' },
  {
    allowed: false,
    body: 'effect.pipe(Effect.provideService(Factory,{make:input=>input.transaction}))',
    input: 'protectedEffect',
    name: 'fake local context',
  },
])('binds the actual incoming program to a published immutable first-pipe helper: %s', ({ allowed, body, input }) =>
  Effect.gen(function* actualFirstPipeFrame() {
    const snapshot = sources();
    const helperFile = `${owner}/shared/pipe-helper.ts`;
    snapshot.set(
      helperFile,
      `import {Effect} from 'effect';import {Factory} from './port.ts';export const recover=effect=>${body};`,
    );
    const source = `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';import {recover} from '@app/pipe-helper';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const compute=Effect.fn(function*(){return yield*${input}.pipe(recover);});Object.freeze({compute});return Effect.void;};`;
    snapshot.set(consumerFile, source);
    const path = yield* Path.Path;
    const resolver = makeScopedContextFactoryResolver(
      snapshot,
      root,
      path,
      new Map([['@app/pipe-helper', helperFile]]),
    );
    const call = callee(source);
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    const result = resolver.resolve({ callee: call, file: consumerFile });
    if (allowed) {
      expect(result).toHaveLength(1);
    } else {
      expect(result).toBeUndefined();
    }
  }).pipe(Effect.provide(Path.layer)),
);
it.effect.each([
  { allowed: true, name: 'first data cell', pattern: '[row]', values: '[{ok:true}]' },
  { allowed: true, name: 'nonzero data cell', pattern: '[,row]', values: '[protectedEffect,{ok:true}]' },
  { allowed: false, name: 'first protected cell', pattern: '[row]', values: '[protectedEffect]' },
  { allowed: false, name: 'nonzero protected cell', pattern: '[,row]', values: '[{ok:true},protectedEffect]' },
  { allowed: false, name: 'nested protected value', pattern: '[row]', values: '[{nested:protectedEffect}]' },
  { allowed: false, name: 'empty-vector protected default', pattern: '[row=protectedEffect]', values: '[]' },
  { allowed: false, name: 'unsupported nested pattern', pattern: '[[row]]', values: '[[protectedEffect]]' },
])('projects actual native callback ArrayPattern cells: %s', ({ allowed, pattern, values }) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};yield*Effect.succeed(${values}).pipe(Effect.flatMap((${pattern})=>{unknownObserve(row);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect('keeps actual first-pipe frames distinct for the same helper body after a safe invocation', () =>
  Effect.gen(function* distinctFirstPipeFrames() {
    const snapshot = sources();
    const helperFile = `${owner}/shared/pipe-helper.ts`;
    snapshot.set(
      helperFile,
      "import {Effect} from 'effect';export const recover=effect=>effect.pipe(Effect.catchCause(()=>Effect.succeed({ok:true})));",
    );
    const source = `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';import {recover} from '@app/pipe-helper';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const compute=Effect.fn(function*(){yield*Effect.succeed({ok:true}).pipe(recover);return yield*protectedEffect.pipe(recover);});Object.freeze({compute});return Effect.void;};`;
    snapshot.set(consumerFile, source);
    const path = yield* Path.Path;
    const resolver = makeScopedContextFactoryResolver(
      snapshot,
      root,
      path,
      new Map([['@app/pipe-helper', helperFile]]),
    );
    const call = callee(source);
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    expect(resolver.resolve({ callee: call, file: consumerFile })).toBeUndefined();
  }).pipe(Effect.provide(Path.layer)),
);
it.effect('does not confuse a forEach iterable with an ArrayPattern callback element', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};yield*Effect.forEach([[0,protectedEffect]],([safe,chosen])=>chosen.pipe(unknownTransform));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  [
    'declared mutator',
    'const tuple=[0,0];const inject=row=>{row[1]=protectedEffect;};inject(tuple);',
    'Effect.succeed(tuple)',
  ],
  ['unknown mutator', 'const tuple=[0,0];unknownMutate(tuple);', 'Effect.succeed(tuple)'],
  ['mapped formal mutation', '', 'Effect.map(Effect.succeed([0,0]),tuple=>{tuple[1]=protectedEffect;return tuple;})'],
])('rejects an ArrayPattern projection after tuple custody escapes: %s', ([_name, setup, program]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};${setup}yield*${program}.pipe(Effect.flatMap(([,chosen])=>chosen.pipe(unknownTransform)));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  { allowed: false, name: 'captured shared named vector', setup: 'const tuple=[0,1];' },
  {
    allowed: false,
    name: 'array container alias',
    setup: 'const tuple=[0,0];const box=[tuple];const inject=row=>{row[1]=protectedEffect;};inject(box[0]);',
  },
  {
    allowed: false,
    name: 'quoted-key container alias',
    setup: "const tuple=[0,0];const box={'row':tuple};const inject=row=>{row[1]=protectedEffect;};inject(box.row);",
  },
  {
    allowed: false,
    name: 'returned closure alias',
    setup: 'const tuple=[0,0];const get=()=>tuple;const inject=row=>{row[1]=protectedEffect;};inject(get());',
  },
])('requires a closed actual tuple origin through native sync: %s', ({ allowed, setup }) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};${setup}yield*Effect.sync(()=>tuple).pipe(Effect.flatMap(([,chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect('does not treat a sparse ArrayPattern input as own undefined data', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};Array.prototype[1]=protectedEffect;yield*Effect.succeed([0,,]).pipe(Effect.flatMap(([,chosen])=>chosen.pipe(unknownTransform)));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects sparse precision even when an earlier inherited cell can mutate the selected own cell', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};Object.defineProperty(Array.prototype,'0',{get(){this[1]=protectedEffect;return 0;}});yield*Effect.succeed([,0]).pipe(Effect.flatMap(([,chosen])=>chosen.pipe(unknownTransform)));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('does not invent an own rest-vector value beyond the actual argument bound', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};Array.prototype[9]=protectedEffect;const target=(first,second)=>({ok:true});const forward=(...args)=>{target(...args);return args[9].pipe(unknownTransform);};forward('first','second');return Effect.void;};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('allows a fresh tuple allocated inside the actual native callback invocation', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};yield*Effect.sync(()=>{const tuple=[0,1];return tuple;}).pipe(Effect.flatMap(([,chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect('rejects a shared tuple returned through the same getter AST on separate executions', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const tuple=[0,0];const get=()=>tuple;const inject=row=>{row[1]=protectedEffect;};inject(get());yield*Effect.sync(get).pipe(Effect.flatMap(([,chosen])=>chosen.pipe(unknownTransform)));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  { allowed: false, name: 'shared eager literal', program: 'Effect.succeed([0,0])' },
  {
    allowed: false,
    name: 'shared enclosing eager pipeline',
    program: 'Effect.succeed([0,0]).pipe(Effect.map(value=>value))',
  },
  { allowed: true, name: 'fresh per-execution sync allocation', program: 'Effect.sync(()=>[0,0])' },
  {
    allowed: true,
    name: 'fresh per-execution generator allocation',
    program: 'Effect.gen(function*(){return [0,0];})',
  },
  {
    allowed: true,
    name: 'fresh per-execution map allocation',
    program: 'Effect.succeed(0).pipe(Effect.map(()=>[0,0]))',
  },
])('retains actual tuple producer ownership across two native executions: %s', ({ allowed, program }) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const shared=${program};const inject=row=>{row[1]=protectedEffect;};const first=yield*shared;inject(first);yield*shared.pipe(Effect.flatMap(([,chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect('retains mutated shared eager slots through a fresh copying map callback', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const shared=Effect.succeed([0,0]);const first=yield*shared;const inject=row=>{row[1]=protectedEffect;};inject(first);yield*shared.pipe(Effect.map(tuple=>[tuple[0],tuple[1]]),Effect.flatMap(([,chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  'Effect.as(Effect.succeed(0),[0,0])',
  'Effect.succeed(0).pipe(Effect.as([0,0]))',
  'Effect.as([0,0])(Effect.succeed(0))',
  'replacement(Effect.succeed(0))',
  'Effect.succeed(0).pipe(replacement)',
])('does not project stale eager replacement slots across native as executions: %s', (program) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const replacement=Effect.as([0,0]);const shared=${program};const first=yield*shared;const inject=row=>{row[1]=protectedEffect;};inject(first);yield*shared.pipe(Effect.flatMap(([,chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  { allowed: true, mutation: '', name: 'readonly copied cells' },
  { allowed: false, mutation: 'tuple[1]=protectedEffect;', name: 'direct formal slot write' },
  {
    allowed: false,
    mutation: 'const inject=row=>{row[1]=protectedEffect;};inject(tuple);',
    name: 'declared mutator on formal',
  },
])('checks actual captured member custody before copying tuple slots: %s', ({ allowed, mutation }) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};yield*Effect.succeed([0,0]).pipe(Effect.map(tuple=>{${mutation}return[tuple[0],tuple[1]];}),Effect.flatMap(([,chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect.each([
  'tuple.reverse();',
  'tuple.sort((left,right)=>left===protectedEffect?-1:1);',
  'tuple.reverse`reorder`;',
  'const reverse=tuple.reverse;reverse.call(tuple);',
])('does not treat a tuple method receiver as a readonly slot use: %s', (mutation) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};yield*Effect.succeed([0,protectedEffect]).pipe(Effect.map(tuple=>{${mutation}return[tuple[0],tuple[1]];}),Effect.flatMap(([chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('does not assume an out-of-bounds numeric member is iterator-completion undefined', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};Array.prototype[9]=protectedEffect;yield*Effect.succeed([0,0]).pipe(Effect.map(tuple=>[tuple[9]]),Effect.flatMap(([chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  { key: '-1', setup: 'Array.prototype[-1]=protectedEffect;' },
  { key: 'index', setup: 'const index=-1;Array.prototype[index]=protectedEffect;' },
  { key: "'01'", setup: "Array.prototype['01']=protectedEffect;" },
  { key: "'1.0'", setup: "Array.prototype['1.0']=protectedEffect;" },
  { key: 'slot', setup: "const slot=Symbol.for('carrier-slot');Array.prototype[slot]=protectedEffect;" },
])('preserves unknown inline array keys instead of dropping their possible inherited value: %s', ({ key, setup }) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};${setup}yield*Effect.sync(()=>[[0,0][${key}],0]).pipe(Effect.flatMap(([chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  { allowed: true, key: '0', name: 'readonly two-hop own index', setup: 'const arr=[0,0];const alias=arr;' },
  {
    allowed: false,
    key: "'-1'",
    name: 'two-hop negative string',
    setup: "const arr=[0,0];const alias=arr;Array.prototype['-1']=protectedEffect;",
  },
  {
    allowed: false,
    key: "'01'",
    name: 'multi-hop noncanonical string',
    setup:
      "const arr=[0,0];const first=arr;const second=first;const alias=second;Array.prototype['01']=protectedEffect;",
  },
  {
    allowed: false,
    key: "'-1'",
    name: 'cyclic unknown origin',
    setup: 'const first=second;const second=first;const alias=second;',
  },
])('resolves bounded actual alias origins before numeric slot policy: %s', ({ allowed, key, setup }) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};${setup}yield*Effect.sync(()=>[alias[${key}],0]).pipe(Effect.flatMap(([chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect.each(["'-1'", "'01'"])('does not drop an unresolved nested receiver before array key policy: %s', (key) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const box={row:[0,0]};Array.prototype[${key}]=protectedEffect;yield*Effect.sync(()=>[box.row[${key}],0]).pipe(Effect.flatMap(([chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
const nestedOwnCellRead = 'box.row[0]';
it.effect.each([
  { allowed: true, name: 'fresh own literal child', setup: 'const box={row:[0,0]};', source: nestedOwnCellRead },
  { allowed: false, name: 'accessor child', setup: 'const box={get row(){return[0,0];}};', source: nestedOwnCellRead },
  { allowed: false, name: 'unknown child producer', setup: 'const box=unknownBox();', source: nestedOwnCellRead },
  {
    allowed: false,
    name: 'child mutator alias',
    setup: 'const box={row:[0,0]};const inject=row=>{row[0]=protectedEffect;};inject(box.row);',
    source: nestedOwnCellRead,
  },
])('resolves only fresh closed own-data nested member origins: %s', ({ allowed, setup, source }) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};yield*Effect.sync(()=>{${setup}return[${source},0];}).pipe(Effect.flatMap(([chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect('validates selected child alias custody after resolving a non-Identifier receiver', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};yield*Effect.sync(()=>{const tuple=[0,0];const box={row:tuple};const inject=row=>{row[1]=protectedEffect;};inject(tuple);return[box.row[1],0];}).pipe(Effect.flatMap(([chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('does not treat absent callable ownership as fresh for a module-shared box', () => {
  const snapshot = sources();
  snapshot.set(
    `${owner}/shared/box-mutator.ts`,
    "import {box} from '../src/consumer.ts';export const inject=effect=>{box.row[0]=effect;};",
  );
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';import {inject} from '../shared/box-mutator.ts';export const box={row:[0,0]};const protectedEffect=Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction:{}});});inject(protectedEffect);const chosen=box.row[0];export const use=()=>Effect.sync(()=>unknownObserve(chosen));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  { allowed: true, name: 'known own data field', row: '{x:0}' },
  { allowed: false, name: 'missing inherited field', row: '{}' },
])('distinguishes proved own literal data from missing inherited projection: %s', ({ allowed, row }) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};Object.prototype.x=protectedEffect;yield*Effect.sync(()=>{const row:Record<string,unknown>=${row};return[row.x,0];}).pipe(Effect.flatMap(([chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
  );
  return resolve(snapshot).pipe(
    Effect.map((result) => (allowed ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
  );
});
it.effect.each([
  { allowed: true, comparison: 'row===undefined', setup: '' },
  { allowed: true, comparison: 'row!==undefined', setup: '' },
  { allowed: false, comparison: 'row==undefined', setup: '' },
  { allowed: false, comparison: 'row===undefined', setup: 'const undefined=foreign;' },
])(
  'retains row custody only through strict unshadowed undefined identity comparison: %s',
  ({ allowed, comparison, setup }) => {
    const snapshot = sources();
    snapshot.set(
      consumerFile,
      `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};yield*Effect.sync(()=>{${setup}const row={x:0};if(${comparison})return[0,0];return[row.x,0];}).pipe(Effect.flatMap(([chosen])=>{unknownObserve(chosen);return Effect.succeed({ok:true});}));return{ok:true};});`,
    );
    return resolve(snapshot).pipe(
      Effect.map((result) => (allowed ? expect(result).toHaveLength(1) : expect(result).toBeUndefined())),
    );
  },
);

it.effect('retains a genuine nested Effect value yielded from native succeed', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const nested=yield*Effect.succeed(${innerFactoryRead});return yield*nested.pipe(unknownTransform);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
const protectedEffectAliasFixture = 'const box={effect:protectedEffect};const alias=box;';
it.effect.each([
  ['two-hop alias', protectedEffectAliasFixture, 'unknownTransform(alias.effect)'],
  ['piped alias projection', protectedEffectAliasFixture, 'alias.effect.pipe(unknownTransform)'],
  [
    'provided alias projection',
    protectedEffectAliasFixture,
    `Effect.provideContext(alias.effect,${unsafeFactoryContext})`,
  ],
  ['nested record projection', 'const box={inner:{effect:protectedEffect}};', 'unknownTransform(box.inner.effect)'],
  ['immutable computed index', 'const list=[protectedEffect];const index=0;', 'unknownTransform(list[index])'],
  ['array spread projection', '', 'unknownTransform([...[0,0],protectedEffect][2])'],
  ['getter projection', 'const box={get effect(){return protectedEffect}};', 'unknownTransform(box.effect)'],
  ['returned record projection', 'const box=()=>({effect:protectedEffect});', 'unknownTransform(box().effect)'],
])('retains protected Effect origin through %s', ([_name, declaration, expression]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};${declaration}return ${expression};};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('keeps a proven ordinary field separate from its protected Effect sibling', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};const box={effect:protectedEffect,data:{ok:true}};return unknownData(box.data);};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect('retains a nested protected Effect returned by native sync', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const hidden=yield*Effect.sync(()=>protectedEffect);return yield*hidden.pipe(unknownTransform);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each(['Effect.sync(()=>protectedEffect)', 'Effect.flatMap(Effect.void,()=>protectedEffect)'])(
  'retains protected returned values in a native producer',
  (producer) => {
    const snapshot = sources();
    snapshot.set(
      consumerFile,
      `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};return ${producer}.pipe(unknownTransform);};`,
    );
    return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
  },
);
it.effect.each([
  ['same module', tagFile],
  ['executed dependency', `${owner}/shared/mutate.ts`],
])('checks Object intrinsic identity before native Context constructors in %s', ([_name, file]) => {
  const snapshot = sources();
  const mutation = `Object.setPrototypeOf=counterfeit;`;
  snapshot.set(file, file === tagFile ? `${tagSource}${mutation}` : mutation);
  if (file !== tagFile) {
    snapshot.set(tagFile, `${tagSource}import './mutate.ts';`);
  }
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

const nativeSyncCallbackExpression = 'Effect.sync(get)';
it.effect.each([
  ['declared sync callback', 'const get=()=>protectedEffect;', nativeSyncCallbackExpression],
  ['optional sync callback', 'const get=(_unused?:unknown)=>protectedEffect;', nativeSyncCallbackExpression],
  ['default sync callback', 'const get=(value=protectedEffect)=>value;', nativeSyncCallbackExpression],
  ['renamed sync callback', 'const get=()=>protectedEffect;const renamed=get;', 'Effect.sync(renamed)'],
  ['piped map callback input', '', 'Effect.succeed(protectedEffect).pipe(Effect.map(effect=>effect))'],
  ['direct map callback input', '', 'Effect.map(Effect.succeed(protectedEffect),effect=>effect)'],
  [
    'declared map callback',
    'const identity=effect=>effect;',
    'Effect.succeed(protectedEffect).pipe(Effect.map(identity))',
  ],
  [
    'flatMap callback input',
    '',
    'Effect.succeed(protectedEffect).pipe(Effect.flatMap(effect=>Effect.succeed(effect)))',
  ],
  ['unproved derived output', '', 'Effect.succeed(protectedEffect).pipe(Effect.map(effect=>unknownResult(effect)))'],
])('retains exact native success transport through %s', ([_name, declaration, producer]) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};${declaration}const hidden=yield*${producer};return yield*hidden.pipe(unknownTransform);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  'Effect.succeed(protectedEffect).pipe(Effect.map(()=>({ok:true})))',
  'Effect.map(Effect.succeed(protectedEffect),()=>({ok:true}))',
])('proves an actual ordinary DTO map result without retaining the input Effect', (producer) => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};const dto=yield*${producer};return unknownData(dto);});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect('protects the actual native map input even when a callback returns plain data afterward', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>{const protectedEffect=${innerFactoryRead};return Effect.succeed(protectedEffect).pipe(Effect.map(effect=>{unknownTransform(effect);return{ok:true};}));};`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each(['const get=(_unused?:unknown)=>({ok:true});', 'const get=(_unused=protectedEffect)=>({ok:true});'])(
  'executes a missing-argument callback once and proves its actual plain DTO result',
  (declaration) => {
    const snapshot = sources();
    snapshot.set(
      consumerFile,
      `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const protectedEffect=${innerFactoryRead};${declaration}const dto=yield*Effect.sync(get);return unknownData(dto);});`,
    );
    return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
  },
);
const dataMethodCallee = (source: string) => {
  let found: Expression | undefined;
  new Visitor({
    CallExpression(node) {
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'problems' &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === 'invalid'
      ) {
        found = node.callee;
      }
    },
  }).visit(parseSync(consumerFile, source).program);
  return found;
};
const inspectDataMethod = (source: string) => {
  const snapshot = sources();
  snapshot.set(consumerFile, source);
  return withResolver(snapshot, (resolver) => {
    const call = dataMethodCallee(source);
    return call === undefined ? undefined : resolver.resolveDataObjectMethod({ callee: call, file: consumerFile });
  });
};
it.effect('exposes the original immutable own data-object method body only for separate callback inspection', () =>
  inspectDataMethod(
    `const prefix='invalid';const problems=Object.freeze({invalid:()=>({code:prefix})});problems.invalid();`,
  ).pipe(
    Effect.map((candidate) => {
      expect(candidate?.implementation.body?.type).toBe('ParenthesizedExpression');
      expect(candidate?.capturedBindings.has('prefix')).toBe(true);
      return candidate;
    }),
  ),
);
it.effect('resolves the actual returned data factory closure with its bound original arguments', () => {
  const snapshot = sources();
  const supportFile = `${owner}/src/problem-support.ts`;
  snapshot.set(supportFile, `export const build=(make,slug)=>()=>make({detail:\`Invalid \${slug}\`});`);
  const source = `import {build} from './problem-support.ts';const problems={invalid:build(input=>input,'operation')};problems.invalid();`;
  snapshot.set(consumerFile, source);
  return withResolver(snapshot, (resolver) => {
    const call = dataMethodCallee(source);
    const candidate =
      call === undefined ? undefined : resolver.resolveDataObjectMethod({ callee: call, file: consumerFile });
    expect(candidate?.file).toBe(supportFile);
    expect(candidate?.capturedBindings.get('make')?.expression.type).toBe('ArrowFunctionExpression');
    expect(candidate?.capturedBindings.get('slug')?.expression.type).toBe('Literal');
    expect(candidate?.capturedParameters.size).toBe(0);
    return candidate;
  });
});
it.effect.each([
  ['named declaration', ''],
  ['overloaded declaration', 'function invalid(input:string):string;function invalid(input:number):number;'],
])('resolves the original returned declaration data method with captures: %s', ([_name, signatures]) => {
  const snapshot = sources();
  const supportFile = `${owner}/src/declaration-support.ts`;
  const support = `export const build=(make,slug)=>{${signatures}function invalid(input){return make({detail:slug,input});}return {invalid};};`;
  snapshot.set(supportFile, support);
  const source = `import {build} from './declaration-support.ts';const problems=build(input=>input,'operation');problems.invalid();`;
  snapshot.set(consumerFile, source);
  return withResolver(snapshot, (resolver) => {
    const call = dataMethodCallee(source);
    const candidate =
      call === undefined ? undefined : resolver.resolveDataObjectMethod({ callee: call, file: consumerFile });
    expect(candidate?.file).toBe(supportFile);
    expect(candidate?.implementation.type).toBe('FunctionDeclaration');
    expect(candidate?.implementation.body?.type).toBe('BlockStatement');
    expect(candidate?.implementation.start).toBe(support.lastIndexOf('function invalid'));
    expect(candidate?.capturedBindings.get('make')?.expression.type).toBe('ArrowFunctionExpression');
    expect(candidate?.capturedBindings.get('slug')?.expression.type).toBe('Literal');
    expect(call === undefined ? undefined : resolver.resolve({ callee: call, file: consumerFile })).toBeUndefined();
    return candidate;
  });
});
it.effect.each([
  ['signature only', 'declare function invalid(input:string):string;const problems={invalid};'],
  [
    'duplicate runtime body',
    'function invalid(input){return input;}function invalid(input){return foreign(input);}const problems={invalid};',
  ],
  ['rebound declaration', 'function invalid(input){return input;}invalid=foreign;const problems={invalid};'],
  [
    'opaque inner shadow',
    'function invalid(input){return input;}const build=()=>{const invalid=foreign;return {invalid};};const problems=build();',
  ],
])('refuses an unproved declaration data method: %s', ([_name, definition]) =>
  inspectDataMethod(`${definition}problems.invalid();`).pipe(
    Effect.map((candidate) => expect(candidate).toBeUndefined()),
  ),
);
it.effect.each([
  ['unknown factory', 'unknown', ''],
  ['factory side effect', 'build', 'const build=make=>{mutate(make);return()=>make({});};'],
  ['conditional factory result', 'build', 'const build=make=>condition?()=>make({}):foreign;'],
  ['default parameter', 'build', 'const build=(make=foreign)=>()=>make({});'],
  ['mutated factory alias', 'build', 'let build=make=>()=>make({});build=foreign;'],
  ['missing argument', 'build', 'const build=(make,slug)=>()=>make({slug});'],
  ['recursive factory', 'build', 'const build=make=>build(make);'],
])('refuses a callable data field from %s', ([_name, factory, declaration]) =>
  inspectDataMethod(`${declaration}const problems={invalid:${factory}(input=>input)};problems.invalid();`).pipe(
    Effect.map((candidate) => expect(candidate).toBeUndefined()),
  ),
);
it.effect.each([
  ['getter', `const problems={get invalid(){return()=>fake;}};`],
  ['prototype', `const problems={__proto__:{invalid:()=>fake}};`],
  ['duplicate literal field', `const problems={invalid:()=>safe,'invalid':()=>fake};`],
  ['computed field', `const problems={['invalid']:()=>fake};`],
  ['mutation', `const problems={invalid:()=>safe};problems.invalid=fake;`],
  ['unknown mutator', `const problems={invalid:()=>safe};mutate(problems);`],
  ['foreign object', `import {problems} from 'foreign';`],
  ['ambiguous object', `const problems=condition?{invalid:()=>safe}:{invalid:()=>fake};`],
])('refuses data-object callback inspection after %s', ([_name, definition]) =>
  inspectDataMethod(`${definition}problems.invalid();`).pipe(
    Effect.map((candidate) => expect(candidate).toBeUndefined()),
  ),
);

const closedContextBranches = (earlier: string, last: string, mutate = '') =>
  `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';class Other extends Context.Service<Other,{}>()('other'){}const contextOf=()=>Context.make(Other,{}).pipe(Context.add(Other,{}));const base=contextOf();const boundTo=value=>{if(value){return{context:${earlier}};}return{context:${last}};};export const use=transaction=>{const bound=boundTo(transaction);${mutate}return Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction});}).pipe(Effect.provideContext(bound.context));};`;
it.effect('proves every actual own context field return through immutable local helper composition', () => {
  const snapshot = sources();
  snapshot.set(consumerFile, closedContextBranches('contextOf()', 'base'));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
});
it.effect.each([
  ['earlier unknown context', unsafeFactoryContext, 'base', ''],
  ['later unknown context', 'base', unsafeFactoryContext, ''],
  ['mutated returned context', 'base', 'base', `bound.context.mapUnsafe.set('@app/owner/Factory',fake);`],
  ['getter returned context', 'base', 'base', `Object.defineProperty(bound,'context',{get:()=>fake});`],
])('rejects context field proof with %s', ([_name, earlier, last, mutation]) => {
  const snapshot = sources();
  snapshot.set(consumerFile, closedContextBranches(earlier, last, mutation));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

it.effect('rejects a context cycle without a genuine native snapshot seed', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';const a=()=>b();const b=()=>a();export const use=transaction=>${innerFactoryRead}.pipe(Effect.provideContext(a()));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects mixed native snapshot and unsafe context dependencies', () => {
  const snapshot = sources();
  snapshot.set(consumerFile, snapshotConsumer(`Context.merge(alias,${unsafeFactoryContext})`));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('rejects an unknown constraint surrounding a genuine native snapshot', () => {
  const snapshot = sources();
  snapshot.set(consumerFile, snapshotConsumer('alias').replace(/;$/u, `.pipe(Effect.provideContext(unknownContext));`));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect('fails closed when native snapshot constraints exceed the finite proof budget', () => {
  const snapshot = sources();
  const declarations = Array.from(
    { length: 65 },
    (_unused, index) => `const context${index}=yield*Effect.context();`,
  ).join('');
  const providers = Array.from({ length: 65 }, (_unused, index) => `Effect.provideContext(context${index})`).join(',');
  snapshot.set(
    consumerFile,
    `import {Context,Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){${declarations}return yield*${innerFactoryRead}.pipe(${providers});});`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

/** Core's guarded pool modules: the proof accepts their exports only as these exact Core declarations. */
const databaseClientGuard = 'database-client';
const sessionIdentityGuard = 'session-identity';
const transactionIoGuard = 'transaction-io-guard';
const coreDatabaseGuardFiles = [databaseClientGuard, sessionIdentityGuard, transactionIoGuard] as const;
const foreignGuardSource = 'export const guardPoolAcquisition = (client) => client;';
const coreAcquisition =
  "session.pooling === 'pooled' ? openDatabaseClient(configuration) : PgClient.make(configuration)";
const guardedReturn = 'return guardPoolAcquisition(client);';
const sessionRoleCheck =
  'verifySessionRoleOnFirstUse(Context.get(context, PgClient.PgClient), configuration.expectedRole)';
const guardImport =
  "import { guardPoolAcquisition, refuseInsideDatabaseTransaction } from './transaction-io-guard.ts';";
const replaceOnce = (source: string, from: string, to: string): string => {
  expect(source.split(from)).toHaveLength(2);
  return source.replace(from, to);
};
const unguardedReturn = 'return client;';
/** Each edit leaves the security fence's guarded Core pool shape, so each must be refused. */
const guardedPoolEdits = {
  'foreign pool guard': (source: string) =>
    replaceOnce(
      source,
      guardImport,
      "import { refuseInsideDatabaseTransaction } from './transaction-io-guard.ts';import { guardPoolAcquisition } from './foreign-guard.ts';",
    ),
  'injected codec options': (source: string) =>
    replaceOnce(source, 'PgClient.make(configuration)', 'PgClient.make({ ...configuration, types: foreignRegistry })'),
  'look-alike session-role check': (source: string) =>
    replaceOnce(
      source,
      "import { verifySessionRoleOnFirstUse } from './session-identity.ts';",
      'const verifySessionRoleOnFirstUse = (client: PgClient.PgClient, _role: string) => client;',
    ),
  'missing session-role check': (source: string) =>
    replaceOnce(source, sessionRoleCheck, 'Context.get(context, PgClient.PgClient)'),
  'missing transaction I/O refusal': (source: string) =>
    replaceOnce(
      source,
      "yield* refuseInsideDatabaseTransaction('pool-acquisition', 'PostgreSQL connection pool');",
      '',
    ),
  'unguarded openDatabaseClient pool': (source: string) =>
    replaceOnce(
      replaceOnce(source, coreAcquisition, 'openDatabaseClient(configuration)'),
      guardedReturn,
      unguardedReturn,
    ),
  'unguarded PgClient.make pool': (source: string) =>
    replaceOnce(replaceOnce(source, coreAcquisition, 'PgClient.make(configuration)'), guardedReturn, unguardedReturn),
  'unguarded pool behind the session-role check': (source: string) =>
    replaceOnce(source, guardedReturn, unguardedReturn),
} satisfies Readonly<Record<string, (source: string) => string>>;
const guardedPoolEdit = (name: string) => Object.entries(guardedPoolEdits).find(([edit]) => edit === name)?.[1];
const replaceTail = (source: string, from: string, to: string): string => {
  expect(source.split(from)).toHaveLength(2);
  return `${source.slice(0, source.indexOf(from))}${to}`;
};
const poolGuardDeclaration = 'export const guardPoolAcquisition = ';
const identityPoolGuard = `${poolGuardDeclaration}(client: PgClient.PgClient): PgClient.PgClient => client;\n`;
const sharedPoolAcquisition = '    : PgClient.make(configuration);';
/**
 * Security fence: guarded Core pool. Each edit changes a Core guard module the proofs trust only as reviewed (a
 * no-op guard, a skipped role query, injected codecs, a foreign URL, a row-rewriting Proxy, a mutated error
 * prototype), so each must be refused.
 */
const guardModuleEdits = {
  'foreign URL in openDatabaseClient': [
    databaseClientGuard,
    (source: string) =>
      replaceOnce(
        source,
        sharedPoolAcquisition,
        "    : PgClient.make({ url: Redacted.make('postgres://attacker.example/db'), types: foreignRegistry });",
      ),
  ],
  'identity pool guard': [
    transactionIoGuard,
    (source: string) => replaceTail(source, poolGuardDeclaration, identityPoolGuard),
  ],
  'injected codecs in openDatabaseClient': [
    databaseClientGuard,
    (source: string) =>
      replaceOnce(source, sharedPoolAcquisition, '    : PgClient.make({ ...configuration, types: foreignRegistry });'),
  ],
  'injected codecs in the shared pool lookup': [
    databaseClientGuard,
    (source: string) =>
      replaceOnce(source, '          url: key.url,', '          url: key.url,\n          types: foreignRegistry,'),
  ],
  'mutated error prototype through a constructed error': [
    sessionIdentityGuard,
    (source: string) =>
      `${source}\nObject.defineProperty(Object.getPrototypeOf(new DatabaseConnectionError({ reason: 'x' })), Symbol.iterator, { value: counterfeitIterator });\n`,
  ],
  'no-op transaction I/O refusal': [
    transactionIoGuard,
    (source: string) =>
      replaceOnce(
        source,
        source.slice(
          source.indexOf('export const refuseInsideDatabaseTransaction = '),
          source.indexOf('\n\n', source.indexOf('export const refuseInsideDatabaseTransaction = ')),
        ),
        'export const refuseInsideDatabaseTransaction = (_io: TransactionIo, _target: string): Effect.Effect<void> => Effect.void;',
      ),
  ],
  'row-rewriting pool guard': [
    transactionIoGuard,
    (source: string) =>
      replaceTail(
        source,
        poolGuardDeclaration,
        `${poolGuardDeclaration}(client: PgClient.PgClient): PgClient.PgClient => new Proxy(client, { get: (target, key) => (key === 'unsafe' ? (_sql: string) => target.unsafe('select forged_rows()') : Reflect.get(target, key)) });\n`,
      ),
  ],
  'session-role check without its role query': [
    sessionIdentityGuard,
    (source: string) =>
      replaceTail(
        source,
        'export const verifySessionRoleOnFirstUse = ',
        'export const verifySessionRoleOnFirstUse = (client: PgClient.PgClient, _expectedRole: string): PgClient.PgClient => client;\n',
      ),
  ],
} satisfies Readonly<Record<string, readonly [(typeof coreDatabaseGuardFiles)[number], (source: string) => string]>>;
const guardModuleEdit = (name: string, guard: string) =>
  Object.entries(guardModuleEdits).find(([edit, [file]]) => edit === name && file === guard)?.[1][1];
/** Core's database modules copied outside Core's own directory are not Core, whatever their path suffix. */
const relocatedCoreDatabase = 'Core database modules copied under an owner path';
const relocatedRowRewritingCoreDatabase = 'Core database modules copied under an owner path with a row-rewriting guard';

it.effect.each([
  'actual constructor',
  'counterfeit error native',
  'overridden error iterator',
  'mutated error prototype',
  'spread error payload',
  'ordinary successful error value',
  'overridden error evaluator payload',
  ...Object.keys(guardedPoolEdits),
  ...Object.keys(guardModuleEdits),
  relocatedCoreDatabase,
  relocatedRowRewritingCoreDatabase,
])('proves the real Core database constructor source: %s', (name) =>
  Effect.gen(function* actualDatabaseConstructor() {
    const path = yield* Path.Path;
    const app = nodePath.resolve(import.meta.dirname, '../..');
    const coreDb = nodePath.join(app, 'packages/core-runtime/src/db');
    const db = name.startsWith(relocatedCoreDatabase)
      ? nodePath.join(app, 'verticals/evil/packages/core-runtime/src/db')
      : coreDb;
    const clientFile = nodePath.join(db, 'client.ts');
    const poolFile = nodePath.join(db, 'pool-configuration.ts');
    const original = yield* Effect.tryPromise(() => readFile(nodePath.join(coreDb, 'client.ts'), 'utf-8'));
    const clientSource = guardedPoolEdit(name)?.(original) ?? original;
    let poolSource = yield* Effect.tryPromise(() => readFile(nodePath.join(coreDb, 'pool-configuration.ts'), 'utf-8'));
    let errorSource = yield* Effect.tryPromise(() => readFile(nodePath.join(coreDb, 'connection-error.ts'), 'utf-8'));
    if (name === 'counterfeit error native') {
      errorSource = errorSource.replace("from 'effect'", "from 'counterfeit'");
    }
    if (name === 'overridden error iterator') {
      errorSource = errorSource.replace('}> {}', '}> { *[Symbol.iterator](){ return injectedOptions; } }');
    }
    if (name === 'mutated error prototype') {
      errorSource +=
        '\nObject.defineProperty(DatabaseConnectionError.prototype,Symbol.iterator,{value:counterfeitIterator});';
    }
    if (name === 'spread error payload') {
      poolSource = poolSource.replace(
        'return yield* new DatabaseConnectionError({',
        'return yield* new DatabaseConnectionError({...foreignOptions,',
      );
    }
    if (name === 'ordinary successful error value') {
      poolSource = poolSource.replace(
        'return yield* new DatabaseConnectionError(',
        'return new DatabaseConnectionError(',
      );
    }
    if (name === 'overridden error evaluator payload') {
      poolSource = poolSource.replace(
        'return yield* new DatabaseConnectionError({',
        'return yield* new DatabaseConnectionError({"~effect/Effect/evaluate":()=>Effect.succeed({url:foreignUrl,types:foreignRegistry}),',
      );
    }
    const snapshot = new Map([
      [clientFile, clientSource],
      [poolFile, poolSource],
      [nodePath.join(db, 'connection-error.ts'), errorSource],
      [nodePath.join(db, 'foreign-guard.ts'), foreignGuardSource],
    ]);
    for (const guard of coreDatabaseGuardFiles) {
      const source = yield* Effect.tryPromise(() => readFile(nodePath.join(coreDb, `${guard}.ts`), 'utf-8'));
      const edited = guardModuleEdit(name, guard)?.(source) ?? source;
      snapshot.set(
        nodePath.join(db, `${guard}.ts`),
        name === relocatedRowRewritingCoreDatabase && guard === transactionIoGuard
          ? guardModuleEdits['row-rewriting pool guard'][1](edited)
          : edited,
      );
    }
    const resolver = makeScopedContextFactoryResolver(snapshot, app, path, new Map());
    let load: Expression | undefined;
    new Visitor({
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'makeCoreDatabase') {
          load ??= node.callee;
        }
      },
    }).visit(parseSync(clientFile, clientSource).program);
    expect(load).toBeDefined();
    if (load === undefined) {
      return;
    }
    resolver.resolveDeclaredFunction({ callee: load, file: clientFile });
    const modules = resolver.runtimeProofModules();
    const actual = modules.find((candidate) => candidate.file === clientFile);
    let executor: Expression | undefined;
    if (actual !== undefined) {
      new Visitor({
        Property(node) {
          if (
            node.key.type === 'Identifier' &&
            node.key.name === 'executor' &&
            node.value.type === 'YieldExpression' &&
            node.value.argument !== null
          ) {
            executor = node.value.argument;
          }
        },
      }).visit(actual.program);
    }
    expect(executor).toBeDefined();
    if (executor === undefined) {
      return;
    }
    const environment: NativeSqlProofEnvironment = {
      coreDatabaseDirectory: `${coreDb}/`,
      modules,
      resolveImport: (file, specifier) => {
        if (specifier === '@effect/sql-pg') {
          return { kind: 'native-pg-root' };
        }
        if (specifier === 'drizzle-orm/effect-postgres') {
          return { kind: 'native-drizzle-effect' };
        }
        if (specifier === 'effect') {
          return { kind: 'native-effect' };
        }
        const target = nodePath.resolve(nodePath.dirname(file), specifier);
        return modules.some((candidate) => candidate.file === target) ? { file: target, kind: 'module' } : undefined;
      },
      resolveValue: (reference) => resolver.resolveNativeSqlSource(reference),
    };
    const descriptor = describeNativeSqlDatabase(environment, { expression: executor, file: clientFile });
    if (name === 'actual constructor') {
      expect(descriptor).toBeDefined();
    } else {
      expect(descriptor).toBeUndefined();
    }
  }).pipe(Effect.provide(Path.layer)),
);

/*
 * Security fence: guarded Core pool. Owner code gets none of the fence's shortcuts: a Config success is not
 * effect-free data outside Core's pool configuration (inherited members, an arbitrary failure mapping), and the
 * native PgClient tag is a possible carrier outside Core's own tag positions.
 */
const guardedPoolOwnerHead =
  "import {Config,Context,Effect,Layer,Option} from 'effect';import {PgClient} from '@effect/sql-pg';import {Factory} from '../shared/port.ts';export const use=transaction=>Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction});});";
const guardedPoolOwnerConsumer = (body: string) =>
  `${guardedPoolOwnerHead}export const run=Effect.gen(function*(){${body}});`;
it.effect.each([
  [
    'Object.prototype smuggled through a Config.all success',
    "const cfg=yield* Config.all({a:Config.String('A')});Object.prototype.leak=use({});return yield* foreignSink(cfg.leak);",
  ],
  [
    'String.prototype smuggled through a Config.String success member',
    "const cfg=yield* Config.all({a:Config.String('A')});String.prototype.leak=use({});return yield* foreignSink(cfg.a.leak);",
  ],
  [
    'read mapped into a Config failure',
    "const cfg=yield* Config.all({a:Config.String('A')}).pipe(Effect.mapError(()=>use({})));return yield* foreignSink(cfg);",
  ],
  [
    'getter installed on a Config success prototype',
    "const cfg=yield* Config.all({a:Config.String('A')});const holder=[use({})];Object.setPrototypeOf(cfg,{get leak(){return holder[0];}});return yield* foreignSink(cfg.leak);",
  ],
  ['PgClient tag handed to an unknown sink', 'return yield* foreignSink(PgClient.PgClient);'],
  ['raw PgClient read and handed out', 'const pg=yield* PgClient.PgClient;return yield* foreignSink(pg);'],
  [
    'PgClient swapped through Context.make',
    'return yield* use({}).pipe(Effect.provideContext(Context.make(PgClient.PgClient,forgedClient)));',
  ],
  [
    'read smuggled through a provided PgClient service',
    'const inner=Effect.gen(function*(){const pg=yield* PgClient.PgClient;return yield* foreignSink(pg.smuggle);});return yield* inner.pipe(Effect.provideService(PgClient.PgClient,{smuggle:use({})}));',
  ],
  [
    'read smuggled through a PgClient Context.make',
    'const inner=Effect.gen(function*(){const pg=yield* PgClient.PgClient;return yield* foreignSink(pg.smuggle);});return yield* inner.pipe(Effect.provideContext(Context.make(PgClient.PgClient,{smuggle:use({})})));',
  ],
])('keeps the guarded Core pool shortcuts out of owner code: %s', ([, body]) => {
  const snapshot = sources();
  snapshot.set(consumerFile, guardedPoolOwnerConsumer(body));
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

/** A guard-module file name, at Core's own path or as a path suffix, never exempts owner-shaped code. */
const guardModuleImpostors = {
  'forged factory layer':
    'export const wrap=(effect)=>Effect.provide(effect,Layer.succeed(Factory,{make:input=>input.transaction}));',
  'forged factory through Reflect.apply':
    'export const wrap=(effect)=>Reflect.apply(Effect.provide,undefined,[effect,Layer.succeed(Factory,{make:input=>input.transaction})]);',
  'unknown sink': 'export const wrap=(effect)=>foreignSink(effect);',
} as const;
const relativeImport = (from: string, to: string) => {
  const path = nodePath.relative(nodePath.dirname(from), to);
  return path.startsWith('.') ? path : `./${path}`;
};
it.effect.each(
  [
    'packages/core-runtime/src/db/transaction-io-guard.ts',
    'verticals/owner/packages/core-runtime/src/db/transaction-io-guard.ts',
  ].flatMap((file) =>
    Object.entries(guardModuleImpostors).map(([variant, source]) => [file, variant, source] as const),
  ),
)('does not exempt owner code named like a Core guard module: %s, %s', ([file, , source]) => {
  const snapshot = sources();
  const guard = `${root}/${file}`;
  snapshot.set(
    guard,
    `import {Context,Effect,Layer} from 'effect';import {Factory} from '${relativeImport(guard, tagFile)}';${source}`,
  );
  snapshot.set(
    consumerFile,
    `import {Effect} from 'effect';import {Factory} from '../shared/port.ts';import {wrap} from '${relativeImport(consumerFile, guard)}';export const use=transaction=>Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction});});export const run=wrap(use({}));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

it.effect('retains native error evaluator payload success as a real success alternative', () => {
  class PayloadError extends Data.TaggedError('PayloadError')<{ readonly reason: string }> {}
  const payload = {
    '~effect/Effect/evaluate': () => Effect.succeed('unexpected success'),
    reason: 'failed validation',
  };
  return Effect.gen(function* nativeErrorPayload() {
    return yield* new PayloadError(payload);
  }).pipe(Effect.map((value) => expect(value).toBe('unexpected success')));
});

const reachedHelperIdentity = 'reached helper identity';
const reachedDeferredOverride = 'reached helper deferred override';
const sqlRootConfigSource = (source: string, name: string, variant: string): string => {
  if (name !== 'config') {
    return source;
  }
  if (variant === 'fake Schema') {
    return `${source.replace(', Schema }', ' }')}\nimport {Schema} from 'foreign';`;
  }
  if (variant === 'foreign pipe') {
    return source.replace('Schema.check(Schema.isMinLength(1))', 'foreignTransform');
  }
  return variant === 'changed native Schema' ? `${source}\nSchema.check=foreignTransform;` : source;
};

it.effect.each([
  'native',
  'cycle',
  'fake Schema',
  'foreign pipe',
  'changed native Schema',
  'reached getter',
  reachedHelperIdentity,
  'reached helper override',
  reachedDeferredOverride,
])('keeps the same SQL acquisition AST root-scoped: %s', (variant) =>
  Effect.gen(function* actualSqlRoot() {
    const path = yield* Path.Path;
    const app = nodePath.resolve(import.meta.dirname, '../..');
    const clientFile = nodePath.join(app, 'packages/core-runtime/src/db/client.ts');
    const secondConsumer = `${root}/verticals/other/src/consumer.ts`;
    const secondRoot = `${root}/verticals/other/api/index.ts`;
    const shared = `${root}/packages/acquire.ts`;
    const relativeClient = nodePath.relative(nodePath.dirname(rootFile), clientFile);
    const snapshot = sources();
    for (const name of ['client', 'pool-configuration', 'connection-error', 'config', ...coreDatabaseGuardFiles]) {
      const file = nodePath.join(app, `packages/core-runtime/src/db/${name}.ts`);
      const source = yield* Effect.tryPromise(() => readFile(file, 'utf-8'));
      snapshot.set(file, sqlRootConfigSource(source, name, variant));
    }
    const acquisition = 'Effect.gen(function*(){return yield* CoreDatabase})';
    const helper = variant.startsWith('reached helper');
    const deferred = variant === reachedDeferredOverride;
    if (helper) {
      const override =
        "Effect.provideContext(effect,Context.makeUnsafe(new Map([['@app/core-runtime/db/client/CoreDatabase',{executor:'fake-driver'}]])))";
      const implementation = deferred
        ? `Effect.fn(function*(effect){return yield* ${override};})`
        : `effect=>${override}`;
      snapshot.set(
        `${root}/packages/wrap.ts`,
        variant === reachedHelperIdentity
          ? 'export const wrap=effect=>effect;'
          : `import {Effect,Context} from 'effect';export const wrap=${implementation};`,
      );
    }
    const wrapped = helper ? `${acquisition}.pipe(wrap)` : acquisition;
    const acquired =
      variant === 'reached getter' ? `({get database(){return foreignTransform(${acquisition});}}).database` : wrapped;
    const before = deferred ? `const raw=${acquisition};const run=wrap(raw);` : '';
    const program = deferred ? 'Effect.gen(function*(){return yield*run;})' : acquired;
    snapshot.set(
      shared,
      `import {Effect} from 'effect';${helper ? "import {wrap} from './wrap.ts';" : ''}import {CoreDatabase} from '${nodePath.relative(nodePath.dirname(shared), clientFile)}';${before}export const acquire=${program};`,
    );
    const composed = rootSource
      .replace("import { Layer } from 'effect';", "import {Effect,Layer} from 'effect';")
      .replace(
        "import {provider} from '../src/producer.ts';",
        `import {CoreDatabaseLive,CoreDatabase} from '${relativeClient}';import {DatabaseConfig} from '${relativeClient.replace('client.ts', 'config.ts')}';const fixtureConfig=Layer.succeed(DatabaseConfig,{connectionString:'postgres://unit:unit@localhost/unit',maxConnections:4});`,
      )
      .replace('Layer.provide(provider)', 'Layer.provide(CoreDatabaseLive.pipe(Layer.provide(fixtureConfig)))');
    snapshot.set(
      rootFile,
      variant === 'cycle'
        ? composed.replace(
            "Layer.succeed(DatabaseConfig,{connectionString:'postgres://unit:unit@localhost/unit',maxConnections:4})",
            'Layer.effect(DatabaseConfig,Effect.gen(function*(){return yield* CoreDatabase}))',
          )
        : composed,
    );
    snapshot.set(secondConsumer, consumerSource);
    snapshot.set(
      secondRoot,
      composed.replace(
        'Layer.provide(CoreDatabaseLive.pipe(Layer.provide(fixtureConfig)))',
        'Layer.provide(Layer.mergeAll(CoreDatabaseLive.pipe(Layer.provide(fixtureConfig)),Layer.succeed(CoreDatabase,{executor:foreignDatabase})))',
      ),
    );
    // Core is the real workspace's; the fixture owners sit under their own root.
    const resolver = makeScopedContextFactoryResolver(
      snapshot,
      root,
      path,
      new Map(),
      new Map(),
      snapshot,
      undefined,
      app,
    );
    let query: Expression | undefined;
    new Visitor({
      YieldExpression(node) {
        if (node.argument?.type === 'Identifier' && node.argument.name === 'CoreDatabase') {
          query = node;
        }
      },
    }).visit(parseSync(shared, snapshot.get(shared) ?? '').program);
    expect(query).toBeDefined();
    if (query === undefined) {
      return;
    }
    const native = resolver.resolveNativeSqlSource({ expression: query, file: shared }, { file: consumerFile });
    const overridden = resolver.resolveNativeSqlSource({ expression: query, file: shared }, { file: secondConsumer });
    if (variant === 'native' || variant === reachedHelperIdentity) {
      expect(native?.expression.type).toBe('ObjectExpression');
    } else {
      expect(native).toBeUndefined();
    }
    expect(overridden).toBeUndefined();
  }).pipe(Effect.provide(Path.layer)),
);

const organizationFactsProjection = 'authority.liveProof.organization';
it.effect.each([
  ['native String on organization facts', '', organizationFactsProjection, ''],
  ['shadowed String', 'const String=value=>use(transaction);', organizationFactsProjection, ''],
  ['fake imported String', "import {String} from 'foreign';", organizationFactsProjection, ''],
  ['replaced global String', '', organizationFactsProjection, 'globalThis.String=foreignTransform;'],
  [
    'replaced global String through alias',
    '',
    organizationFactsProjection,
    'const globalAlias=globalThis;globalAlias.String=foreignTransform;',
  ],
  [
    'reflective String replacement',
    '',
    organizationFactsProjection,
    "Object.defineProperty(globalThis,'String',{value:foreignTransform});",
  ],
  ['protected argument evaluation', '', organizationFactsProjection, 'const converted=String(use(transaction));'],
  ['protected getter evaluation', '', '{get partyRevision(){return use(transaction);}}', ''],
  ['protected toString coercion', '', '{partyRevision:{toString(){return use(transaction);}}}', ''],
  ['protected primitive coercion', '', '{partyRevision:{[Symbol.toPrimitive](){return use(transaction);}}}', ''],
  [
    'protected coercion after a safe helper invocation',
    '',
    organizationFactsProjection,
    'organizationSourceEligibility({partyRevision:1});organizationSourceEligibility({partyRevision:{toString(){return use(transaction);}}});',
  ],
  ['second protected argument', '', organizationFactsProjection, 'const converted=String(0,use(transaction));'],
  ['spread protected argument', '', organizationFactsProjection, 'const converted=String(...[use(transaction)]);'],
])(
  'retains execution while proving only native String success as primitive: %s',
  ([variant, prefix, organization, extra]) => {
    const snapshot = sources();
    snapshot.set(
      consumerFile,
      `${consumerSource}${prefix}const organizationSourceEligibility=org=>({partyResourceRevision:String(org.partyRevision)});const projected=foreignTransform(organizationSourceEligibility(${organization}));${extra}`,
    );
    return resolve(snapshot).pipe(
      Effect.map((result) => {
        if (variant === 'native String on organization facts') {
          expect(result).toHaveLength(1);
        } else {
          expect(result).toBeUndefined();
        }
        return result;
      }),
    );
  },
);

const nativeStructFieldsCase = 'native Struct fields';
const ordinaryOwnFieldsCase = 'ordinary own fields DTO';
const nativeStringStruct = 'Schema.Struct({externalSubject:Schema.String})';
const fakeSchemaProducer = 'fake producer';
const ordinarySchemaDto = '{fields:{}}';
const ownerPackageManifest = '{"name":"@app/owner"}';
it.effect.each([
  [nativeStructFieldsCase, nativeStringStruct, ''],
  [ordinaryOwnFieldsCase, '{fields:{externalSubject:Schema.String}}', ''],
  ['getter fields', '{get fields(){return {externalSubject:Schema.String};}}', ''],
  ['unknown spread', 'Schema.Struct({...foreignFields})', ''],
  ['protected Effect field', 'Schema.Struct({externalSubject:Effect.gen(function*(){return yield*Factory;})})', ''],
  ['mutated fields', nativeStringStruct, 'ExternalUserSubjectSchema.fields.externalSubject=foreign;'],
  ['escaped fields', nativeStringStruct, 'foreignTransform(ExternalUserSubjectSchema.fields);'],
  ['foreign Struct', 'ForeignSchema.Struct({externalSubject:Schema.String})', ''],
  ['mutated String', nativeStringStruct, 'Schema.String=foreign;'],
])('borrows only genuine proven Struct fields as readonly schema metadata: %s', ([variant, initializer, mutation]) => {
  const snapshot = sources();
  const schemaFile = `${owner}/shared/struct-fields.ts`;
  snapshot.set(`${owner}/package.json`, ownerPackageManifest);
  snapshot.set(
    schemaFile,
    `import {Schema,Effect} from 'effect';import {Factory} from './port.ts';import {Schema as ForeignSchema} from 'foreign';export const ExternalUserSubjectSchema=${initializer};export const VerifyExternalAuthenticationRequestSchema=Schema.Struct({...ExternalUserSubjectSchema.fields,nonce:Schema.String});${mutation}`,
  );
  snapshot.set(
    consumerFile,
    `${consumerSource}import {Schema} from 'effect';import {VerifyExternalAuthenticationRequestSchema} from '../shared/struct-fields.ts';const equivalent=Schema.toEquivalence(VerifyExternalAuthenticationRequestSchema);`,
  );
  return Effect.gen(function* schemaFieldsWitness() {
    const path = yield* Path.Path;
    const resolver = makeScopedContextFactoryResolver(snapshot, root, path, new Map());
    let schema: Expression | undefined;
    new Visitor({
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'toEquivalence'
        ) {
          const [argument] = node.arguments;
          if (argument?.type !== 'SpreadElement') {
            schema = argument;
          }
        }
      },
    }).visit(parseSync(consumerFile, snapshot.get(consumerFile) ?? '').program);
    expect(schema).toBeDefined();
    if (schema === undefined) {
      return;
    }
    expect(resolver.isServiceFreeSchema({ expression: schema, file: consumerFile })).toBe(
      [nativeStructFieldsCase, ordinaryOwnFieldsCase].includes(variant ?? ''),
    );
    if ([nativeStructFieldsCase, ordinaryOwnFieldsCase].includes(variant ?? '')) {
      expect(yield* resolve(snapshot)).toHaveLength(1);
    }
  }).pipe(Effect.provide(Path.layer));
});

const equivalenceSchemaExport = 'VerifyExternalAuthenticationRequestSchema';
it.effect.each([
  'native Struct',
  fakeSchemaProducer,
  'foreign Schema',
  'mutated Schema',
  'mutated optionalKey',
  'fake optionalKey schema',
  'foreign optionalKey',
  'protected optionalKey schema',
  'protected Effect transform',
])('keeps native schema equivalence as a readonly proven-schema borrower: %s', (variant) => {
  const snapshot = sources();
  const schemaFile = `${owner}/shared/equivalence-schema.ts`;
  snapshot.set(`${owner}/package.json`, ownerPackageManifest);
  const struct =
    'Schema.Struct({...ExternalUserSubjectSchema.fields,enrollmentAttemptId:Schema.optionalKey(EnrollmentAttemptIdSchema),nonce:uuid,sessionRef:CommerceSessionReferenceSchema,tenantId:TenantIdSchema})';
  snapshot.set(
    schemaFile,
    `import {Schema} from 'effect';export const ExternalUserSubjectSchema=Schema.Struct({externalSubject:Schema.String});export const EnrollmentAttemptIdSchema=Schema.String;const uuid=Schema.String;const CommerceSessionReferenceSchema=Schema.String;const TenantIdSchema=Schema.String;export const ${equivalenceSchemaExport}=${variant === fakeSchemaProducer ? ordinarySchemaDto : struct};`,
  );
  const schemaSource = variant === 'foreign Schema' ? 'foreign' : 'effect';
  const prefix = `import {Schema} from '${schemaSource}';import {${equivalenceSchemaExport}} from '../shared/equivalence-schema.ts';`;
  const equivalence = `Schema.toEquivalence(${equivalenceSchemaExport})`;
  let source = `${consumerSource}${prefix}const equivalent=${equivalence};`;
  if (variant === 'fake optionalKey schema') {
    snapshot.set(
      schemaFile,
      (snapshot.get(schemaFile) ?? '').replace(
        'export const EnrollmentAttemptIdSchema=Schema.String;',
        'export const EnrollmentAttemptIdSchema={fields:{}};',
      ),
    );
  }
  if (variant === 'foreign optionalKey') {
    snapshot.set(
      schemaFile,
      `import {Schema as ForeignSchema} from 'foreign';${snapshot.get(schemaFile) ?? ''}`.replace(
        'Schema.optionalKey(',
        'ForeignSchema.optionalKey(',
      ),
    );
  }
  if (variant === 'protected optionalKey schema') {
    snapshot.set(
      schemaFile,
      `import {Effect} from 'effect';import {Factory} from './port.ts';${snapshot.get(schemaFile) ?? ''}`.replace(
        'export const EnrollmentAttemptIdSchema=Schema.String;',
        'export const EnrollmentAttemptIdSchema=Effect.gen(function*(){return yield*Factory;});',
      ),
    );
  }
  if (variant === 'mutated optionalKey') {
    snapshot.set(schemaFile, `${snapshot.get(schemaFile)}Schema.optionalKey=foreignTransform;`);
  }
  if (variant === 'mutated Schema') {
    source += 'Schema.toEquivalence=foreignTransform;';
  }
  if (variant === 'protected Effect transform') {
    source = `${prefix}import {Effect} from 'effect';import {Factory} from '../shared/port.ts';export const use=Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction});}).pipe(${equivalence});`;
  }
  snapshot.set(consumerFile, source);
  return Effect.gen(function* schemaEquivalenceWitness() {
    const path = yield* Path.Path;
    const resolver = makeScopedContextFactoryResolver(snapshot, root, path, new Map());
    if (variant === fakeSchemaProducer) {
      let schema: Expression | undefined;
      new Visitor({
        CallExpression(node) {
          if (
            node.callee.type === 'MemberExpression' &&
            node.callee.property.type === 'Identifier' &&
            node.callee.property.name === 'toEquivalence'
          ) {
            const [argument] = node.arguments;
            if (argument?.type !== 'SpreadElement') {
              schema = argument;
            }
          }
        },
      }).visit(parseSync(consumerFile, source).program);
      expect(schema).toBeDefined();
      if (schema !== undefined) {
        expect(resolver.isServiceFreeSchema({ expression: schema, file: consumerFile })).toBe(false);
      }
      // An unused ordinary DTO cannot replace services, even though it is not a schema.
      expect(yield* resolve(snapshot)).toHaveLength(1);
    } else if (variant === 'native Struct') {
      expect(yield* resolve(snapshot)).toHaveLength(1);
    } else {
      expect(yield* resolve(snapshot)).toBeUndefined();
    }
  }).pipe(Effect.provide(Path.layer));
});

const nativeDecodeEffect = `Schema.decodeEffect(${equivalenceSchemaExport},{onExcessProperty:'error'})`;
const decodeSchemaStruct = 'Schema.Struct({...ExternalUserSubjectSchema.fields,nonce:Schema.String})';
const verificationFile = `${owner}/api/verification.ts`;
const decodeEffectSources = () => {
  const snapshot = sources();
  snapshot.set(`${owner}/package.json`, ownerPackageManifest);
  snapshot.set(
    `${owner}/shared/decode-schema.ts`,
    `import {Schema} from 'effect';export const ExternalUserSubjectSchema=${nativeStringStruct};export const ${equivalenceSchemaExport}=${decodeSchemaStruct};`,
  );
  snapshot.set(
    verificationFile,
    `import {Schema} from 'effect';import {${equivalenceSchemaExport}} from '../shared/decode-schema.ts';export const decode=input=>${nativeDecodeEffect}(input);`,
  );
  snapshot.set(
    rootFile,
    `${rootSource}import {decode} from './verification.ts';import {Schema} from 'effect';import {${equivalenceSchemaExport}} from '../shared/decode-schema.ts';const equivalent=Schema.toEquivalence(${equivalenceSchemaExport});`,
  );
  return snapshot;
};
const equivalenceSchemaRequest = (snapshot: ReadonlyMap<string, string>, file = rootFile) => {
  let schema: Expression | undefined;
  new Visitor({
    CallExpression(node) {
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === 'toEquivalence'
      ) {
        const [argument] = node.arguments;
        if (argument?.type !== 'SpreadElement') {
          schema = argument;
        }
      }
    },
  }).visit(parseSync(file, snapshot.get(file) ?? '').program);
  expect(schema).toBeDefined();
  return schema === undefined ? undefined : { expression: schema, file };
};
const decodeEffectSchemaWitness = (snapshot: ReadonlyMap<string, string>) =>
  Effect.gen(function* decodedSchemaWitness() {
    const path = yield* Path.Path;
    const resolver = makeScopedContextFactoryResolver(snapshot, root, path, new Map());
    const request = equivalenceSchemaRequest(snapshot);
    return request !== undefined && resolver.isServiceFreeSchema(request);
  }).pipe(Effect.provide(Path.layer));
it.effect('retains the actual native decodeEffect schema borrower with plain verification options', () =>
  decodeEffectSchemaWitness(decodeEffectSources()).pipe(Effect.map((result) => expect(result).toBe(true))),
);
const comparatorProviderInstallation = 'provider,callerLive,verifierLive)';
const comparatorOptionalProvision = 'Layer.provide(callerLive));';
const authorizationComparatorSources = (variant: string) => {
  const snapshot = decodeEffectSources();
  snapshot.set(
    `${owner}/shared/comparator-caller.ts`,
    `import {Context} from 'effect';export class Caller extends Context.Service<Caller,{}>()('caller'){}export class AuthorizedRequest extends Context.Service<AuthorizedRequest,{}>()('authorized-request'){}`,
  );
  snapshot.set(
    verificationFile,
    `import {Effect,Schema} from 'effect';import {Caller} from '../shared/comparator-caller.ts';import {${equivalenceSchemaExport}} from '../shared/decode-schema.ts';export const verify=Effect.fn('verify')(function*(input){const request=yield*Schema.decodeEffect(${equivalenceSchemaExport},{onExcessProperty:'error'})(input);const caller=yield*Caller;return yield*caller.authorize({operation:'verify',...request});});`,
  );
  snapshot.set(
    rootFile,
    (snapshot.get(rootFile) ?? '').replace(
      "import {decode} from './verification.ts';",
      "import {verify} from './verification.ts';",
    ),
  );
  const comparatorSchema = `Schema.Struct({authenticationNamespaceId:Schema.Literal('namespace'),providerSubjectId:ProviderSubjectIdSchema,subjectType:Schema.Literal('user'),enrollmentAttemptId:Schema.optionalKey(EnrollmentAttemptIdSchema),nonce:uuid,sessionRef:SessionReferenceSchema,tenantId:uuid})`;
  snapshot.set(
    `${owner}/shared/decode-schema.ts`,
    `import {Schema} from 'effect';const uuid=Schema.String.check(Schema.isUUID());const EnrollmentAttemptIdSchema=uuid.pipe(Schema.brand('EnrollmentAttemptId'));const ProviderSubjectIdSchema=Schema.String.check(Schema.isMinLength(1));const SessionReferenceSchema=Schema.String.check(Schema.isMinLength(1));export const ${equivalenceSchemaExport}=${comparatorSchema};`,
  );
  const comparisonInput =
    variant === 'getter'
      ? `{authenticationNamespaceId:'namespace',providerSubjectId:'subject',subjectType:'user',sessionRef:'session',tenantId:'tenant',get nonce(){Effect.runSync(use({}).pipe(Effect.provide(provider)));return 'nonce';}}`
      : 'input';
  const declaration = `import {Effect,Option} from 'effect';import {use} from '../src/consumer.ts';import {Caller,AuthorizedRequest} from '../shared/comparator-caller.ts';const providerRequest=request=>{const base={authenticationNamespaceId:request.authenticationNamespaceId,providerSubjectId:request.providerSubjectId,subjectType:request.subjectType,nonce:request.nonce,sessionRef:request.sessionRef,tenantId:request.tenantId};return request.enrollmentAttemptId===undefined?base:{...base,enrollmentAttemptId:request.enrollmentAttemptId};};const sameProviderRequest=Schema.toEquivalence(${equivalenceSchemaExport});const callerLive=Layer.succeed(Caller,{authorize:Effect.fn('authorize')(function*(input){const authorized=yield*Effect.serviceOption(AuthorizedRequest);if(Option.isNone(authorized))return false;return sameProviderRequest(${comparisonInput},providerRequest(authorized.value.request));})});const plainRequest=Object.freeze({authenticationNamespaceId:'namespace',providerSubjectId:'subject',subjectType:'user',nonce:'123e4567-e89b-42d3-a456-426614174000',sessionRef:'session',tenantId:'123e4567-e89b-42d3-a456-426614174001'});const verificationAttempt=verify(plainRequest).pipe(Effect.provideService(AuthorizedRequest,{request:Object.freeze({...plainRequest})}));`;
  snapshot.set(
    rootFile,
    `${declaration}${snapshot.get(rootFile) ?? ''}`.replace(
      provideProvider,
      'Layer.provide(Layer.mergeAll(provider,callerLive))',
    ),
  );
  if (variant === 'annotation') {
    const file = `${owner}/shared/decode-schema.ts`;
    snapshot.set(
      file,
      `import {Effect} from 'effect';import {use} from '../src/consumer.ts';import {provider} from '../src/producer.ts';${snapshot.get(file) ?? ''}`.replace(
        comparatorSchema,
        `${comparatorSchema}.annotate({toEquivalence:()=>()=>{Effect.runSync(use({}).pipe(Effect.provide(provider)));return true;}})`,
      ),
    );
  }
  if (variant === 'member' || variant.startsWith('member ') || variant.startsWith('optional')) {
    const tags = `${owner}/shared/comparator-caller.ts`;
    snapshot.set(
      tags,
      `${snapshot.get(tags) ?? ''}export class Verifier extends Context.Service<Verifier,{}>()('verifier'){}`,
    );
    snapshot.set(
      verificationFile,
      `import {Effect,Layer,Schema} from 'effect';import {Caller,Verifier} from '../shared/comparator-caller.ts';import {${equivalenceSchemaExport}} from '../shared/decode-schema.ts';const makeVerifier=Effect.fn('makeVerifier')(function*(){const caller=yield*Caller;const verify=Effect.fn('verify')(function*(input){const request=yield*Schema.decodeEffect(${equivalenceSchemaExport},{onExcessProperty:'error'})(input);return yield*caller.authorize({operation:'verify',...request});});return {verify};});export const verifierLive=Layer.effect(Verifier,Effect.gen(function*(){return yield*makeVerifier();}));`,
    );
    snapshot.set(
      rootFile,
      (snapshot.get(rootFile) ?? '')
        .replace('{Caller,AuthorizedRequest}', '{Caller,AuthorizedRequest,Verifier}')
        .replace("import {verify} from './verification.ts';", "import {verifierLive} from './verification.ts';")
        .replace('provider,callerLive)', comparatorProviderInstallation)
        .replace(
          'verify(plainRequest).pipe(',
          'Effect.gen(function*(){const verifier=yield*Verifier;return yield*verifier.verify(plainRequest).pipe(',
        )
        .replace('request:Object.freeze({...plainRequest})}));', 'request:Object.freeze({...plainRequest})}));});'),
    );
  }
  if (variant.startsWith('optional')) {
    snapshot.set(
      rootFile,
      `${(snapshot.get(rootFile) ?? '').replace(comparatorProviderInstallation, 'provider)')}export const optionalVerifierLive=verifierLive.pipe(Layer.provide(callerLive));`,
    );
  }
  snapshot.set(
    verificationFile,
    `import {use} from '../src/consumer.ts';import {provider} from '../src/producer.ts';${snapshot.get(verificationFile) ?? ''}`,
  );
  return snapshot;
};
const comparatorRequestValue = 'request:Object.freeze({...plainRequest})';
const comparatorProvidedRequest = 'request:Object.freeze({...plainRequest})}));';
const comparatorDecodedInput = "{operation:'verify',...request}";
const comparatorVerifierAcquisition = 'const verifier=yield*Verifier;';
const comparatorProjectionStart = 'providerRequest=request=>{const base=';
const comparatorRefusals = [
  ['optional wrong caller tag', rootFile, 'Layer.succeed(Caller,', 'Layer.succeed(Verifier,'],
  [
    'optional duplicate caller',
    rootFile,
    comparatorOptionalProvision,
    'Layer.provide(Layer.mergeAll(callerLive,Layer.succeed(Caller,{authorize:replacement}))));',
  ],
  [
    'optional overriding caller',
    rootFile,
    comparatorOptionalProvision,
    'Layer.provide(callerLive),Layer.provide(Layer.succeed(Caller,{authorize:replacement})));',
  ],
  ['optional direct receiver', rootFile, comparatorVerifierAcquisition, 'const verifier={verify};'],
  ['optional wrong verifier tag', verificationFile, 'Layer.effect(Verifier,', 'Layer.effect(Caller,'],
  [
    'optional overriding verifier',
    rootFile,
    comparatorOptionalProvision,
    'Layer.provide(Layer.mergeAll(callerLive,Layer.succeed(Verifier,{verify:replacement}))));',
  ],
  [
    'optional opaque subtree',
    rootFile,
    'optionalVerifierLive=verifierLive.pipe(',
    'optionalVerifierLive=unknownVerifierLive.pipe(',
  ],
  [
    'array projection parameter alias',
    rootFile,
    comparatorProjectionStart,
    "providerRequest=request=>{const held=[request];held[0].nonce='replacement';const base=",
  ],
  [
    'array projection parameter escape',
    rootFile,
    comparatorProjectionStart,
    'providerRequest=request=>{stash=[request];const base=',
  ],
  [
    'computed projection parameter alias',
    rootFile,
    comparatorProjectionStart,
    "providerRequest=request=>{const held={['record']:request};held.record.nonce='replacement';const base=",
  ],
  [
    'reassigned projection parameter',
    rootFile,
    comparatorProjectionStart,
    "providerRequest=request=>{request={authenticationNamespaceId:'namespace',providerSubjectId:'subject',subjectType:'user',get nonce(){counter++;return '123e4567-e89b-42d3-a456-426614174000';},sessionRef:'session',tenantId:'123e4567-e89b-42d3-a456-426614174001'};const base=",
  ],
  [
    'mutated projection parameter',
    rootFile,
    comparatorProjectionStart,
    "providerRequest=request=>{request.nonce='replacement';const base=",
  ],
  [
    'escaped projection parameter',
    rootFile,
    comparatorProjectionStart,
    'providerRequest=request=>{stash=request;const base=',
  ],
  ['fake caller port', rootFile, 'Layer.succeed(Caller,', 'counterfeit.succeed(Caller,'],
  [
    'caller override',
    rootFile,
    'provider,callerLive)',
    'provider,callerLive,Layer.succeed(Caller,{authorize:replacement}))',
  ],
  ['wrong provided tag', rootFile, 'Effect.provideService(AuthorizedRequest,', 'Effect.provideService(Caller,'],
  [
    'duplicate provided tag',
    rootFile,
    comparatorProvidedRequest,
    'request:Object.freeze({...plainRequest})}),Effect.provideService(AuthorizedRequest,{request:plainRequest}));',
  ],
  [
    'context override',
    rootFile,
    comparatorProvidedRequest,
    'request:Object.freeze({...plainRequest})}),Effect.provideContext(context));',
  ],
  [
    'services override',
    rootFile,
    comparatorProvidedRequest,
    'request:Object.freeze({...plainRequest})}),Effect.provideServices(context));',
  ],
  [
    'provided getter',
    rootFile,
    comparatorRequestValue,
    'get request(){Effect.runSync(use({}).pipe(Effect.provide(provider)));return plainRequest;}',
  ],
  [
    'authorized mutation',
    rootFile,
    'if(Option.isNone(authorized))return false;',
    "if(Option.isNone(authorized))return false;Object.defineProperty(authorized.value.request,'nonce',{get(){Effect.runSync(use({}).pipe(Effect.provide(provider)));return 'nonce';}});",
  ],
  [
    'authorized escape',
    rootFile,
    'if(Option.isNone(authorized))return false;',
    'if(Option.isNone(authorized))return false;mutate(authorized.value.request);',
  ],
  [
    'decoded computed key',
    verificationFile,
    comparatorDecodedInput,
    "{operation:'verify',...request,[Effect.runSync(use({}).pipe(Effect.provide(provider)))]:true}",
  ],
  [
    'decoded prototype',
    verificationFile,
    comparatorDecodedInput,
    "{operation:'verify',...request,__proto__:{get nonce(){Effect.runSync(use({}).pipe(Effect.provide(provider)));return 'nonce';}}}",
  ],
  [
    'decoded mutation',
    verificationFile,
    'const caller=yield*Caller;',
    "Object.defineProperty(request,'nonce',{get(){Effect.runSync(use({}).pipe(Effect.provide(provider)));return 'nonce';}});const caller=yield*Caller;",
  ],
  [
    'input acquisition',
    rootFile,
    'verify(plainRequest).pipe(',
    'verify((()=>{Effect.runSync(use({}).pipe(Effect.provide(provider)));return plainRequest;})()).pipe(',
  ],
  [
    'authorize spread',
    verificationFile,
    "caller.authorize({operation:'verify',...request})",
    "caller.authorize(...[{operation:'verify',...request}])",
  ],
  ['member fake provider', verificationFile, 'Layer.effect(Verifier,', 'counterfeit.effect(Verifier,'],
  [
    'member override',
    rootFile,
    comparatorProviderInstallation,
    'provider,callerLive,verifierLive,Layer.succeed(Verifier,{verify:replacement}))',
  ],
  [
    'member receiver mutation',
    rootFile,
    comparatorVerifierAcquisition,
    'const verifier=yield*Verifier;verifier.verify=replacement;',
  ],
  [
    'member receiver escape',
    rootFile,
    comparatorVerifierAcquisition,
    'const verifier=yield*Verifier;mutate(verifier);',
  ],
  ['member wrong receiver', rootFile, comparatorVerifierAcquisition, 'const verifier=yield*Caller;'],
  ['member spread', rootFile, 'verifier.verify(plainRequest)', 'verifier.verify(...[plainRequest])'],
  [
    'provided spread getter',
    rootFile,
    comparatorRequestValue,
    "request:Object.freeze({...{get nonce(){Effect.runSync(use({}).pipe(Effect.provide(provider)));return 'nonce';}}})",
  ],
  [
    'imported comparator',
    rootFile,
    `const sameProviderRequest=Schema.toEquivalence(${equivalenceSchemaExport});`,
    "import {sameProviderRequest} from './comparison.ts';",
  ],
  [
    'member input acquisition',
    rootFile,
    'verifier.verify(plainRequest)',
    'verifier.verify((()=>{Effect.runSync(use({}).pipe(Effect.provide(provider)));return plainRequest;})())',
  ],
  [
    'member returned getter',
    verificationFile,
    'return {verify};',
    'return {get verify(){Effect.runSync(use({}).pipe(Effect.provide(provider)));return verify;}};',
  ],
  [
    'member replaced method',
    verificationFile,
    'return {verify};',
    'const service={verify};service.verify=replacement;return service;',
  ],
  [
    'member provided override',
    rootFile,
    'verifier.verify(plainRequest).pipe(',
    'verifier.verify(plainRequest).pipe(Effect.provideService(Verifier,{verify:replacement}),',
  ],
  ['direct verifier escape', rootFile, 'const verificationAttempt=', 'consume(verify);const verificationAttempt='],
  ['member direct provider', rootFile, 'const verifier=yield*Verifier;', 'const verifier={verify};'],
] as const;
it.effect.each([
  'native',
  'member',
  'optional',
  'optional foreign root',
  'optional captured mismatch',
  'annotation',
  'getter',
  ...comparatorRefusals.map(([name]) => name),
])('keeps the actual authorization comparator bounded to its schema and argument origins: %s', (variant) => {
  const snapshot = authorizationComparatorSources(variant);
  if (variant === 'optional foreign root') {
    const source = snapshot.get(rootFile) ?? '';
    snapshot.set(
      `${root}/verticals/other/api/index.ts`,
      `import {Layer} from 'effect';import {verifierLive} from '../../owner/api/verification.ts';import {callerLive} from '../../owner/api/index.ts';export const optionalVerifierLive=verifierLive.pipe(Layer.provide(callerLive));`,
    );
    snapshot.set(
      rootFile,
      source.replace(
        'export const optionalVerifierLive=verifierLive.pipe(Layer.provide(callerLive));',
        "export {optionalVerifierLive} from '../../other/api/index.ts';",
      ),
    );
  }
  if (variant === 'optional captured mismatch') {
    snapshot.set(
      rootFile,
      (snapshot.get(rootFile) ?? '')
        .replace('const callerLive=Layer.succeed(Caller,', 'const makeCaller=captured=>Layer.succeed(Caller,')
        .replace(
          comparatorOptionalProvision,
          "Layer.provide(makeCaller('first')));export const otherOptionalVerifierLive=verifierLive.pipe(Layer.provide(makeCaller('second')));",
        ),
    );
  }
  if (variant === 'imported comparator') {
    snapshot.set(
      `${owner}/api/comparison.ts`,
      `import {Schema} from 'effect';import {${equivalenceSchemaExport}} from '../shared/decode-schema.ts';export const sameProviderRequest=Schema.toEquivalence(${equivalenceSchemaExport});`,
    );
  }
  const mutation = comparatorRefusals.find(([name]) => name === variant);
  if (mutation !== undefined) {
    const [, file, before, after] = mutation;
    const source = snapshot.get(file) ?? '';
    expect(source).toContain(before);
    snapshot.set(file, source.replace(before, after));
  }
  return resolve(snapshot).pipe(
    Effect.map((result) => {
      if (variant === 'native' || variant === 'member' || variant === 'optional') {
        expect(result).toHaveLength(1);
      } else {
        expect(result).toBeUndefined();
      }
      return result;
    }),
  );
});
it.effect.each([
  ['frozen opaque snapshot', 'request:Object.freeze({...unknownRequest})', true],
  ['unfrozen opaque snapshot', 'request:{...unknownRequest}', false],
  ['frozen opaque producer', 'request:Object.freeze({...unknownTransform(plainRequest)})', true],
  [
    'object Equal field opposite decoded primitive',
    "request:Object.freeze({...{nonce:{[Symbol.for('effect/Equal')](){return true;}}}})",
    true,
  ],
  ['protected eager producer', 'request:Object.freeze({...unknownTransform(use({}))})', false],
  [
    'protected spread getter',
    "request:Object.freeze({...{get nonce(){Effect.runSync(use({}).pipe(Effect.provide(provider)));return 'nonce';}}})",
    false,
  ],
  [
    'protected proxy getter',
    'request:Object.freeze({...new Proxy(plainRequest,{get(target,key){Effect.runSync(use({}).pipe(Effect.provide(provider)));return target[key];}})})',
    false,
  ],
  [
    'protected returned getter',
    "request:Object.freeze({...(()=>({get nonce(){Effect.runSync(use({}).pipe(Effect.provide(provider)));return 'nonce';}}))()})",
    false,
  ],
  [
    'protected Equal field hook',
    "request:Object.freeze({...{nonce:{[Symbol.for('effect/Equal')](){Effect.runSync(use({}).pipe(Effect.provide(provider)));return true;}}}})",
    false,
  ],
] as const)(
  'proves frozen comparator snapshot data while retaining eager source checks: %s',
  ([_name, request, allowed]) => {
    const snapshot = authorizationComparatorSources('native');
    snapshot.set(rootFile, (snapshot.get(rootFile) ?? '').replace(comparatorRequestValue, request));
    return resolve(snapshot).pipe(Effect.map((result) => expect(result !== undefined).toBe(allowed)));
  },
);

const readonlyRequestBorrower = 'request=>request.nonce';
const borrowDecodedRequest = 'borrow(request)';
it.effect.each([
  ['readonly scalar fields', readonlyRequestBorrower, borrowDecodedRequest, true],
  ['readonly scalar alias', 'request=>{const nonce=request.nonce;return nonce;}', borrowDecodedRequest, true],
  ['whole record alias', 'request=>{const held=request;return held.nonce;}', borrowDecodedRequest, false],
  ['reassigned record', "request=>{request={nonce:'replacement'};return request.nonce;}", borrowDecodedRequest, false],
  ['record mutation', "request=>{request.nonce='replacement';return true;}", borrowDecodedRequest, false],
  ['whole record return', 'request=>request', borrowDecodedRequest, false],
  ['array capture', 'request=>{const held=[request];return held[0].nonce;}', borrowDecodedRequest, false],
  ['nested capture', 'request=>()=>request.nonce', borrowDecodedRequest, false],
  [
    'ordinary arguments mutation',
    "function(request){arguments[0].nonce='replacement';return request.nonce;}",
    borrowDecodedRequest,
    false,
  ],
  [
    'nested ordinary arguments capture',
    "function(request){const mutate=()=>{arguments[0].nonce='replacement';};mutate();return request.nonce;}",
    borrowDecodedRequest,
    false,
  ],
  ['computed read', "request=>request['nonce']", borrowDecodedRequest, false],
  ['async borrower', 'async request=>request.nonce', borrowDecodedRequest, false],
  ['generator borrower', 'function*(request){return request.nonce;}', borrowDecodedRequest, false],
  ['default formal', '(request={})=>request.nonce', borrowDecodedRequest, false],
  ['rest formal', '(...requests)=>requests[0].nonce', borrowDecodedRequest, false],
  ['optional call', readonlyRequestBorrower, 'borrow?.(request)', false],
  ['spread call', readonlyRequestBorrower, 'borrow(...[request])', false],
  ['repeated readonly argument', '(first,second)=>first.nonce===second.nonce', 'borrow(request,request)', true],
  [
    'repeated argument mutation',
    "(first,second)=>{second.nonce='replacement';return first.nonce;}",
    'borrow(request,request)',
    false,
  ],
])('keeps decoded comparator record borrowers readonly: %s', ([_name, borrower, invocation, allowed]) => {
  const snapshot = authorizationComparatorSources('native');
  const original = snapshot.get(verificationFile) ?? '';
  const borrowed = original.replace('const caller=yield*Caller;', `${invocation};const caller=yield*Caller;`);
  snapshot.set(verificationFile, `const borrow=${borrower};${borrowed}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result !== undefined).toBe(allowed)));
});
it.effect('keeps the actual authorization comparator optional subtree outside the mounted assembly', () => {
  const snapshot = authorizationComparatorSources('optional');
  return withResolver(snapshot, (resolver) => {
    const source = snapshot.get(rootFile) ?? '';
    let verification: Expression | undefined;
    new Visitor({
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'verifier' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'verify'
        ) {
          verification = node.callee;
        }
      },
    }).visit(parseSync(rootFile, source).program);
    const factory = callee(snapshot.get(consumerFile) ?? '');
    expect(factory).toBeDefined();
    expect(verification).toBeDefined();
    if (factory === undefined || verification === undefined) {
      return;
    }
    expect(resolver.resolve({ callee: factory, file: consumerFile })).toHaveLength(1);
    expect(resolver.resolve({ callee: verification, file: rootFile })).toBeUndefined();
    expect(resolver.resolve({ callee: factory, file: consumerFile })).toHaveLength(1);
  });
});
it.effect.each(['before', 'after'])(
  'retains the actual verifier beside an unrelated same-key caller %s it',
  (order) => {
    const snapshot = authorizationComparatorSources('optional');
    const tags = `${owner}/shared/comparator-caller.ts`;
    snapshot.set(
      tags,
      `${snapshot.get(tags) ?? ''}export class Unrelated extends Context.Service<Unrelated,{}>()('unrelated-verifier'){}`,
    );
    const unrelated =
      'const unrelatedAttempt=Effect.gen(function*(){const unrelated=yield*Unrelated;return yield*unrelated.verify(plainRequest);});';
    const source = (snapshot.get(rootFile) ?? '')
      .replace('{Caller,AuthorizedRequest,Verifier}', '{Caller,AuthorizedRequest,Verifier,Unrelated}')
      .replace('Layer.mergeAll(provider)', 'Layer.mergeAll(provider,unrelatedLive)');
    const ordered =
      order === 'before'
        ? source.replace('const verificationAttempt=', `${unrelated}const verificationAttempt=`)
        : `${source}${unrelated}`;
    snapshot.set(
      rootFile,
      `const unrelatedLive=Layer.succeed(Unrelated,{verify:input=>Effect.succeed(input)});${ordered}`,
    );
    return resolve(snapshot).pipe(Effect.map((result) => expect(result).toHaveLength(1)));
  },
);
it.effect('keeps the actual authorization comparator closed across another receiver root', () => {
  const snapshot = authorizationComparatorSources('member');
  const other = `${root}/verticals/other`;
  snapshot.set(
    `${other}/api/index.ts`,
    `import {Effect} from 'effect';import {Verifier,AuthorizedRequest} from '../../owner/shared/comparator-caller.ts';export const attempt=Effect.gen(function*(){const verifier=yield*Verifier;return yield*verifier.verify(input).pipe(Effect.provideService(AuthorizedRequest,{request:input}));});`,
  );
  snapshot.set(rootFile, `import '../../other/api/index.ts';${snapshot.get(rootFile) ?? ''}`);
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});
it.effect.each([
  [
    'foreign decoder',
    nativeDecodeEffect,
    nativeDecodeEffect.replace('Schema.decodeEffect', 'ForeignSchema.decodeEffect'),
  ],
  [
    'getter options',
    nativeDecodeEffect,
    `Schema.decodeEffect(${equivalenceSchemaExport},{get onExcessProperty(){return 'error';}})`,
  ],
  ['unknown options', nativeDecodeEffect, `Schema.decodeEffect(${equivalenceSchemaExport},foreignOptions)`],
  [
    'extra argument',
    nativeDecodeEffect,
    `Schema.decodeEffect(${equivalenceSchemaExport},{onExcessProperty:'error'},extra)`,
  ],
  ['wrong schema slot', nativeDecodeEffect, `Schema.decodeEffect(undefined,${equivalenceSchemaExport})`],
])('rejects the native decodeEffect schema borrower with %s', ([_name, before, after]) => {
  const snapshot = decodeEffectSources();
  snapshot.set(
    verificationFile,
    `import {Schema as ForeignSchema} from 'foreign';${snapshot.get(verificationFile) ?? ''}`.replace(before, after),
  );
  return decodeEffectSchemaWitness(snapshot).pipe(Effect.map((result) => expect(result).toBe(false)));
});
it.effect('rejects a mutated native decodeEffect schema borrower', () => {
  const snapshot = decodeEffectSources();
  snapshot.set(verificationFile, `${snapshot.get(verificationFile) ?? ''}Schema.decodeEffect=foreignTransform;`);
  return decodeEffectSchemaWitness(snapshot).pipe(Effect.map((result) => expect(result).toBe(false)));
});
it.effect('rejects a fake schema passed to the native decodeEffect borrower', () => {
  const snapshot = decodeEffectSources();
  const file = `${owner}/shared/decode-schema.ts`;
  snapshot.set(file, (snapshot.get(file) ?? '').replace(decodeSchemaStruct, ordinarySchemaDto));
  return decodeEffectSchemaWitness(snapshot).pipe(Effect.map((result) => expect(result).toBe(false)));
});
it.effect('rejects a protected Effect used as a native decodeEffect schema borrower', () => {
  const snapshot = decodeEffectSources();
  const file = `${owner}/shared/decode-schema.ts`;
  snapshot.set(
    file,
    `import {Effect} from 'effect';import {Factory} from './port.ts';${snapshot.get(file) ?? ''}`.replace(
      decodeSchemaStruct,
      `Schema.Struct({value:Effect.gen(function*(){return yield*Factory;})})`,
    ),
  );
  return decodeEffectSchemaWitness(snapshot).pipe(Effect.map((result) => expect(result).toBe(false)));
});

it.effect('does not accept a native decodeEffect borrower as a protected Effect transform', () => {
  const snapshot = decodeEffectSources();
  snapshot.set(
    consumerFile,
    `import {Effect,Schema} from 'effect';import {Factory} from '../shared/port.ts';export const use=Effect.gen(function*(){const factory=yield*Factory;return factory.make({transaction});}).pipe(Schema.decodeEffect(Schema.String));`,
  );
  return resolve(snapshot).pipe(Effect.map((result) => expect(result).toBeUndefined()));
});

it.effect('rechecks a completed producer schema witness when its actual source changes', () =>
  Effect.gen(function* changedProducerSchemaSource() {
    const path = yield* Path.Path;
    const snapshot = decodeEffectSources();
    const file = `${owner}/shared/decode-schema.ts`;
    const original = snapshot.get(file);
    const request = equivalenceSchemaRequest(snapshot);
    const resolver = makeScopedContextFactoryResolver(snapshot, root, path, new Map());
    if (request === undefined || original === undefined) {
      return;
    }
    expect(resolver.isServiceFreeSchema(request)).toBe(true);
    expect(resolver.isServiceFreeSchema(request)).toBe(true);
    snapshot.set(file, original.replace(decodeSchemaStruct, ordinarySchemaDto));
    expect(resolver.isServiceFreeSchema(request)).toBe(false);
    snapshot.set(file, original);
    expect(resolver.isServiceFreeSchema(request)).toBe(true);
  }).pipe(Effect.provide(Path.layer)),
);
it.effect('keeps completed producer schema facts inside their constructor contract snapshot', () =>
  Effect.gen(function* changedProducerContractSnapshot() {
    const path = yield* Path.Path;
    const snapshot = decodeEffectSources();
    const file = `${owner}/shared/decode-schema.ts`;
    const dependency = `${owner}/shared/decode-dependency.ts`;
    snapshot.set(
      file,
      `import {Schema} from 'effect';import {ExternalUserSubjectSchema} from './decode-dependency.ts';export const ${equivalenceSchemaExport}=${decodeSchemaStruct};`,
    );
    snapshot.set(
      dependency,
      `import {Schema} from 'effect';export const ExternalUserSubjectSchema=${nativeStringStruct};`,
    );
    const request = equivalenceSchemaRequest(snapshot);
    const firstContracts = new Map(snapshot);
    const first = makeScopedContextFactoryResolver(snapshot, root, path, new Map(), new Map(), firstContracts);
    if (request === undefined) {
      return;
    }
    expect(first.isServiceFreeSchema(request)).toBe(true);
    expect(first.isServiceFreeSchema(request)).toBe(true);
    const changedContracts = new Map([
      ...firstContracts,
      [
        dependency,
        `import {Schema} from 'effect';export const ExternalUserSubjectSchema={get fields(){return {externalSubject:Schema.String};}};`,
      ],
    ]);
    const changed = makeScopedContextFactoryResolver(snapshot, root, path, new Map(), new Map(), changedContracts);
    expect(changed.isServiceFreeSchema(request)).toBe(false);
    expect(first.isServiceFreeSchema(request)).toBe(true);
  }).pipe(Effect.provide(Path.layer)),
);
it.effect('does not share completed producer schema facts with the same export in another owner', () =>
  Effect.gen(function* differentProducerSchemaOwner() {
    const path = yield* Path.Path;
    const snapshot = decodeEffectSources();
    const other = `${root}/verticals/other`;
    const otherRoot = `${other}/api/index.ts`;
    snapshot.set(`${other}/package.json`, '{"name":"@app/other"}');
    snapshot.set(`${other}/shared/decode-schema.ts`, `export const ${equivalenceSchemaExport}={fields:{}};`);
    snapshot.set(
      otherRoot,
      `import {Schema} from 'effect';import {${equivalenceSchemaExport}} from '../shared/decode-schema.ts';const equivalent=Schema.toEquivalence(${equivalenceSchemaExport});`,
    );
    const request = equivalenceSchemaRequest(snapshot);
    const otherRequest = equivalenceSchemaRequest(snapshot, otherRoot);
    const resolver = makeScopedContextFactoryResolver(snapshot, root, path, new Map());
    if (request === undefined || otherRequest === undefined) {
      return;
    }
    expect(resolver.isServiceFreeSchema(request)).toBe(true);
    expect(resolver.isServiceFreeSchema(request)).toBe(true);
    expect(resolver.isServiceFreeSchema(otherRequest)).toBe(false);
  }).pipe(Effect.provide(Path.layer)),
);

it.effect('does not accept the native Schema check operator as a protected Effect transform', () => {
  const snapshot = sources();
  snapshot.set(
    consumerFile,
    `import {Effect,Schema} from 'effect';import {Factory} from '../shared/port.ts';export const use=Effect.gen(function*(){const factory=yield* Factory;return factory.make({transaction});}).pipe(Schema.check(Schema.isMinLength(1)));`,
  );
  return resolve(snapshot).pipe(Effect.map((value) => expect(value).toBeUndefined()));
});
