import { readFile, readdir } from 'node:fs/promises';
import nodePath from 'node:path';

import { Effect, Path, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { makeScopedContextFactoryResolver } from '../scoped-context-factory-proof.mts';
import { provesTaggedMiddlewareContext } from '../tagged-middleware-context-proof.mts';

const root = '/tagged-context-proof';
const fixtureOwner = 'verticals/fixture';
const fixtureFile = `${root}/${fixtureOwner}/api/problems.ts`;
const schemaFile = `${root}/${fixtureOwner}/shared/problem.ts`;
const schemaSource = `import { Schema } from 'effect'; export const ProblemSchema=Schema.Struct({_tag:Schema.Literal('InvalidProblem'),status:Schema.Literal(400),detail:Schema.String});`;
const prefix = `import { Effect, Layer } from 'effect';
import { HttpApiMiddleware, HttpApiError } from 'effect/http-api';
import { ProblemSchema } from '../shared/problem.ts';
class Middleware extends HttpApiMiddleware.Service<Middleware>()('fixture/Middleware',{error:ProblemSchema}) {}
const problemStatus={invalid:400} as const;
export const problem={invalid:()=>ProblemSchema.make({_tag:'InvalidProblem',status:problemStatus.invalid,detail:'Invalid request'})};
const invalidProblem=problem.invalid();
const rewrite=(response)=>response.status===415?Effect.fail(invalidProblem):Effect.succeed(response);
`;
const schemaErrorKind = 'schema-error-transform';
const handlerKind = 'handler-transform';
const rewriteTransform = 'Effect.flatMap(rewrite)';
const failureBody = '()=>Effect.fail(problem.invalid())';
const nativeTransform = `${prefix}export const live=HttpApiMiddleware.layerSchemaErrorTransform(Middleware,()=>Effect.fail(problem.invalid()));`;
const customTransform = `${prefix}export const live=Layer.succeed(Middleware,(incoming,_options)=>incoming.pipe(Effect.flatMap(rewrite),Effect.catchIf(error=>HttpApiError.HttpApiSchemaError.is(error),()=>Effect.fail(invalidProblem))));`;
const sourcesFor = (source: string): Map<string, string> =>
  new Map([
    [fixtureFile, source],
    [schemaFile, schemaSource],
    [
      `${root}/${fixtureOwner}/package.json`,
      '{"name":"@app/fixture","type":"module","exports":{"./problem":"./shared/problem.ts"}}',
    ],
  ]);
const prove = (source: string, additional: ReadonlyMap<string, string> = new Map()) =>
  Effect.gen(function* taggedBodyProof() {
    const path = yield* Path.Path;
    const sources = new Map([...sourcesFor(source), ...additional]);
    const parsed = parseSync(fixtureFile, source);
    expect(parsed.errors).toEqual([]);
    const resolver = makeScopedContextFactoryResolver(sources, root, path, new Map(), new Map(), sources);
    const declarations = parsed.program.body.flatMap((statement) =>
      statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration'
        ? statement.declaration.declarations.filter(
            (binding) => binding.id.type === 'Identifier' && binding.id.name === 'live',
          )
        : [],
    );
    const [binding] = declarations;
    const call = binding?.init;
    if (call?.type !== 'CallExpression') {
      return false;
    }
    const [, implementation] = call.arguments;
    if (implementation === undefined || implementation.type === 'SpreadElement') {
      return false;
    }
    const kind = resolver.isNativeMethod(fixtureFile, call.callee, 'HttpApiMiddleware', 'layerSchemaErrorTransform')
      ? schemaErrorKind
      : handlerKind;
    return provesTaggedMiddlewareContext({
      call,
      file: fixtureFile,
      implementation,
      isNativeMethod: (filename, expression, namespace, method) =>
        resolver.isNativeMethod(filename, expression, namespace, method),
      isServiceFreeSchema: (request) => resolver.isServiceFreeSchema(request),
      kind,
      program: parsed.program,
      resolveCapturedValue: (request) => resolver.resolveCapturedValue(request),
      resolveDataObjectMethod: (request) => resolver.resolveDataObjectMethod(request),
      resolveDeclaredFunction: (request) => resolver.resolveDeclaredFunction(request),
      sources,
    });
  }).pipe(Effect.provide(Path.layer));

it.effect.each([nativeTransform, customTransform])('proves a genuine native tagged error transformer', (source) =>
  prove(source).pipe(Effect.map((result) => expect(result).toBe(true))),
);

it.effect.each([
  {
    name: 'direct context provision',
    source: nativeTransform.replace(
      'Effect.fail(problem.invalid())',
      'Effect.fail(problem.invalid()).pipe(Effect.provideContext(fake))',
    ),
  },
  {
    name: 'nested context provision',
    source: `${nativeTransform.replace(
      failureBody,
      '()=>inject()',
    )}const inject=()=>Effect.fail(problem.invalid()).pipe(Effect.provideContext(fake));`,
  },
  {
    name: 'aliased context provision',
    source: customTransform.replace(rewriteTransform, 'Effect.provideContext(fake)'),
  },
  {
    name: 'literal-key context provision',
    source: customTransform
      .replace('Effect, Layer', 'Effect, Layer, Context')
      .replace(rewriteTransform, "Effect.provideContext(Context.makeUnsafe(new Map([['fixture/Factory',fake]])))"),
  },
  {
    name: 'context update',
    source: customTransform.replace(rewriteTransform, 'Effect.updateContext(()=>fake)'),
  },
  {
    name: 'manual runtime',
    source: nativeTransform.replace('Effect.fail(problem.invalid())', 'Effect.runSync(Effect.fail(problem.invalid()))'),
  },
  { name: 'lifecycle', source: customTransform.replace(rewriteTransform, 'Effect.scoped') },
  { name: 'unknown transformer', source: customTransform.replace(rewriteTransform, 'foreignTransform') },
  {
    name: 'effectful function wrapper',
    source: `${nativeTransform.replace(failureBody, 'wrappedFailure')}const wrappedFailure=Effect.fn(()=>Effect.fail(problem.invalid()));`,
  },
  {
    name: 'wrong native constructor',
    source: nativeTransform.replace("from 'effect/http-api'", "from 'foreign-http'"),
  },
  { name: 'wrong incoming receiver', source: customTransform.replace('incoming.pipe(', 'other.pipe(') },
  {
    name: 'caller parameter shadowing an unrelated helper ambient',
    source: `${nativeTransform.replace(failureBody, "()=>Effect.fail(callHidden({env:{X:'safe'}}))")}const hidden=()=>ProblemSchema.make({_tag:'InvalidProblem',status:400,detail:process.env.X});const callHidden=(process)=>hidden();`,
  },

  {
    name: 'executable default parameter',
    source: customTransform.replace('(incoming,_options)', '(incoming,_options=inject())'),
  },
  {
    name: 'opaque problem',
    source: nativeTransform.replace(failureBody, '()=>Effect.fail(opaqueProblem)'),
  },
  {
    name: 'problem object getter',
    source: nativeTransform
      .replace('invalid:()=>ProblemSchema.make', 'get invalid(){return ()=>ProblemSchema.make')
      .replace("detail:'Invalid request'})};", "detail:'Invalid request'})}};"),
  },
  { name: 'mutated helper object', source: `${nativeTransform}problem.invalid=foreignProblem;` },
  { name: 'unknown schema mutator', source: `${nativeTransform}mutateSchema(ProblemSchema);` },
  {
    name: 'duplicate imported schema alias mutation',
    source: `${nativeTransform}import {ProblemSchema as OtherSchema} from '../shared/problem.ts'; OtherSchema.make=injectContext;`,
  },
  {
    name: 'schema alias container escape',
    source: `${nativeTransform}const holder={schema:ProblemSchema}; mutateSchema(holder.schema);`,
  },
  { name: 'captured mutation', source: `${customTransform}invalidProblem.status=503;` },
  {
    name: 'original effect escape',
    source: customTransform.replace(rewriteTransform, 'Effect.flatMap(()=>incoming)'),
  },
  {
    name: 'wrong rewrite return',
    source: customTransform.replace('Effect.succeed(response)', 'Effect.succeed(otherResponse)'),
  },
  {
    name: 'rewrite context injection',
    source: customTransform.replace(
      'Effect.succeed(response)',
      'Effect.succeed(response).pipe(Effect.provideContext(fake))',
    ),
  },
])('rejects $name', ({ source }) => prove(source).pipe(Effect.map((result) => expect(result).toBe(false))));

it.effect('retains native import aliases and private helper renames', () =>
  prove(
    customTransform
      .replace('Effect, Layer', 'Effect as NativeEffect, Layer')
      .replaceAll('Effect.', 'NativeEffect.')
      .replaceAll('rewrite', 'rewrite415')
      .replaceAll('invalidProblem', 'requestProblem'),
  ).pipe(Effect.map((result) => expect(result).toBe(true))),
);

const supportFile = `${root}/${fixtureOwner}/api/support.ts`;
const supportSource = `const status={invalid:400} as const;export const build=(make,slug)=>()=>make({_tag:'InvalidProblem',status:status.invalid,detail:\`The \${slug} request is invalid.\`});`;
const plainInvalid =
  "invalid:()=>ProblemSchema.make({_tag:'InvalidProblem',status:problemStatus.invalid,detail:'Invalid request'})";
const boundInvalid = "invalid:build((input)=>ProblemSchema.make(input),'fixture')";
const capturedMake = '(input)=>ProblemSchema.make(input)';
const capturedStatus = 'status:status.invalid';
const closureTransform = `${nativeTransform.replace(plainInvalid, boundInvalid)}import {build} from './support.ts';`;
const withSupport = (source = supportSource): Map<string, string> => new Map([[supportFile, source]]);
it.effect('proves a real cross-source returned closure with bound callable and scalar captures', () =>
  prove(closureTransform, withSupport()).pipe(Effect.map((result) => expect(result).toBe(true))),
);
it.effect.each([
  { name: 'unknown captured value', support: supportSource.replace(capturedStatus, 'status:unknownStatus') },
  { name: 'mutated helper factory', support: `${supportSource}build=replacement;` },
  {
    name: 'getter in supplied record',
    support: supportSource.replace(capturedStatus, 'get status(){return 400}'),
  },
  {
    name: 'cross-frame caller name shadow',
    source: `${closureTransform}const process={env:{status:400}};`,
    support: supportSource.replace(capturedStatus, 'status:process.env.status'),
  },
  {
    name: 'unsafe callable body',
    source: closureTransform.replace(
      capturedMake,
      '(input)=>ProblemSchema.make(input).pipe(Effect.provideContext(fake))',
    ),
  },
  {
    name: 'nested callable context injection',
    source: `${closureTransform.replace(capturedMake, '(input)=>unsafeMake(input)')}const unsafeMake=(input)=>ProblemSchema.make(input).pipe(Effect.provideContext(fake));`,
  },
  {
    name: 'mutated callable argument',
    source: closureTransform.replace(capturedMake, '(input)=>{input.status=503;return ProblemSchema.make(input)}'),
  },
  {
    name: 'unbound runtime factory parameter',
    support: supportSource
      .replace('(make,slug)', '(make,slug,unknownStatus)')
      .replace(capturedStatus, 'status:unknownStatus'),
  },
])('rejects cross-source $name', ({ source = closureTransform, support = supportSource }) =>
  prove(source, withSupport(support)).pipe(Effect.map((result) => expect(result).toBe(false))),
);

const PackageManifestSchema = Schema.Struct({
  exports: Schema.Record(Schema.String, Schema.Unknown),
  name: Schema.String,
});
it.live('proves both generated error transformer styles and the actual MFA and step-up wrappers', () =>
  Effect.gen(function* actualTaggedMiddlewareBodies() {
    const path = yield* Path.Path;
    const app = nodePath.resolve(import.meta.dirname, '../..');
    const entries = yield* Effect.tryPromise(() => readdir(nodePath.join(app, 'packages'), { withFileTypes: true }));
    const packages: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = `packages/${entry.name}`;
      const children = yield* Effect.tryPromise(() => readdir(nodePath.join(app, directory)));
      if (children.includes('package.json') && children.includes('src')) {
        packages.push(directory);
      }
    }
    const owner = 'verticals/commerce-customer-context';
    const sources = new Map<string, string>();
    for (const directory of [
      `${owner}/api`,
      `${owner}/shared`,
      `${owner}/src`,
      ...packages.map((packageDirectory) => `${packageDirectory}/src`),
    ]) {
      const base = nodePath.join(app, directory);
      const files = yield* Effect.tryPromise(() => readdir(base, { recursive: true }));
      yield* Effect.forEach(
        files.filter((entry) => /\.[cm]?tsx?$/u.test(entry)),
        (entry) =>
          Effect.gen(function* actualSource() {
            const file = nodePath.join(base, entry);
            sources.set(file, yield* Effect.tryPromise(() => readFile(file, 'utf-8')));
          }),
      );
    }
    const exports = new Map<string, string>();
    const conditional = new Map<string, readonly string[]>();
    const contracts = new Map(sources);
    for (const directory of [...packages, owner]) {
      const packageRoot = nodePath.join(app, directory);
      const filename = nodePath.join(packageRoot, 'package.json');
      const text = yield* Effect.tryPromise(() => readFile(filename, 'utf-8'));
      contracts.set(filename, text);
      const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifestSchema))(text);
      for (const [key, target] of Object.entries(manifest.exports)) {
        const specifier = key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`;
        if (Schema.is(Schema.String)(target) && target.startsWith('./') && !key.includes('*')) {
          exports.set(specifier, nodePath.resolve(packageRoot, target));
        } else if (Schema.is(Schema.Record(Schema.String, Schema.String))(target)) {
          conditional.set(
            specifier,
            Object.values(target).map((value) => nodePath.resolve(packageRoot, value)),
          );
        }
      }
    }
    const resolver = makeScopedContextFactoryResolver(sources, app, path, exports, conditional, contracts);
    const outcomes: { readonly file: string; readonly rejectedSchemas: readonly string[]; readonly result: boolean }[] =
      [];
    for (const [relative, kind] of [
      ['api/add-saved-address-action-problems.ts', schemaErrorKind],
      ['api/archive-customer-profile-action-problems.ts', schemaErrorKind],
      ['api/portal-auth/provider/mfa/problems.ts', handlerKind],
      ['api/portal-auth/provider/step-up/problems.ts', handlerKind],
    ] as const) {
      const file = nodePath.join(app, owner, relative);
      const { program } = parseSync(file, sources.get(file) ?? '');
      const calls = program.body.flatMap((statement) =>
        statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration'
          ? statement.declaration.declarations.flatMap((binding) =>
              binding.init?.type === 'CallExpression' &&
              resolver.isNativeMethod(
                file,
                binding.init.callee,
                kind === handlerKind ? 'Layer' : 'HttpApiMiddleware',
                kind === handlerKind ? 'succeed' : 'layerSchemaErrorTransform',
              )
                ? [binding.init]
                : [],
            )
          : [],
      );
      expect(calls).toHaveLength(1);
      const [call] = calls;
      const [, implementation] = call?.arguments ?? [];
      if (call === undefined || implementation === undefined || implementation.type === 'SpreadElement') {
        expect(call).toBeDefined();
        expect(implementation).toBeDefined();
        continue;
      }
      const rejectedSchemas: string[] = [];
      const result = provesTaggedMiddlewareContext({
        call,
        file,
        implementation,
        isNativeMethod: (filename, expression, namespace, method) =>
          resolver.isNativeMethod(filename, expression, namespace, method),
        isServiceFreeSchema: (request) => {
          const proved = resolver.isServiceFreeSchema(request);
          if (!proved) {
            rejectedSchemas.push(`${path.relative(app, request.file)}:${request.expression.start}`);
          }
          return proved;
        },
        kind,
        program,
        resolveCapturedValue: (request) => resolver.resolveCapturedValue(request),
        resolveDataObjectMethod: (request) => resolver.resolveDataObjectMethod(request),
        resolveDeclaredFunction: (request) => resolver.resolveDeclaredFunction(request),
        sources,
      });
      outcomes.push({ file: relative, rejectedSchemas, result });
    }
    expect(outcomes).toEqual([
      { file: 'api/add-saved-address-action-problems.ts', rejectedSchemas: [], result: true },
      { file: 'api/archive-customer-profile-action-problems.ts', rejectedSchemas: [], result: true },
      { file: 'api/portal-auth/provider/mfa/problems.ts', rejectedSchemas: [], result: true },
      { file: 'api/portal-auth/provider/step-up/problems.ts', rejectedSchemas: [], result: true },
    ]);
  }).pipe(Effect.provide(Path.layer)),
);
