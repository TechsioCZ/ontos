import { NodeFileSystem, NodePath } from '@effect/platform-node';
import {
  createEffectApiImportResolver,
  strictEffectRuntimeTopologyViolation,
} from '@modern-js/code-tools/strict-effect-runtime';
import { Effect, FileSystem, Layer, Path } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

const sourceFiles = Effect.gen(function* shellBffSources() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = yield* path.fromFileUrl(new URL('../../apps/shell-super-app/api/index.ts', import.meta.url));
  const resource = yield* path.fromFileUrl(
    new URL('../../apps/shell-super-app/shared/mcp-resource.ts', import.meta.url),
  );
  const transport = yield* path.fromFileUrl(
    new URL('../../apps/shell-super-app/api/mcp/transport.ts', import.meta.url),
  );
  return {
    entry,
    entrySource: yield* fs.readFileString(entry),
    resourceSource: yield* fs.readFileString(resource),
    transportSource: yield* fs.readFileString(transport),
  };
});

const testServices = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const plainRouteBody = 'return yield* Effect.void; });';

const nativeRouteTopology = `
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Effect } from 'effect';
import { HttpRouter } from 'effect/http';
import { fixtureApi } from '../shared/api.ts';
const handlers = HttpApiBuilder.group(fixtureApi, 'fixture', h => h.handle('get', () => Effect.void));
const routePath = '/live-changes';
const serveRoute = Effect.fn('LiveChanges.serve')(function* serve() { return yield* Effect.void; });
const transport = HttpRouter.add('GET', routePath, serveRoute);
export default assembleEffectBffRuntime({ api: fixtureApi, handlers, transport });
`;

it('accepts immutable native route paths and Effect.fn handlers without changing the transport', () => {
  expect(strictEffectRuntimeTopologyViolation(nativeRouteTopology)).toBeUndefined();
  expect(
    strictEffectRuntimeTopologyViolation(
      nativeRouteTopology.replace(
        plainRouteBody,
        "return yield* Effect.void; }, Effect.catchTag('Unavailable', () => Effect.void));",
      ),
    ),
  ).toBeUndefined();
  expect(
    strictEffectRuntimeTopologyViolation(
      nativeRouteTopology.replace('routePath, serveRoute', "'/live-changes', () => Effect.void"),
    ),
  ).toBeUndefined();
});

it('rejects malformed, mutable, shadowed and cyclic native route declarations', () => {
  for (const invalid of [
    nativeRouteTopology.replace("'/live-changes'", "'live-changes'"),
    nativeRouteTopology.replace("'GET', routePath", "'INVALID', routePath"),
    nativeRouteTopology.replace('routePath, serveRoute', 'routePath, {}'),
    nativeRouteTopology.replace("const routePath = '/live-changes';", "let routePath = '/live-changes';"),
    nativeRouteTopology.replace('const transport =', "routePath = '/other'; const transport ="),
    nativeRouteTopology.replace('const transport =', 'serveRoute = () => Effect.void; const transport ='),
    nativeRouteTopology.replace("import { Effect } from 'effect';", "import { fake as Effect } from 'effect';"),
    nativeRouteTopology.replace('function* serve()', 'undefined, function* serve()'),
    nativeRouteTopology.replace(plainRouteBody, 'return yield* Effect.void; }, () => ({}));'),
    nativeRouteTopology.replace(
      "const routePath = '/live-changes';",
      'const routePath = alias; const alias = routePath;',
    ),
    nativeRouteTopology.replace('export default assembleEffectBffRuntime', 'assembleEffectBffRuntime'),
  ]) {
    expect(strictEffectRuntimeTopologyViolation(invalid)).toBeDefined();
  }
});

it('rejects native method mutations through direct, aliased and type-wrapped receivers', () => {
  for (const method of ['fn', 'catchTag']) {
    for (const mutation of [
      `Effect.${method} = () => 123;`,
      `const alias = Effect; alias.${method} = () => 123;`,
      `let alias = Effect; alias.${method} = () => 123;`,
      `var alias = Effect; alias.${method} = () => 123;`,
      `(Effect as any).${method} = () => 123;`,
      `let alias = Effect; (alias as any).${method} = () => 123;`,
    ]) {
      const source = nativeRouteTopology
        .replace(plainRouteBody, "return yield* Effect.void; }, Effect.catchTag('Unavailable', () => Effect.void));")
        .replace('const routePath', `${mutation}\nconst routePath`);
      expect(strictEffectRuntimeTopologyViolation(source), mutation).toBeDefined();
    }
  }
});

const capturedNativeRouteTopology = nativeRouteTopology
  .replace(
    "import { Effect } from 'effect';",
    "import { Effect } from 'effect'; import { service } from './service.ts';",
  )
  .replace(
    "const transport = HttpRouter.add('GET', routePath, serveRoute);",
    `const transport = Layer.unwrap(
      Effect.map(service, value => HttpRouter.add(
        'GET', routePath,
        Effect.fn('serve')(
          function* () { return yield* Effect.fail({ _tag: 'Unavailable' }); },
          Effect.catchTag('Unavailable', () => value.serve),
        ),
      )),
    ).pipe(Layer.provide(Layer.empty));`,
  );

it('retains native recovery callback captures with their original lexical binding', () => {
  expect(strictEffectRuntimeTopologyViolation(capturedNativeRouteTopology)).toBeUndefined();
  for (const replacement of ['() => Effect.void', '(value) => value.serve']) {
    expect(
      strictEffectRuntimeTopologyViolation(capturedNativeRouteTopology.replace('() => value.serve', replacement)),
      replacement,
    ).toBeDefined();
  }
});

it.effect('proves the real Shell handler and protocol composition with the installed native analyzer', () =>
  Effect.gen(function* nativeShellTopology() {
    const { entry, entrySource } = yield* sourceFiles;
    const resolver = createEffectApiImportResolver(entry);
    expect(strictEffectRuntimeTopologyViolation(entrySource, resolver)).toBeUndefined();
    expect(
      strictEffectRuntimeTopologyViolation(
        entrySource.replace('export default apiRuntime;', 'export default {};'),
        resolver,
      ),
    ).toBeDefined();
  }).pipe(Effect.provide(testServices)),
);

it.effect('keeps native literal MCP route declarations equal to the shared root-alias contract', () =>
  Effect.gen(function* mcpRouteIdentity() {
    const { resourceSource, transportSource } = yield* sourceFiles;
    const expected = parseSync('mcp-resource.ts', resourceSource).program.body.flatMap((statement) => {
      if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') {
        return [];
      }
      return statement.declaration.declarations.flatMap((binding) =>
        binding.id.type === 'Identifier' &&
        ['MCP_BFF_ROUTE', 'MCP_METADATA_BFF_ROUTE'].includes(binding.id.name) &&
        binding.init?.type === 'Literal'
          ? [binding.init.value]
          : [],
      );
    });
    const actual = parseSync('mcp-transport.ts', transportSource).program.body.flatMap((statement) => {
      if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') {
        return [];
      }
      return statement.declaration.declarations.flatMap((binding) => {
        const call = binding.init;
        if (
          binding.id.type !== 'Identifier' ||
          !['McpEndpointTransportLive', 'McpMetadataTransportLive'].includes(binding.id.name) ||
          call?.type !== 'CallExpression' ||
          call.callee.type !== 'MemberExpression' ||
          call.callee.object.type !== 'Identifier' ||
          call.callee.object.name !== 'HttpRouter' ||
          call.callee.property.type !== 'Identifier' ||
          call.callee.property.name !== 'add'
        ) {
          return [];
        }
        const [method, route, handler] = call.arguments;
        expect(method?.type === 'Literal' ? method.value : undefined).toBe('*');
        expect(handler?.type).toBe('ArrowFunctionExpression');
        return route?.type === 'Literal' ? [route.value] : [];
      });
    });
    expect(expected).toHaveLength(2);
    expect(actual).toEqual(expected);
  }).pipe(Effect.provide(testServices)),
);
