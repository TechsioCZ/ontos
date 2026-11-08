import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModuleGraph } from '@modern-js/code-tools/microvertical-api-boundary';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { hasSelectedOwnerContract, isImmutablePublicContract } from '../check-module-entrypoint-boundaries.mts';

const appRoot = path.resolve(import.meta.dirname, '../..');
const records = 'verticals/merchandise/shared/apis/records.ts';
const salesRecords = 'verticals/sales-pipeline/shared/apis/records.ts';
const calendarDate = 'packages/shared-contracts/src/calendar-date.ts';
const approvals = 'packages/shared-contracts/src/ai-approvals.ts';
const proposals = 'packages/shared-contracts/src/agent-proposals.ts';
const offers = 'verticals/merchandise/shared/domain/market-offers.ts';
const portal = 'verticals/commerce-customer-context/shared/portal-auth-contracts.ts';
const opportunityEvent = 'verticals/sales-pipeline/shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
const factoryResult = 'return { change, slice };';
const nonzeroFilter = '/[1-9]/u.test(value)';
const secretSource = 'export const secret = () => true;';
const midnightTemplate = `\`\${value}T00:00:00.000Z\``;
const calendarDecode = `DateTime.makeUnsafe(${midnightTemplate})`;
const calendarParse = `DateTime.make(${midnightTemplate})`;

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
const nativeSources = Effect.fn(function* discoverNativeSources(entry: string) {
  const graph = createModuleGraph();
  const sources = new Map<string, string>();
  const boundaries = new Set<string>();
  const visited = new Set<string>();
  let pending = [path.join(appRoot, entry)];
  if (entry === records || entry === salesRecords) {
    pending.push(path.join(appRoot, 'packages/shared-contracts/src/problem-details.ts'));
  }
  while (pending.length > 0) {
    const discovered = yield* Effect.forEach(
      pending,
      (absolute) =>
        Effect.gen(function* discoverNativeDependencies() {
          // Claim before filesystem work so cycles and concurrent diamond visits terminate.
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
  return { directory, metadata: decoded };
});

const withContract = (entry: string, change?: (sources: Map<string, string>) => void, selectedImport?: string) =>
  Effect.scoped(
    Effect.gen(function* classifyNativeContract() {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'native-public-contracts-'))),
        (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
      );
      const { packages, sources } = yield* nativeSources(entry);
      change?.(sources);
      const consumer = 'verticals/finance-billing/src/selected-contract.ts';
      const specifier = '@app/sales-pipeline/outbox/opportunity-stage-changed';
      if (selectedImport !== undefined) {
        sources.set(consumer, `import ${selectedImport} from '${specifier}';`);
      }
      yield* writeFixtureSource(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - verticals/*\n');
      yield* writeFixtureSource(root, 'package.json', '{"private":true}');
      const writtenPackages = yield* Effect.forEach(
        packages,
        ([directory, metadata]) => writeFixturePackage(root, directory, metadata),
        { concurrency: 4 },
      );
      const ownershipPackages = new Map(writtenPackages.map((pkg) => [pkg.directory, pkg]));
      yield* Effect.forEach(sources, ([file, source]) => writeFixtureSource(root, file, source), {
        concurrency: 4,
        discard: true,
      });
      const state = {
        businessPermissionEntries: [],
        canonicalPaths: new Map([...sources.keys()].map((file) => [file, file])),
        completeModuleApiSeams: new Map(),
        graph: createModuleGraph(),
        inventoryEntries: [],
        owners: new Map(),
        ownershipPackages,
        root,
        routeEntrypoints: [],
        sourceMap: sources,
      };
      return selectedImport === undefined
        ? isImmutablePublicContract(state, entry)
        : hasSelectedOwnerContract(
            {
              consumer,
              name: path.basename(entry, '.ts'),
              nativeApi: false,
              owner: 'verticals/sales-pipeline',
              state,
              target: entry,
            },
            specifier,
            true,
          );
    }),
  );

it.live('accepts the actual merchandise records native contract closure', () =>
  Effect.gen(function* actualMerchandiseNativeContract() {
    expect(yield* withContract(records)).toBe(true);
  }),
);

for (const entry of [salesRecords, calendarDate]) {
  it.live(`accepts the native calendar-date schema closure in ${entry}`, () =>
    Effect.gen(function* nativeTemporalSchemaContract() {
      expect(yield* withContract(entry)).toBe(true);
    }),
  );
}

for (const [name, before, after] of [
  ['transform global capture', calendarDecode, 'globalThis.decode(value)'],
  ['transform input mutation', calendarDecode, 'DateTime.makeUnsafe(value = "changed")'],
  ['transform hidden effect', calendarDecode, `(fetch("/leak"), ${calendarDecode})`],
  ['transform callback escape', calendarDecode, '() => value'],
  ['transform extra property', 'decode: (value) =>', 'authority: globalThis, decode: (value) =>'],
  ['date filter global', calendarParse, 'globalThis.parse(value)'],
  ['date filter input mutation', calendarParse, 'DateTime.make(value = "changed")'],
  ['date filter hidden effect', 'return Option.isSome(parsed)', 'return fetch("/leak") && Option.isSome(parsed)'],
  [
    'forged temporal provider',
    "import { DateTime, Option, Schema, SchemaTransformation } from 'effect';",
    "import { Option, Schema, SchemaTransformation } from 'effect'; import { DateTime } from 'forged-effect';",
  ],
  [
    'forged transformation provider',
    "import { DateTime, Option, Schema, SchemaTransformation } from 'effect';",
    "import { DateTime, Option, Schema } from 'effect'; import { SchemaTransformation } from 'forged-effect';",
  ],
] as const) {
  it.live(`rejects native calendar schema ${name}`, () =>
    Effect.gen(function* contaminatedCalendarContract() {
      expect(
        yield* withContract(calendarDate, (sources) => {
          const source = requiredSource(sources, calendarDate);
          expect(source).toContain(before);
          sources.set(calendarDate, source.replaceAll(before, after));
        }),
      ).toBe(false);
    }),
  );
}

it.live('rejects a forged Struct omission in the native sales schema closure', () =>
  Effect.gen(function* forgedStructOmission() {
    expect(
      yield* withContract(salesRecords, (sources) => {
        const file = 'verticals/sales-pipeline/shared/actions/apply-command.ts';
        sources.set(
          file,
          requiredSource(sources, file).replace(
            "import { Schema, Struct } from 'effect';",
            "import { Schema } from 'effect'; import { Struct } from 'forged-effect';",
          ),
        );
      }),
    ).toBe(false);
  }),
);

it.live('accepts the actual native factory after its local import alias changes', () =>
  Effect.gen(function* aliasedNativeFactory() {
    expect(
      yield* withContract(records, (sources) => {
        sources.set(
          records,
          requiredSource(sources, records)
            .replace('import { makeAiApprovalSchemas }', 'import { makeAiApprovalSchemas as buildApprovals }')
            .replace('= makeAiApprovalSchemas(', '= buildApprovals('),
        );
      }),
    ).toBe(true);
  }),
);

it.live('keeps erased platform types separate from unrelated runtime exports', () =>
  Effect.gen(function* erasedPlatformTypeDependency() {
    expect(
      yield* withContract(records, (sources) => {
        sources.set(
          'packages/core-runtime/src/index.ts',
          `export interface OntosResourceType { readonly key: string }\nexport { privateRuntime } from './db/private-runtime.ts';\n`,
        );
        sources.set(
          'packages/core-runtime/src/db/private-runtime.ts',
          'export const privateRuntime = () => globalThis;\n',
        );
      }),
    ).toBe(true);
  }),
);

it.live('accepts the native opportunity schemas independently of their key routine', () =>
  Effect.gen(function* nativeOpportunitySchemas() {
    expect(
      yield* withContract(opportunityEvent, (sources) => {
        const source = requiredSource(sources, opportunityEvent);
        const start = source.indexOf('/** Idempotency key =');
        const end = source.indexOf('export const outboxTopic', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        sources.set(opportunityEvent, `${source.slice(0, start)}${source.slice(end)}`);
      }),
    ).toBe(true);
  }),
);

for (const selectedImport of [
  'type { OpportunityStageChangedLine, OutboxPayload }',
  '{ OutboxPayloadSchema }',
  '{ outboxProducerModuleKey, outboxTopic }',
  '{ opportunityStageChangedIdempotencyKey }',
]) {
  it.live(`accepts the actual opportunity event selected import ${selectedImport}`, () =>
    Effect.gen(function* actualOpportunityEventContract() {
      expect(yield* withContract(opportunityEvent, undefined, selectedImport)).toBe(true);
    }),
  );
}

for (const [name, before, after] of [
  ['eager effect', '', '\nfetch("/leak");\n'],
  ['eager mutation', '', '\nOutboxPayloadSchema.authority = true;\n'],
  ['forged schema provider', "from 'effect'", "from 'forged-effect'"],
  ['private type origin', '', '\nimport type { secret } from "../src/handlers/secret.ts";\n'],
] as const) {
  it.live(`rejects selected opportunity types with ${name}`, () =>
    Effect.gen(function* contaminatedOpportunityType() {
      expect(
        yield* withContract(
          opportunityEvent,
          (sources) => {
            const source = requiredSource(sources, opportunityEvent);
            sources.set(opportunityEvent, before === '' ? `${source}${after}` : source.replace(before, after));
            sources.set('verticals/sales-pipeline/shared/src/handlers/secret.ts', secretSource);
          },
          'type { OutboxPayload }',
        ),
      ).toBe(false);
    }),
  );
}

for (const selectedImport of ['type { MissingPayload }', '{ OutboxPayload }']) {
  it.live(`rejects unresolved or runtime use of erased types ${selectedImport}`, () =>
    Effect.gen(function* invalidOpportunityTypeSelection() {
      expect(yield* withContract(opportunityEvent, undefined, selectedImport)).toBe(false);
    }),
  );
}

const hashProvider = '@noble/hashes/sha2.js';

for (const [name, provider, body, accepted] of [
  ['native hash and encoding', hashProvider, 'Hex.encode(sha256(utf8ToBytes(value)))', true],
  ['forged hash provider', 'forged-hashes', 'Hex.encode(sha256(utf8ToBytes(value)))', false],
  ['global hash replacement', hashProvider, 'globalThis.encode(value)', false],
  ['Effect authority', hashProvider, 'Effect.succeed(value)', false],
] as const) {
  it.live(`checks published deterministic identity utility ${name}`, () =>
    Effect.gen(function* selectedIdentityRoutine() {
      expect(
        yield* withContract(
          opportunityEvent,
          (sources) => {
            sources.set(
              opportunityEvent,
              `import { sha256 } from '${provider}';\nimport { utf8ToBytes } from '@noble/hashes/utils.js';\nimport { Hex } from 'effect/encoding';\nimport { Effect } from 'effect';\nexport const evidence = (value: string) => ${body};\n`,
            );
          },
          '{ evidence }',
        ),
      ).toBe(accepted);
    }),
  );
}

it.live('rejects a deterministic identity routine with a transitive global capture', () =>
  Effect.gen(function* transitiveIdentityAuthority() {
    expect(
      yield* withContract(
        opportunityEvent,
        (sources) => {
          sources.set(
            opportunityEvent,
            'const encode = (value: string) => globalThis.encode(value);\nexport const evidence = (value: string) => encode(value);\n',
          );
        },
        '{ evidence }',
      ),
    ).toBe(false);
  }),
);

it.live('does not classify ordinary contract routines as a schema-only whole module', () =>
  Effect.gen(function* mixedOpportunityContract() {
    expect(yield* withContract(opportunityEvent)).toBe(false);
  }),
);

it.live('keeps the actual portal decoder/filter closure accepted', () =>
  Effect.gen(function* actualPortalNativeContract() {
    expect(yield* withContract(portal)).toBe(true);
  }),
);

for (const [name, provider, accepted] of [
  ['native', '@modern-js/bff-effect/effect-client', true],
  ['forged', 'forged-effect-client', false],
] as const) {
  it.live(`checks a deep ${name} API composition without a numeric traversal cutoff`, () =>
    Effect.gen(function* deepApiComposition() {
      const groups = Array.from({ length: 180 }, (_, index) => `.addHttpApi(HttpApiGroup.make('group-${index}'))`).join(
        '\n',
      );
      expect(
        yield* withContract(records, (sources) => {
          sources.set(
            records,
            `import { HttpApi, HttpApiGroup } from '${provider}';\nexport const api = HttpApi.make('DeepApi')\n${groups};\n`,
          );
        }),
      ).toBe(accepted);
    }),
  );
}

const hostileCases: readonly (readonly [name: string, file: string, before: string, after: string])[] = [
  ['mutable export', records, '', '\nexport let mutableContract = true;\n'],
  ['global export', records, '', '\nexport const authority = globalThis;\n'],
  ['forged schema provider', records, "import { Schema } from 'effect';", "import { Schema } from 'forged-effect';"],
  ['factory callback escape', approvals, factoryResult, 'return { change, slice, run: () => operation };'],
  [
    'forged factory provider',
    approvals,
    "import { Effect, Option, Result, Schema } from 'effect';",
    "import { Effect, Option, Result } from 'effect'; import { Schema } from 'forged-effect';",
  ],
  ['filter global capture', offers, nonzeroFilter, 'globalThis.authority(value)'],
  ['filter input mutation', offers, nonzeroFilter, '/[1-9]/u.test(value = "1")'],
  ['filter executable result', offers, '? undefined', '? () => value'],
  ['stateful regular expression', offers, nonzeroFilter, '/[1-9]/gu.test(value)'],
  ['transitive eager mutation', approvals, '', '\nAiBatchSchema.authority = true;\n'],
  ['executable global thunk', approvals, 'Schema.suspend(() =>', 'Schema.suspend(() => (() => globalThis)() ||'],
  ['cursor formatter forgery', proposals, 'DateTime.formatIso(date)', 'globalThis.formatIso(date)'],
  ['cursor decoder forgery', proposals, 'Schema.decodeResult(Schema.DateTimeUtcFromString)(value)', 'value'],
  ['cursor callback escape', proposals, "onFailure: () => 'Invalid UTC cursor'", 'onFailure: () => globalThis'],
  ['transitive opaque global', approvals, '', '\nexport const globalAuthority = globalThis;\n'],
  ['transitive eager executable', approvals, '', '\nexport const eagerAuthority = (() => globalThis)();\n'],
  ['private executable reexport', records, '', '\nexport { secret } from "../src/handlers/secret.ts";\n'],
  ['factory binding escape', records, '', '\nexport const leakedExecutable = makeAiApprovalSchemas;\n'],

  ['factory global capture', approvals, factoryResult, 'return { change, slice, authority: globalThis };'],
  ['factory mutation', approvals, factoryResult, 'operation.authority = true; return { change, slice };'],
  ['private source dependency', records, '', '\nimport { secret } from "../src/handlers/secret.ts";\n'],
  ['private type dependency', records, '', '\nimport type { secret } from "../src/handlers/secret.ts";\n'],
  ['transitive private source', approvals, '', '\nimport { secret } from "./src/handlers/secret.ts";\n'],
];

for (const [name, file, before, after] of hostileCases) {
  it.live(`rejects native public contract ${name}`, () =>
    Effect.gen(function* contaminatedNativeContract() {
      expect(
        yield* withContract(records, (sources) => {
          const source = requiredSource(sources, file);
          const contaminated = before === '' ? `${source}${after}` : source.replace(before, after);
          expect(contaminated).not.toBe(source);
          sources.set(file, contaminated);
          sources.set('verticals/merchandise/shared/src/handlers/secret.ts', secretSource);
          sources.set('packages/shared-contracts/src/src/handlers/secret.ts', secretSource);
        }),
      ).toBe(false);
    }),
  );
}
