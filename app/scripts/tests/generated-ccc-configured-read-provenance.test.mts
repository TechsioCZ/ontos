import { readFile as readSource } from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { hasOriginalConfiguredReadPhase } from '../generated-ccc-configured-read-provenance.mts';

const ownerPath = 'verticals/commerce-customer-context';
const cases = [
  ['delivery-destination-resolution', 'handleDeliveryDestinationResolution', 'deliveryDestinationReadServiceFactory'],
  ['invoice-recipient-resolution', 'handleInvoiceRecipientResolution', 'invoiceRecipientReadServiceFactory'],
] as const;
const support = `${ownerPath}/src/api/purchase-resolution-read-support.ts`;
const factories = `${ownerPath}/src/api/address-read-support.ts`;
const persistence = `${ownerPath}/src/persistence/address-persistence.ts`;
const external = `${ownerPath}/src/integrations/party-address-source.ts`;

const loadSources = Effect.fn(function* loadActualDependencyClosure() {
  const sources = new Map<string, string>();
  const root = path.resolve(import.meta.dirname, '../..');
  const visit = Effect.fn(function* visitDependency(file: string): Effect.fn.Return<void, unknown> {
    if (sources.has(file)) {
      return;
    }
    const source = yield* Effect.promise(() => readSource(path.join(root, file), 'utf-8'));
    sources.set(file, source);
    for (const statement of parseSync(file, source).program.body) {
      if (statement.type !== 'ImportDeclaration' || !statement.source.value.startsWith('.')) {
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), statement.source.value));
      if (target.startsWith(`${ownerPath}/`) && target.endsWith('.ts')) {
        yield* visit(target);
      }
    }
  });
  for (const [name] of cases) {
    yield* visit(`${ownerPath}/src/api/${name}.read.ts`);
  }
  const manifest = `${ownerPath}/vertical.manifest.ts`;
  sources.set(manifest, yield* Effect.promise(() => readSource(path.join(root, manifest), 'utf-8')));
  return sources;
});

const changed = (sources: ReadonlyMap<string, string>, file: string, before: string, after: string) => {
  const original = sources.get(file);
  expect(original).toBeDefined();
  expect(original).toContain(before);
  return new Map([...sources, [file, original?.replace(before, after) ?? '']]);
};

const changedDeclaration = (
  sources: ReadonlyMap<string, string>,
  file: string,
  name: string,
  before: string,
  after: string,
) => {
  const source = sources.get(file) ?? '';
  const declarations = parseSync(file, source).program.body.flatMap((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    return declaration?.type === 'VariableDeclaration' ? declaration.declarations : [];
  });
  const declaration = declarations.find((item) => item.id.type === 'Identifier' && item.id.name === name);
  expect(declaration?.init).toBeDefined();
  const start = declaration?.init?.start ?? -1;
  const end = declaration?.init?.end ?? -1;
  const expression = source.slice(start, end);
  expect(expression).toContain(before);
  const mutated = `${source.slice(0, start)}${expression.replace(before, after)}${source.slice(end)}`;
  expect(parseSync(file, mutated).errors).toEqual([]);
  return new Map([...sources, [file, mutated]]);
};

const proof = (sources: ReadonlyMap<string, string>, name: string, phase: string) => {
  const readFile = `${ownerPath}/src/api/${name}.read.ts`;
  const source = sources.get(readFile);
  const diagnostics: string[] = [];
  const result =
    source !== undefined &&
    hasOriginalConfiguredReadPhase({ diagnostics, ownerPath, readFile, sources }, source, phase);
  return { diagnostics, result };
};

it.effect('proves both actual registered native configured Reads and their zero-argument default factories', () =>
  Effect.gen(function* actualOriginals() {
    const sources = yield* loadSources();
    for (const [name, phase] of cases) {
      const actual = proof(sources, name, phase);
      expect(actual.result, actual.diagnostics.join('\n')).toBe(true);
    }
  }),
);

it.effect('preserves original import aliases and an immutable local options object', () =>
  Effect.gen(function* nativeAliases() {
    const originals = yield* loadSources();
    for (const [name, phase, factory] of cases) {
      const file = `${ownerPath}/src/api/${name}.read.ts`;
      let sources = changed(
        originals,
        file,
        'makePurchaseResolutionReadHandler, purchaseResolutionOwnerFacts',
        'makePurchaseResolutionReadHandler as configureNativeRead, purchaseResolutionOwnerFacts',
      );
      sources = changed(sources, file, '= makePurchaseResolutionReadHandler({', '= configureNativeRead({');
      sources = changed(sources, file, `{ ${factory} }`, `{ ${factory} as nativeServices }`);
      sources = changed(sources, file, `  ${factory},`, '  nativeServices,');
      const body = sources.get(file) ?? '';
      const configStart = body.indexOf(`const ${phase} = configureNativeRead(`);
      const configEnd = body.indexOf('\n});', configStart);
      expect(configStart).toBeGreaterThan(0);
      expect(configEnd).toBeGreaterThan(configStart);
      const expression = body.slice(configStart, configEnd + 4);
      const replacement = expression
        .replace(`const ${phase} = configureNativeRead(`, 'const options = ')
        .replace(/\);$/u, `;\nconst ${phase} = configureNativeRead(options);`);
      sources = changed(sources, file, expression, replacement);
      sources = changed(sources, support, 'import { Effect }', 'import { Effect as NativeEffect }');
      sources = new Map([...sources, [support, (sources.get(support) ?? '').replaceAll('Effect.', 'NativeEffect.')]]);
      sources = changed(sources, factories, 'import { Crypto, Effect }', 'import { Crypto as ActualCrypto, Effect }');
      sources = new Map([
        ...sources,
        [factories, (sources.get(factories) ?? '').replaceAll('Crypto.Crypto', 'ActualCrypto.Crypto')],
      ]);
      sources = changed(
        sources,
        external,
        'executePartyContactPointDetailWithAuthorization,',
        'executePartyContactPointDetailWithAuthorization as nativePartyExecute,',
      );
      sources = changed(
        sources,
        external,
        'executePartyContactPointDetailWithAuthorization(payload,',
        'nativePartyExecute(payload,',
      );
      const actual = proof(sources, name, phase);
      expect(actual.result, actual.diagnostics.join('\n')).toBe(true);
    }
  }),
);

it.effect('refuses foreign, shadowed, mutable or wrapped configured handler bindings', () =>
  Effect.gen(function* invalidConfigurations() {
    const sources = yield* loadSources();
    for (const [name, phase, factory] of cases) {
      const file = `${ownerPath}/src/api/${name}.read.ts`;
      const source = sources.get(file) ?? '';
      const changes = [
        [`{ load: ${phase} }`, `{ load: (...args) => ${phase}(...args) }`],
        ['resolutionLabel:', '...foreign, resolutionLabel:'],
        [`  ${factory},`, `  ${factory}(),`],
        [`const ${phase} = makePurchaseResolutionReadHandler({`, `let ${phase} = makePurchaseResolutionReadHandler({`],
      ] as const;
      for (const [before, after] of changes) {
        expect(proof(changed(sources, file, before, after), name, phase).result, after).toBe(false);
      }
      const resolve = /resolve:\s*(?<binding>\w+),/u.exec(source)?.groups?.binding;
      expect(resolve).toBeDefined();
      expect(
        proof(changed(sources, file, `resolve: ${resolve},`, `resolve: (...args) => ${resolve}(...args),`), name, phase)
          .result,
      ).toBe(false);
      for (const tail of [
        `${phase} = foreign;`,
        `${factory}.call = foreign;`,
        'makePurchaseResolutionReadHandler = foreign;',
        'function shadow(makePurchaseResolutionReadHandler: unknown) {}',
        `Object.assign(${factory}, foreign);`,
      ]) {
        expect(proof(new Map([...sources, [file, `${source}\n${tail}`]]), name, phase).result, tail).toBe(false);
      }
    }
  }),
);

it.effect(
  'refuses scope, receiver, argument order, cardinality and success-transform mutations in the original handler',
  () =>
    Effect.gen(function* invalidHandlerImplementations() {
      const sources = yield* loadSources();
      for (const [before, after] of [
        ['input.purchasingContext.tenantId !== tenantId', 'input.purchasingContext.tenantId === tenantId'],
        ['context.services)', 'foreign.services)'],
        ['.resolve(input,', '.resolve(context,'],
        ['{ legalEntityId, principalId, storefrontId, tenantId }', '{ principalId, storefrontId, tenantId }'],
        ['result: { resolution }', 'result: { resolution: foreign }'],
        ['Effect.mapError(', 'Effect.map('],
      ]) {
        for (const [name, phase] of cases) {
          expect(proof(changed(sources, support, before ?? '', after ?? ''), name, phase).result, after).toBe(false);
        }
      }
    }),
);

it.effect('refuses supplied factory dependencies, changed defaults and changed native service receivers', () =>
  Effect.gen(function* invalidDefaultFactories() {
    const sources = yield* loadSources();
    for (const [name, phase, factory] of cases) {
      const maker = name.startsWith('delivery')
        ? 'makeDeliveryDestinationReadServiceFactory'
        : 'makeInvoiceRecipientReadServiceFactory';
      expect(
        proof(changed(sources, factories, `${factory} = ${maker}()`, `${factory} = ${maker}(foreign)`), name, phase)
          .result,
      ).toBe(false);
      for (const [before, after] of [
        ['= partyAddressResolutionPorts,', '= foreign,'],
        ['const crypto = yield* Crypto.Crypto;', 'const crypto = yield* ForeignCrypto.Crypto;'],
      ]) {
        expect(
          proof(changedDeclaration(sources, factories, maker, before ?? '', after ?? ''), name, phase).result,
          after,
        ).toBe(false);
      }
      const adapter = name.startsWith('delivery')
        ? 'deliveryDestinationPortsForTransaction'
        : 'invoiceRecipientPortsForTransaction';
      expect(
        proof(
          changedDeclaration(sources, persistence, adapter, 'loadCurrent: external.', 'loadCurrent: foreign.'),
          name,
          phase,
        ).result,
      ).toBe(false);
      expect(
        proof(
          changedDeclaration(
            sources,
            external,
            'partyBackedPostalAddressResolverForScope',
            'partyContactPointExecutorForScope(scope, crypto, requirementKey),',
            'partyContactPointExecutorForScope(crypto, scope, requirementKey),',
          ),
          name,
          phase,
        ).result,
      ).toBe(false);
    }
  }),
);

it.effect('keeps native service forwarding, fail-closed defaults and scope-bound delegation original', () =>
  Effect.gen(function* serviceProvenance() {
    const sources = yield* loadSources();
    for (const [name, phase] of cases) {
      expect(proof(sources, name, phase).result).toBe(true);
      const adapter = name.startsWith('delivery')
        ? 'deliveryDestinationPortsForTransaction'
        : 'invoiceRecipientPortsForTransaction';
      for (const [before, after] of [
        ['invokeDefaults(transaction, scope, profile)', 'invokeDefaults(scope, transaction, profile)'],
        ['resolvePostalAddress(address, external)', 'resolvePostalAddress(external, address)'],
        ['Effect.map(found)', 'Effect.map(() => foreign)'],
      ] as const) {
        expect(proof(changedDeclaration(sources, persistence, adapter, before, after), name, phase).result, after).toBe(
          false,
        );
      }
      expect(
        proof(
          changedDeclaration(
            sources,
            persistence,
            'missingExternal',
            'Effect.fail(unavailable(dependency))',
            'Effect.succeed(unavailable(dependency))',
          ),
          name,
          phase,
        ).result,
      ).toBe(false);
      expect(
        proof(
          changedDeclaration(
            sources,
            external,
            'partyBackedPostalAddressResolver',
            'Effect.catch(resolverFailure)',
            'Effect.map(() => foreign)',
          ),
          name,
          phase,
        ).result,
      ).toBe(false);
      expect(
        proof(
          changedDeclaration(
            sources,
            external,
            'partyContactPointExecutorForScope',
            "subject: { _tag: 'Assertion', scope }",
            "subject: { _tag: 'Assertion', scope: foreignScope }",
          ),
          name,
          phase,
        ).result,
      ).toBe(false);
      for (const [file, tail] of [
        [factories, 'partyAddressResolutionPorts.resolvePartyPostalAddress = foreign;'],
        [persistence, `${adapter} = foreign;`],
        [persistence, 'invokeDetail = foreign;'],
        [external, 'partyBackedPostalAddressResolver = foreign;'],
        [external, 'PartyAddressSourceExecutor = foreign;'],
      ] as const) {
        const mutated = new Map([...sources, [file, `${sources.get(file)}\n${tail}`]]);
        expect(proof(mutated, name, phase).result, tail).toBe(false);
      }
    }
  }),
);

it.effect(
  'binds the actual default operation requirement to the original registered Read, without guessed defaults',
  () =>
    Effect.gen(function* requirementIdentity() {
      const sources = yield* loadSources();
      for (const [name, phase, factory] of cases) {
        const maker = name.startsWith('delivery')
          ? 'makeDeliveryDestinationReadServiceFactory'
          : 'makeInvoiceRecipientReadServiceFactory';
        expect(proof(sources, name, phase).result).toBe(true);
        expect(
          proof(changed(sources, factories, `${factory} = ${maker}()`, `${factory} = ${maker}(undefined)`), name, phase)
            .result,
        ).toBe(false);
        const other = name.startsWith('delivery') ? 'invoice-recipient-resolution' : 'delivery-destination-resolution';
        expect(
          proof(
            changedDeclaration(sources, factories, maker, `requirement.${name}-party`, `requirement.${other}-party`),
            name,
            phase,
          ).result,
        ).toBe(false);
        const missingManifest = new Map(sources);
        missingManifest.delete(`${ownerPath}/vertical.manifest.ts`);
        expect(proof(missingManifest, name, phase).result).toBe(false);
      }
    }),
);

it.effect('rejects wrapped aliases, mutations and escapes of the mutable default service receiver', () =>
  Effect.gen(function* wrappedServiceReceivers() {
    const sources = yield* loadSources();
    const accepted: string[] = [];
    for (const tail of [
      '(failClosedAddressExternalResolutionPorts).loadDeliveryDestinationCurrent = foreign;',
      '(failClosedAddressExternalResolutionPorts as unknown as Record<string, unknown>).loadInvoiceRecipientCurrent = foreign;',
      'const alias = (failClosedAddressExternalResolutionPorts); alias.loadDeliveryDestinationCurrent = foreign;',
      'const alias = failClosedAddressExternalResolutionPorts as unknown; mutate(alias);',
      'Object.assign((failClosedAddressExternalResolutionPorts), foreign);',
      'mutate({ ports: (failClosedAddressExternalResolutionPorts as unknown) });',
      'delete (failClosedAddressExternalResolutionPorts).loadDeliveryDestinationCurrent;',
      'Object.assign(failClosedAddressExternalResolutionPorts!, foreign);',
      'mutate((failClosedAddressExternalResolutionPorts satisfies unknown));',
      '([failClosedAddressExternalResolutionPorts.loadDeliveryDestinationCurrent] = [foreign]);',
      '({ value: failClosedAddressExternalResolutionPorts.loadInvoiceRecipientCurrent } = foreign);',
    ]) {
      const text = `${sources.get(persistence)}\n${tail}`;
      expect(parseSync(persistence, text).errors).toEqual([]);
      for (const [name, phase] of cases) {
        if (proof(new Map([...sources, [persistence, text]]), name, phase).result) {
          accepted.push(`${name}: ${tail}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  }),
);

it.effect('does not let async arrows impersonate synchronous native handler and service factories', () =>
  Effect.gen(function* asyncProducers() {
    const sources = yield* loadSources();
    const accepted: string[] = [];
    for (const [name, phase] of cases) {
      const maker = name.startsWith('delivery')
        ? 'makeDeliveryDestinationReadServiceFactory'
        : 'makeInvoiceRecipientReadServiceFactory';
      const adapter = name.startsWith('delivery')
        ? 'deliveryDestinationPortsForTransaction'
        : 'invoiceRecipientPortsForTransaction';
      for (const [file, declaration, before, after] of [
        [support, 'makePurchaseResolutionReadHandler', '<Input extends', 'async <Input extends'],
        [factories, maker, '(\n', 'async (\n'],
        [
          factories,
          'partyAddressResolutionPorts',
          '(scope, crypto, requirementKey)',
          'async (scope, crypto, requirementKey)',
        ],
        [persistence, adapter, '(\n', 'async (\n'],
        [persistence, 'composeAddressExternalResolutionPorts', '(\n', 'async (\n'],
        [persistence, 'failClosedAddressExternalResolutionPorts', '() =>', 'async () =>'],
        [persistence, 'missingExternal', '<A>(dependency:', 'async <A>(dependency:'],
        [persistence, adapter, 'loadSavedAddress: ({', 'loadSavedAddress: async ({'],
        [external, 'partyBackedPostalAddressResolverForScope', '(\n', 'async (\n'],
        [external, 'partyBackedPostalAddressResolver', '(requestCorrelation:', 'async (requestCorrelation:'],
        [external, 'partyBackedPostalAddressResolver', '(address:', 'async (address:'],
        [external, 'partyContactPointExecutorForScope', '(\n', 'async (\n'],
        [external, 'partyContactPointExecutorForScope', '(payload, correlation)', 'async (payload, correlation)'],
      ] as const) {
        if (proof(changedDeclaration(sources, file, declaration, before, after), name, phase).result) {
          accepted.push(`${name}: ${declaration}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  }),
);

it.effect('rejects extra factory capture declarators that replace the transaction or trusted scope', () =>
  Effect.gen(function* captureSideEffects() {
    const sources = yield* loadSources();
    const accepted: string[] = [];
    for (const [name, phase] of cases) {
      const maker = name.startsWith('delivery')
        ? 'makeDeliveryDestinationReadServiceFactory'
        : 'makeInvoiceRecipientReadServiceFactory';
      for (const sideEffect of ['transaction = foreign', 'scope = foreign', 'crypto = foreign']) {
        const mutated = changedDeclaration(
          sources,
          factories,
          maker,
          'const crypto = yield* Crypto.Crypto;',
          `let crypto = yield* Crypto.Crypto, ignored = (${sideEffect});`,
        );
        if (proof(mutated, name, phase).result) {
          accepted.push(`${name}: ${sideEffect}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  }),
);

it.effect('requires the real native published client import and its unmodified executor binding', () =>
  Effect.gen(function* fakePublishedClients() {
    const sources = yield* loadSources();
    const accepted: string[] = [];
    const fakeImport = new Map([
      ...sources,
      [external, (sources.get(external) ?? '').replaceAll('@app/party-registry/api/client', '@foreign/api/client')],
    ]);
    const reboundClient = new Map([
      ...sources,
      [external, `${sources.get(external)}\nexecutePartyContactPointDetailWithAuthorization = foreign;`],
    ]);
    for (const [name, phase] of cases) {
      for (const [label, mutated] of [
        ['foreign package', fakeImport],
        ['rebound executor', reboundClient],
      ] as const) {
        if (proof(mutated, name, phase).result) {
          accepted.push(`${name}: ${label}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  }),
);

it.effect('rejects owner-boundary escapes and configuration mutations instead of trusting names or comments', () =>
  Effect.gen(function* ownerBoundary() {
    const sources = yield* loadSources();
    for (const [name, phase] of cases) {
      const file = `${ownerPath}/src/api/${name}.read.ts`;
      const original = sources.get(file) ?? '';
      const externalImport = changed(
        sources,
        file,
        "from './purchase-resolution-read-support.ts'",
        "from '../../../party-registry/src/api/purchase-resolution-read-support.ts'",
      );
      expect(proof(externalImport, name, phase).result).toBe(false);
      expect(
        proof(
          new Map([...sources, [file, `${original}\n// ${phase} = foreign;\nconst text = '${phase} = foreign';`]]),
          name,
          phase,
        ).result,
      ).toBe(true);
      const makeOptions = original
        .replace(`const ${phase} = makePurchaseResolutionReadHandler({`, 'const options = {')
        .replace(
          '\n});\n\nexport const',
          `\n};\nconst ${phase} = makePurchaseResolutionReadHandler(options);\n\nexport const`,
        );
      const immutable = new Map([...sources, [file, makeOptions]]);
      expect(proof(immutable, name, phase).result).toBe(true);
      for (const tail of [
        'options.resolve = foreign;',
        'const alias = options; alias.resolve = foreign;',
        'Object.assign(options, foreign);',
        'mutate(options);',
        'mutate({ options });',
      ]) {
        expect(proof(new Map([...immutable, [file, `${makeOptions}\n${tail}`]]), name, phase).result, tail).toBe(false);
      }
    }
  }),
);
