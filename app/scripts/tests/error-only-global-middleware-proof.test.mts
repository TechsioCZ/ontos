import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';

import { Effect, Path } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { provesErrorOnlyGlobalMiddleware } from '../error-only-global-middleware-proof.mts';
import { makeScopedContextFactoryResolver } from '../scoped-context-factory-proof.mts';

const owner = 'packages/shared-contracts';
const seam = `${owner}/src/http-error-seam.ts`;
const codec = `${owner}/src/problem-details.ts`;
const originalErrorHelperCall = 'requestSchemaProblem(defect)';
const originalJsonFactory = 'HttpServerResponse.jsonUnsafe(body,';
const originalFailureTransform = 'Effect.orDie,';
const nativeSchema = `import { Schema } from 'effect';
export const RequestSchemaProblemSchema = Schema.Struct({
 detail: Schema.String, paths: Schema.Array(Schema.String), status: Schema.Literal(400), title: Schema.String, type: Schema.String,
});`;
const fixture = Effect.gen(function* errorSeamFixture() {
  const root = nodePath.resolve(import.meta.dirname, '../..');
  const entries = yield* Effect.forEach([seam, codec, `${owner}/package.json`], (file) =>
    Effect.gen(function* sourceEntry() {
      return [
        nodePath.join(root, file),
        yield* Effect.tryPromise(() => readFile(nodePath.join(root, file), 'utf-8')),
      ] as const;
    }),
  );
  return { root, sources: new Map(entries) };
});
const prove = (root: string, sources: ReadonlyMap<string, string>) =>
  Effect.gen(function* errorOnlyProof() {
    const path = yield* Path.Path;
    const file = nodePath.join(root, seam);
    const source = sources.get(file) ?? '';
    const parsed = parseSync(file, source);
    expect(parsed.errors).toEqual([]);
    const snapshot = new Map(
      [...sources].map(([filename, body]) => [nodePath.relative(root, filename).split(nodePath.sep).join('/'), body]),
    );
    const resolver = makeScopedContextFactoryResolver(sources, root, path, new Map(), new Map(), snapshot);
    const calls = parsed.program.body.flatMap((statement) =>
      statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration'
        ? statement.declaration.declarations.flatMap((binding) =>
            binding.init?.type === 'CallExpression' &&
            resolver.isNativeMethod(file, binding.init.callee, 'HttpRouter', 'middleware')
              ? [binding.init]
              : [],
          )
        : [],
    );
    const [call] = calls;
    if (call === undefined || calls.length !== 1) {
      return false;
    }
    return provesErrorOnlyGlobalMiddleware({
      call,
      file,
      isNativeMethod: (filename, expression, namespace, method) =>
        resolver.isNativeMethod(filename, expression, namespace, method),
      isServiceFreeSchema: (request) => resolver.isServiceFreeSchema(request),
      program: parsed.program,
      resolveCapturedValue: (request) => resolver.resolveCapturedValue(request),
      resolveDeclaredFunction: (request) => resolver.resolveDeclaredFunction(request),
      sources,
    });
  }).pipe(Effect.provide(Path.layer));

it.effect('proves the actual error seam body with a genuinely closed native Struct codec', () =>
  Effect.gen(function* nativeCodecSeam() {
    const { root, sources } = yield* fixture;
    sources.set(nodePath.join(root, codec), nativeSchema);
    expect(yield* prove(root, sources)).toBe(true);
  }),
);

it.effect.each([
  { from: '{ global: true }', name: 'non-global registration', to: '{ global: false }' },
  {
    from: 'Effect.catchDefect(httpEffect,',
    name: 'replacement context before recovery',
    to: 'Effect.catchDefect(Effect.updateContext(httpEffect, () => replacementContext),',
  },
  {
    from: 'Effect.catchDefect(httpEffect,',
    name: 'provider before recovery',
    to: 'Effect.catchDefect(Effect.provideService(httpEffect, tag, service),',
  },
  {
    from: originalFailureTransform,
    name: 'provider inside helper',
    to: 'Effect.provideService(tag, service), Effect.orDie,',
  },
  {
    from: originalFailureTransform,
    name: 'context replacement inside helper',
    to: 'Effect.updateContext(() => replacementContext), Effect.orDie,',
  },
  { from: originalJsonFactory, name: 'unknown helper call', to: 'foreignResponse(body,' },
  {
    from: "import { HttpRouter, HttpServerResponse } from 'effect/http';",
    name: 'forged router namespace',
    to: "import { HttpRouter, HttpServerResponse } from 'fake-http';",
  },
  {
    from: "import { Effect, Schema, SchemaIssue } from 'effect';",
    name: 'captured schema mutation',
    to: "import { Effect, Schema, SchemaIssue } from 'effect';\nRequestSchemaProblemSchema.make = foreignMake;",
  },
  { from: originalErrorHelperCall, name: 'foreign callback', to: 'foreignCallback(defect)' },
  {
    from: originalErrorHelperCall,
    name: 'different incoming effect',
    to: 'Effect.catchDefect(otherEffect, foreignCallback)',
  },
  { from: originalJsonFactory, name: 'nested helper injection', to: 'injectContext(body,' },
  {
    from: originalJsonFactory,
    name: 'opaque issue response projection',
    to: 'HttpServerResponse.jsonUnsafe(issue,',
  },
  { from: originalFailureTransform, name: 'Scope lifecycle inside helper', to: 'Effect.scoped,' },
  {
    from: originalFailureTransform,
    name: 'resource lifecycle inside helper',
    to: 'Effect.acquireRelease(allocate, release),',
  },
  { from: originalJsonFactory, name: 'manual Effect runtime inside helper', to: 'Effect.runSync(body,' },
])('rejects $name', ({ from, to }) =>
  Effect.gen(function* invalidErrorSeam() {
    const { root, sources } = yield* fixture;
    const file = nodePath.join(root, seam);
    const original = sources.get(file) ?? '';
    expect(original).toContain(from);
    sources.set(file, original.replaceAll(from, to));
    sources.set(nodePath.join(root, codec), nativeSchema);
    expect(yield* prove(root, sources)).toBe(false);
  }),
);

it.effect('rejects a codec with a captured Context dependency through the genuine schema proof', () =>
  Effect.gen(function* contextfulCodec() {
    const { root, sources } = yield* fixture;
    sources.set(
      nodePath.join(root, codec),
      `import { Context, Schema } from 'effect';
class Dependency extends Context.Service<Dependency>()('Dependency') {}
export const RequestSchemaProblemSchema = Dependency;`,
    );
    expect(yield* prove(root, sources)).toBe(false);
  }),
);

it.effect('rejects a resolved private nested helper that injects context', () =>
  Effect.gen(function* injectedPrivateHelper() {
    const { root, sources } = yield* fixture;
    const file = nodePath.join(root, seam);
    const original = sources.get(file) ?? '';
    const changed = original
      .replace(
        'const requestSchemaProblem =',
        'const injectContext = (body, options) => Effect.updateContext(Effect.succeed(HttpServerResponse.jsonUnsafe(body, options)), () => replacementContext);\nconst requestSchemaProblem =',
      )
      .replace('HttpServerResponse.jsonUnsafe(body, {', 'injectContext(body, {');
    expect(parseSync(file, changed).errors).toEqual([]);
    sources.set(file, changed);
    sources.set(nodePath.join(root, codec), nativeSchema);
    expect(yield* prove(root, sources)).toBe(false);
  }),
);

it.effect('rejects a resolved foreign callback', () =>
  Effect.gen(function* foreignErrorCallback() {
    const { root, sources } = yield* fixture;
    const file = nodePath.join(root, seam);
    const original = sources.get(file) ?? '';
    const changed = `import { foreignCallback } from './foreign-error.ts';\n${original}`.replace(
      'requestSchemaProblem(defect)',
      'foreignCallback(defect)',
    );
    sources.set(file, changed);
    sources.set(
      nodePath.join(root, owner, 'src/foreign-error.ts'),
      "import { Effect } from 'effect'; export const foreignCallback = defect => Effect.die(defect);",
    );
    sources.set(nodePath.join(root, codec), nativeSchema);
    expect(yield* prove(root, sources)).toBe(false);
  }),
);

it.effect('retains native import aliases and renamed private response helper identities', () =>
  Effect.gen(function* lexicalNativeAliases() {
    const { root, sources } = yield* fixture;
    const file = nodePath.join(root, seam);
    const original = sources.get(file) ?? '';
    const changed = original
      .replace('import { Effect, Schema, SchemaIssue }', 'import { Effect as NativeEffect, Schema, SchemaIssue }')
      .replaceAll('Effect.', 'NativeEffect.')
      .replaceAll('requestSchemaProblem', 'answerSchemaProblem')
      .replace('RequestSchemaProblemLive', 'GlobalErrorRecoveryLive');
    expect(parseSync(file, changed).errors).toEqual([]);
    sources.set(file, changed);
    sources.set(nodePath.join(root, codec), nativeSchema);
    expect(yield* prove(root, sources)).toBe(true);
  }),
);
