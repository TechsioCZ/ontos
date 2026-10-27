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
