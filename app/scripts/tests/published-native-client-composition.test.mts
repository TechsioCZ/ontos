import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModuleGraph } from '@modern-js/code-tools/microvertical-api-boundary';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { hasPublishedNativeClientComposition } from '../published-native-client-composition.mts';
import {
  hasClosedNativeContractExpression,
  isImmutablePublicContract,
} from '../check-module-entrypoint-boundaries.mts';
import type { PublishedNativeClientComposition } from '../published-native-client-composition.mts';

const appRoot = path.resolve(import.meta.dirname, '../..');
const owner = 'verticals/party-registry';
const entry = `${owner}/src/api/customers-client.ts`;
const effectImport = "import { DateTime, Effect, Option, Random, Schema } from 'effect';";
const readCall = 'executeCustomerList(request, id)';

// The exact leaves the checker's `delegatedClientModules` enrolls for this owner aggregate.
const enrolledPaths = new Set([
  `${owner}/src/api/customer-list-client.ts`,
  `${owner}/src/api/duplicate-candidate-detail-client.ts`,
  `${owner}/src/api/party-command-client.ts`,
]);

const OWNER_PRIVATE_SOURCE =
  /(?:vertical\.(?:registration|manifest|runtime-declaration)\.[cm]?ts$|(?:^|\/)src\/(?:handlers|workers|db|database|repositories?)\/|(?:^|\/)workers\/)/u;

const requiredSource = (sources: ReadonlyMap<string, string>, file: string): string => {
  const source = sources.get(file);
  if (source === undefined) {
    throw new Error(`Missing native fixture source: ${file}`);
  }
  return source;
};

const OwnershipMetadataSchema = Schema.Struct({
  exports: Schema.Record(Schema.String, Schema.Unknown),
  name: Schema.String,
});
const decodeOwnershipMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(OwnershipMetadataSchema));

// Copy only native-resolved source dependencies, never a repository/dependency tree.
const nativeSources = Effect.fn(function* discoverNativeSources(entryPoint: string) {
  const graph = createModuleGraph();
  const sources = new Map<string, string>();
  const boundaries = new Set<string>();
  const visited = new Set<string>();
  let pending = [path.join(appRoot, entryPoint)];
  while (pending.length > 0) {
    const discovered = yield* Effect.forEach(
      pending,
      (absolute) =>
        Effect.gen(function* discoverNativeDependencies() {
          if (visited.has(absolute)) {
            return [];
          }
          visited.add(absolute);
          const module = graph.module(absolute);
          sources.set(path.relative(appRoot, absolute), yield* Effect.promise(() => readFile(absolute, 'utf-8')));
          boundaries.add(module.boundary);
          const dependencies: string[] = [];
          for (const statement of module.file.program.body) {
            if (statement.type === 'ImportDeclaration') {
              for (const specifier of statement.specifiers) {
                const binding = graph.resolve(module, specifier.local.name, 'local');
                for (const hop of binding?.chain.slice(1) ?? []) {
                  dependencies.push(hop.path);
                }
              }
            }
            if (
              (statement.type === 'ImportDeclaration' ||
                statement.type === 'ExportNamedDeclaration' ||
                statement.type === 'ExportAllDeclaration') &&
              statement.source?.value.startsWith('.') === true
            ) {
              dependencies.push(path.resolve(path.dirname(absolute), statement.source.value));
            }
          }
          return dependencies;
        }),
      { concurrency: 4 },
    );
    pending = discovered.flat();
  }
  const packages = new Map<string, string>();
  yield* Effect.forEach(
    boundaries,
    (boundary) =>
      Effect.gen(function* readNativePackage() {
        const metadata = yield* Effect.promise(() => readFile(path.join(boundary, 'package.json'), 'utf-8'));
        packages.set(path.relative(appRoot, boundary), metadata);
      }),
    { concurrency: 4, discard: true },
  );
  return { packages, sources };
});

const writeFixtureSource = Effect.fn(function* writeFixtureSource(root: string, file: string, source: string) {
  const absolute = path.join(root, file);
  yield* Effect.promise(() => mkdir(path.dirname(absolute), { recursive: true }));
  yield* Effect.promise(() => writeFile(absolute, source));
});

const writeFixturePackage = Effect.fn(function* writeFixturePackage(root: string, directory: string, metadata: string) {
  yield* writeFixtureSource(root, `${directory}/package.json`, metadata);
  const decoded = yield* decodeOwnershipMetadata(metadata);
  const link = path.join(root, 'node_modules', decoded.name);
  yield* Effect.promise(() => mkdir(path.dirname(link), { recursive: true }));
  yield* Effect.promise(() => symlink(path.join(root, directory), link, 'dir'));
});

interface CompositionOptions {
  readonly hasImmutableCapture?: PublishedNativeClientComposition['hasImmutableCapture'];
  readonly isEnrolledOperation?: PublishedNativeClientComposition['isEnrolledOperation'];
  readonly isNativeSchemaNode?: PublishedNativeClientComposition['isNativeSchemaNode'];
}

const withComposition = (
  name: string,
  change?: (sources: Map<string, string>) => void,
  options: CompositionOptions = {},
) =>
  Effect.scoped(
    Effect.gen(function* classifyNativeComposition() {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'published-native-composition-'))),
        (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
      );
      // The module graph reports real paths, so the fixture must be addressed by its real path too.
      const fixtureRoot = yield* Effect.promise(() => realpath(root));
      const { packages, sources } = yield* nativeSources(entry);
      change?.(sources);
      yield* writeFixtureSource(fixtureRoot, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - verticals/*\n');
      yield* writeFixtureSource(fixtureRoot, 'package.json', '{"private":true}');
      yield* Effect.forEach(
        packages,
        ([directory, metadata]) => writeFixturePackage(fixtureRoot, directory, metadata),
        {
          concurrency: 4,
          discard: true,
        },
      );
      yield* Effect.forEach(sources, ([file, source]) => writeFixtureSource(fixtureRoot, file, source), {
        concurrency: 4,
        discard: true,
      });
      const graph = createModuleGraph();
      const module = graph.module(path.join(fixtureRoot, entry));
      const resolved = graph.resolve(module, name, 'export');
      if (resolved?.kind !== 'declaration') {
        throw new Error(`Unresolved native composition export: ${name}`);
      }
      const relative = (candidate: { readonly path: string }) =>
        path.relative(fixtureRoot, candidate.path).split(path.sep).join('/');
      const decodedPackages = yield* Effect.all(
        [...packages].map(([directory, text]) =>
          decodeOwnershipMetadata(text).pipe(Effect.map((metadata) => [directory, { directory, metadata }] as const)),
        ),
      );
      const ownershipPackages = new Map(decodedPackages);
      const state = {
        businessPermissionEntries: [],
        canonicalPaths: new Map([...sources.keys()].map((file) => [file, file])),
        completeModuleApiSeams: new Map(),
        graph,
        inventoryEntries: [],
        owners: new Map(),
        ownershipPackages,
        root: fixtureRoot,
        routeEntrypoints: [],
        sourceMap: sources,
      };
      return hasPublishedNativeClientComposition({
        graph,
        hasImmutableCapture: options.hasImmutableCapture ?? (() => true),
        isEnrolledOperation: options.isEnrolledOperation ?? ((candidate) => enrolledPaths.has(relative(candidate))),
        isNativeSchemaNode: (candidate, node) =>
          options.isNativeSchemaNode?.(candidate, node) === true ||
          (node.type === 'CallExpression' && hasClosedNativeContractExpression(state, candidate, node)) ||
          (!relative(candidate).startsWith(`${owner}/`) &&
            node.type === 'CallExpression' &&
            isImmutablePublicContract(state, relative(candidate), new Set(), false, node)),
        isOwnerLocalNonPrivate: (candidate) => {
          const file = relative(candidate);
          return file.startsWith(`${owner}/`) && !OWNER_PRIVATE_SOURCE.test(file);
        },
        selected: { expression: resolved.expression, module: resolved.module },
      });
    }),
  );

const edit = (sources: Map<string, string>, before: string, after: string) => {
  const source = requiredSource(sources, entry);
  if (!source.includes(before)) {
    throw new Error(`Fixture edit did not match: ${before}`);
  }
  sources.set(entry, source.replace(before, after));
};

const prepend = (sources: Map<string, string>, text: string) => {
  sources.set(entry, `${text}\n${requiredSource(sources, entry)}`);
};

for (const name of ['listCustomers', 'createCustomer']) {
  it.live(`admits the authored ${name} native composition`, () =>
    Effect.gen(function* authoredComposition() {
      expect(yield* withComposition(name)).toBe(true);
    }),
  );
}

for (const [label, mutate] of [
  ['raw network read', (sources: Map<string, string>) => edit(sources, readCall, `(fetch('/leak'), ${readCall})`)],
  [
    'data helper without an enrolled invocation',
    (sources: Map<string, string>) =>
      edit(
        sources,
        `requestId('customer-list').pipe(\n    Effect.flatMap((id) => ${readCall}),\n    Effect.map(({ items }) => items),\n  )`,
        'Effect.succeed([])',
      ),
  ],
  [
    'detached enrolled operation decoy',
    (sources: Map<string, string>) =>
      edit(
        sources,
        `requestId('customer-list').pipe(\n    Effect.flatMap((id) => ${readCall}),\n    Effect.map(({ items }) => items),\n  )`,
        '(() => { void executeCustomerList; return Effect.succeed([]); })()',
      ),
  ],
  ['unused network import', (sources: Map<string, string>) => prepend(sources, "import { fetch } from 'undici';")],
  [
    'eager effect beside the selected export',
    (sources: Map<string, string>) =>
      prepend(sources, "const warm = Effect.runPromise(executeCustomerList({}, 'warm'));"),
  ],
  ['global capture', (sources: Map<string, string>) => prepend(sources, 'const leaked = globalThis;')],
  [
    'eager pipeline callback',
    (sources: Map<string, string>) => prepend(sources, "const eager = Schema.String.pipe(() => fetch('/leak'));"),
  ],
  [
    'eager named pipeline callback',
    (sources: Map<string, string>) =>
      prepend(sources, "const leak = () => fetch('/leak'); const eager = Schema.String.pipe(leak);"),
  ],
  [
    'mutation of caller collection',
    (sources: Map<string, string>) =>
      edit(
        sources,
        `Effect.flatMap((id) => ${readCall}),`,
        `Effect.flatMap((id) => { request.ids?.pop(); return ${readCall}; }),`,
      ),
  ],
  [
    'eager static class initializer',
    (sources: Map<string, string>) => prepend(sources, "class Eager { static { fetch('/leak'); } }"),
  ],
  [
    'eager effect in an imported owner helper',
    (sources: Map<string, string>) => {
      const helper = `${owner}/src/api/customer-create-decision.ts`;
      sources.set(helper, `${requiredSource(sources, helper)}\nfetch('/leak');\n`);
    },
  ],
  [
    'mutation of caller input',
    (sources: Map<string, string>) =>
      edit(
        sources,
        `Effect.flatMap((id) => ${readCall}),`,
        `Effect.flatMap((id) => { request.limit = 1; return ${readCall}; }),`,
      ),
  ],
  [
    'mutation through a caller alias',
    (sources: Map<string, string>) =>
      edit(
        sources,
        `Effect.flatMap((id) => ${readCall}),`,
        `Effect.flatMap((id) => { const borrowed = request; borrowed.limit = 1; return ${readCall}; }),`,
      ),
  ],
  [
    'private dependency',
    (sources: Map<string, string>) => {
      sources.set(`${owner}/src/db/leak.ts`, 'export const leak = () => 1;');
      prepend(sources, "import { leak } from '../db/leak.ts';");
    },
  ],
  [
    'foreign Effect provider',
    (sources: Map<string, string>) =>
      edit(
        sources,
        effectImport,
        "import { DateTime, Option, Random, Schema } from 'effect';\nimport { Effect } from 'forged-effect';",
      ),
  ],
  [
    'mutable owner capture',
    (sources: Map<string, string>) => {
      prepend(sources, 'const shared = { hits: 0 };');
      edit(
        sources,
        `Effect.flatMap((id) => ${readCall}),`,
        `Effect.flatMap((id) => { shared.hits += 1; return ${readCall}; }),`,
      );
    },
  ],
] as const) {
  it.live(`rejects the ${label} composition`, () =>
    Effect.gen(function* rejectedComposition() {
      expect(yield* withComposition('listCustomers', mutate)).toBe(false);
    }),
  );
}

it.live('rejects a composition whose leaves are not enrolled', () =>
  Effect.gen(function* unenrolledComposition() {
    expect(yield* withComposition('listCustomers', undefined, { isEnrolledOperation: () => false })).toBe(false);
  }),
);

it.live('rejects a composition the immutable-capture proof refuses', () =>
  Effect.gen(function* mutableCaptureComposition() {
    expect(yield* withComposition('listCustomers', undefined, { hasImmutableCapture: () => false })).toBe(false);
  }),
);

const closedSchemaCall: NonNullable<PublishedNativeClientComposition['isNativeSchemaNode']> = (_module, node) =>
  node.type === 'CallExpression' &&
  node.callee.type === 'MemberExpression' &&
  node.callee.property.type === 'Identifier' &&
  node.callee.property.name === 'makeFilter';

const closedSchemaCallback = (sources: Map<string, string>) =>
  edit(sources, readCall, `(Schema.makeFilter((value) => globalThis.parse(value)), ${readCall})`);

it.live('trusts a root-proven native schema node instead of reading inside it', () =>
  Effect.gen(function* provenSchemaNode() {
    expect(yield* withComposition('listCustomers', closedSchemaCallback)).toBe(false);
    expect(
      yield* withComposition('listCustomers', closedSchemaCallback, { isNativeSchemaNode: closedSchemaCall }),
    ).toBe(true);
  }),
);
