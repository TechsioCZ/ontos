import path from 'node:path';
import { createModuleGraph } from '@modern-js/code-tools/microvertical-api-boundary';
import type { SourceModule } from '@modern-js/code-tools/microvertical-api-boundary';
import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';
import { hasGeneratedGovernedConsumerAdapter } from '../generated-governed-consumer-adapter.mts';
import type { GovernedConsumerDeclaration } from '../generated-governed-consumer-adapter.mts';
import { hasGeneratedGovernedClientContract } from '../generated-module-api-boundary.mts';

const workspace = path.resolve(import.meta.dirname, '../..');
const merchandise = path.join(workspace, 'verticals/merchandise');
const facadePath = 'src/api/records-consumer.ts';
const clientPath = 'src/api/records-client.ts';
const contractPath = 'shared/apis/records.ts';
const EFFECT_SCHEMA_IMPORT = "import { Effect, Schema } from 'effect';";
const FORWARDED_READ_CALL = 'executeDecodedRecords(decoded, ...invocation)';
const FOREIGN_CLIENT = 'foreign client';
const IMPURE_DEFAULT = 'default parameter side effect';
const MISSING_CREDENTIALS = 'authorization operation without credentials';
const EAGER_SIDE_EFFECT = 'eager standalone side effect';
const UNRELATED_EXPORT = 'dead client in arbitrary export';
const FORWARDED_FILTERS = 'executeRecords(filters, ...invocation)';
const FORWARDED_OPTIONS = 'executeRecords(filters, requestCorrelation, options)';
const INVOICE_PROJECTION = 'response.state.invoices';
const EFFECT_RANDOM_SCHEMA_IMPORT = "import { Effect, Random, Schema } from 'effect';";
const WORK_TASKS_FORWARD = 'executeRecords(filters, requestCorrelation)';
const WORKFORCE_RANDOM = 'yield* Random.nextInt';
const FRESH_FORWARD = 'executeRecords(payload, requestCorrelation, options)';
const FRESH_OPTION_VALUE = "requestCache: 'no-store'";
const UNDECODED_PAYLOAD = 'undecoded payload';
const FALLBACK_AUTHORITY = 'fallback authority';
const CHANGED_CORRELATION = 'changed correlation';
const CHANGED_PAYLOAD = 'changed payload';
const DECODE_RECORDS_PAYLOAD = 'Schema.decodeEffect(RecordsRequestSchema)(payload)';
const CLIENT_EXPORT_SUFFIX = "} from './records-client.ts';";
const FOREIGN_CLIENT_EXPORT_SUFFIX = "} from './foreign-client.ts';";
// `$` as an escape, so the literal `${…}` of a replaced correlation label is never read as interpolation.
const DOLLAR = '\u0024';
const WORKFORCE_LABEL = `\`workforce:list:${DOLLAR}{nonce}\``;
const WORKFORCE_ALTERNATE_LABEL = `\`workforce:list:${DOLLAR}{payload}\``;
const WORKFORCE_READ = `yield* executeRecords({}, ${WORKFORCE_LABEL})`;
const FOREIGN_EFFECT =
  'export const Effect = { all: (v) => v, fn: (f) => f, flatMap: (f) => f, map: (f) => f, orElse: (f) => f, succeed: (v) => v }; export const Random = { nextInt: 0 }; export const Schema = { decodeEffect: (s) => (v) => v };';

const matchesOriginalOperation = (
  graph: ReturnType<typeof createModuleGraph>,
  originalModule: SourceModule,
  selected: GovernedConsumerDeclaration,
): boolean =>
  ['executeRecords', 'executeRecordsWithAuthorization'].some((operationName) => {
    const original = graph.resolve(originalModule, operationName, 'export');
    return original?.kind === 'declaration' && original.expression === selected.expression;
  });

const adapterAcceptance = (
  root: string,
  graph: ReturnType<typeof createModuleGraph>,
  module: SourceModule,
  originalModule: SourceModule,
  generated: boolean,
) => {
  const schema = graph.resolve(graph.module(path.join(root, contractPath)), 'RecordsRequestSchema', 'export');
  return (name: string, enrolled = true) => {
    const selected = graph.resolve(module, name, 'export');
    if (selected?.kind !== 'declaration') {
      return false;
    }
    return hasGeneratedGovernedConsumerAdapter({
      graph,
      isOwnerSource: (candidate) => candidate.path.startsWith(`${root}/`) && !candidate.path.includes('/src/database/'),
      originalRequestSchema: (operation): GovernedConsumerDeclaration | undefined => {
        if (
          !enrolled ||
          !generated ||
          operation.module.path !== originalModule.path ||
          schema?.kind !== 'declaration'
        ) {
          return undefined;
        }
        return matchesOriginalOperation(graph, originalModule, operation) ? schema : undefined;
      },
      selected,
    });
  };
};

const fixture = (change: (source: string) => string = (source) => source) =>
  Effect.gen(function* makeAdapterFixture() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'governed-adapter-' });
    const original = yield* fs.readFileString(path.join(merchandise, facadePath));
    const source = change(original);
    const client = yield* fs.readFileString(path.join(merchandise, clientPath));
    const contract = yield* fs.readFileString(path.join(merchandise, contractPath));
    yield* fs.makeDirectory(path.join(root, 'src/api'), { recursive: true });
    yield* fs.makeDirectory(path.join(root, 'src/database'), { recursive: true });
    yield* fs.makeDirectory(path.join(root, 'shared/apis'), { recursive: true });
    yield* fs.writeFileString(path.join(root, 'package.json'), '{"name":"@app/governed-adapter-fixture"}');
    yield* fs.writeFileString(path.join(root, facadePath), source);
    yield* fs.writeFileString(path.join(root, clientPath), client);
    yield* fs.writeFileString(path.join(root, contractPath), contract);
    yield* fs.writeFileString(path.join(root, 'shared/apis/foreign.ts'), contract);
    yield* fs.writeFileString(path.join(root, 'src/api/foreign-client.ts'), client);
    yield* fs.writeFileString(path.join(root, 'src/database/records-client.ts'), client);
    yield* fs.writeFileString(
      path.join(root, 'src/api/foreign-effect.ts'),
      'export const Effect = { flatMap: (f) => f, map: (f) => f }; export const Schema = { decodeEffect: (s) => (v) => v };',
    );
    const graph = createModuleGraph();
    const module = graph.module(path.join(root, facadePath));
    const originalModule = graph.module(path.join(root, clientPath));
    // Stand in for the host's existing enrollment callback, using the original
    // generated client proof as well as exact operation and schema identities.
    const generated = hasGeneratedGovernedClientContract(client, {
      authorizedOperation: 'executeRecordsWithAuthorization',
      defaultApiPrefix: '/merchandise-api',
      endpointGroup: 'records',
      generatedHeader: '// @generated by OntOS Codesmith module-api v1\n',
      invocationKind: 'module-api',
      ownerApiValue: 'RecordsApi',
      ownerContractImport: '../../shared/apis/records.ts',
      publicOperation: 'executeRecords',
    });
    expect(generated).toBe(true);
    const accepts = adapterAcceptance(root, graph, module, originalModule, generated);
    return { accepts, original, source };
  });

for (const name of [
  'executeRecords',
  'executeRecordsWithAuthorization',
  'listProducts',
  'listOrders',
  'listMovements',
]) {
  it.effect(`proves the actual ${name} facade and rejects absent enrollment`, () =>
    Effect.gen(function* originalFacade() {
      const { accepts } = yield* fixture();
      expect(accepts(name)).toBe(true);
      expect(accepts(name, false)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect('tracks native Effect, Schema and original schema import aliases', () =>
  Effect.gen(function* importAliases() {
    const { accepts } = yield* fixture((source) =>
      source
        .replace(EFFECT_SCHEMA_IMPORT, "import { Effect as Fx, Schema as Codec } from 'effect';")
        .replace('import { RecordsRequestSchema }', 'import { RecordsRequestSchema as OriginalRequest }')
        .replaceAll('Schema.decodeEffect(RecordsRequestSchema)', 'Codec.decodeEffect(OriginalRequest)')
        .replaceAll('Effect.flatMap', 'Fx.flatMap')
        .replaceAll('Effect.map', 'Fx.map'),
    );
    expect(accepts('executeRecords')).toBe(true);
    expect(accepts('executeRecordsWithAuthorization')).toBe(true);
    expect(accepts('listProducts')).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const mutations: readonly (readonly [string, (source: string) => string])[] = [
  [
    'foreign request schema',
    (source) =>
      source.replace(
        "import { RecordsRequestSchema } from '../../shared/apis/records.ts';",
        "import { RecordsRequestSchema } from '../../shared/apis/foreign.ts';",
      ),
  ],
  [FOREIGN_CLIENT, (source) => source.replace("from './records-client.ts'", "from './foreign-client.ts'")],
  [
    'private client source',
    (source) => source.replace("from './records-client.ts'", "from '../database/records-client.ts'"),
  ],
  [
    'foreign Effect',
    (source) =>
      source.replace(
        EFFECT_SCHEMA_IMPORT,
        "import { Schema } from 'effect'; import { Effect } from './foreign-effect.ts';",
      ),
  ],
  [
    'foreign Schema',
    (source) =>
      source.replace(
        EFFECT_SCHEMA_IMPORT,
        "import { Effect } from 'effect'; import { Schema } from './foreign-effect.ts';",
      ),
  ],
  [UNDECODED_PAYLOAD, (source) => source.replace(FORWARDED_READ_CALL, 'executeDecodedRecords(payload, ...invocation)')],
  ['different decoded input', (source) => source.replaceAll(')(payload).pipe', ')({}).pipe')],
  ['missing invocation', (source) => source.replace(FORWARDED_READ_CALL, 'executeDecodedRecords(decoded)')],
  [
    'extra invocation argument',
    (source) => source.replace(FORWARDED_READ_CALL, "executeDecodedRecords(decoded, ...invocation, 'extra')"),
  ],
  [
    'replacement credential',
    (source) =>
      source.replace(
        'executeDecodedRecordsWithAuthorization(decoded, ...invocation)',
        "executeDecodedRecordsWithAuthorization(decoded, 'credential', ...invocation)",
      ),
  ],
  [
    'replacement rest context',
    (source) => source.replace(FORWARDED_READ_CALL, 'executeDecodedRecords(decoded, ...[])'),
  ],
  [
    'rest shadowed by callback',
    (source) =>
      source.replace(
        'Effect.flatMap((decoded) => executeDecodedRecords(decoded, ...invocation))',
        'Effect.flatMap((invocation) => executeDecodedRecords(invocation, ...invocation))',
      ),
  ],
  [
    FALLBACK_AUTHORITY,
    (source) =>
      source.replace(
        FORWARDED_READ_CALL,
        'executeDecodedRecords(decoded, ...invocation).pipe(Effect.orElse(() => fetch("/fallback")))',
      ),
  ],
  [
    'detached client decoy',
    (source) =>
      source.replace(
        FORWARDED_READ_CALL,
        '(executeDecodedRecords(decoded, ...invocation), Effect.succeed({ products: [] }))',
      ),
  ],
  [
    'callback hidden side effect',
    (source) => source.replace(FORWARDED_READ_CALL, '(fetch("/leak"), executeDecodedRecords(decoded, ...invocation))'),
  ],
  ['asynchronous callback', (source) => source.replace('Effect.flatMap((decoded)', 'Effect.flatMap(async (decoded)')],
  [
    IMPURE_DEFAULT,
    (source) => source.replace('payload: RecordsRequestEncoded,', 'payload: RecordsRequestEncoded = fetch("/leak"),'),
  ],
  [
    'mutated context',
    (source) => source.replace(FORWARDED_READ_CALL, 'executeDecodedRecords(decoded, ...(invocation.reverse()))'),
  ],
  [
    MISSING_CREDENTIALS,
    (source) => source.replace('executeRecords(viewPayload(view)', 'executeRecordsWithAuthorization(viewPayload(view)'),
  ],
  [
    CHANGED_CORRELATION,
    (source) => source.replace('viewPayload(view), requestCorrelation', 'viewPayload(view), "other"'),
  ],
  [
    'extra projection argument',
    (source) => source.replace('viewPayload(view), requestCorrelation', 'viewPayload(view), requestCorrelation, {}'),
  ],
  ['projection side effect', (source) => source.replace('response.products', '(fetch("/leak"), response.products)')],
  ['projection callback invocation', (source) => source.replace('response.products', 'response.products()')],
  ['map replaced by flatMap', (source) => source.replace('Effect.map((response)', 'Effect.flatMap((response)')],
  [
    'impure request constructor',
    (source) => source.replace('view === undefined ? {} : { view }', 'view === undefined ? fetch("/leak") : { view }'),
  ],
  ['eager hidden side effect', (source) => `${source}\nconst unused = fetch('/leak');\n`],
  [EAGER_SIDE_EFFECT, (source) => `${source}\nfetch('/leak');\n`],
  ['side-effect import', (source) => `import './foreign-effect.ts';\n${source}`],
  ['unused network authority', (source) => `import { request } from 'node:http';\n${source}`],
  ['mutation', (source) => `${source}\nexecuteRecords.extra = true;\n`],
  [
    UNRELATED_EXPORT,
    (source) => `${source}\nexport const unrelated = () => { void executeRecords; return fetch('/other'); };\n`,
  ],
];

for (const [name, change] of mutations) {
  it.effect(`rejects ${name}`, () =>
    Effect.gen(function* rejectUnsafeAdapter() {
      const { accepts, original, source } = yield* fixture(change);
      expect(source).not.toBe(original);
      expect(accepts('executeRecords')).toBe(false);
      expect(accepts('listProducts')).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect('does not publish a pure request helper as a governed operation', () =>
  Effect.gen(function* noArbitraryFunctionExports() {
    const { accepts } = yield* fixture((source) => source.replace('const viewPayload', 'export const viewPayload'));
    expect(accepts('executeRecords')).toBe(true);
    expect(accepts('viewPayload')).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const RECORDS_FACADE_PATH = 'src/api/records-consumer.ts';
const RECORDS_CLIENT_PATH = 'src/api/records-client.ts';
const RECORDS_CONTRACT_PATH = 'shared/apis/records.ts';

/**
 * The real consumed verticals, copied verbatim from the workspace so each proof runs against the shipped source
 * rather than a paraphrase. `change` mutates only the facade, the file the adapter must prove.
 */
const realVerticalFixture = (vertical: string, change: (source: string) => string = (source) => source) =>
  Effect.gen(function* makeRealVerticalFixture() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: `governed-real-${vertical}-` });
    const directory = path.join(workspace, 'verticals', vertical);
    const original = yield* fs.readFileString(path.join(directory, RECORDS_FACADE_PATH));
    const source = change(original);
    const client = yield* fs.readFileString(path.join(directory, RECORDS_CLIENT_PATH));
    const contract = yield* fs.readFileString(path.join(directory, RECORDS_CONTRACT_PATH));
    yield* fs.makeDirectory(path.join(root, 'src/api'), { recursive: true });
    yield* fs.makeDirectory(path.join(root, 'shared/apis'), { recursive: true });
    yield* fs.writeFileString(path.join(root, 'package.json'), `{"name":"@app/${vertical}-real-fixture"}`);
    yield* fs.writeFileString(path.join(root, RECORDS_FACADE_PATH), source);
    yield* fs.writeFileString(path.join(root, RECORDS_CLIENT_PATH), client);
    yield* fs.writeFileString(path.join(root, RECORDS_CONTRACT_PATH), contract);
    yield* fs.writeFileString(path.join(root, 'shared/apis/foreign.ts'), contract);
    yield* fs.writeFileString(path.join(root, 'src/api/foreign-client.ts'), client);
    yield* fs.writeFileString(path.join(root, 'src/api/foreign-effect.ts'), FOREIGN_EFFECT);
    const graph = createModuleGraph();
    const module = graph.module(path.join(root, RECORDS_FACADE_PATH));
    const originalModule = graph.module(path.join(root, RECORDS_CLIENT_PATH));
    const generated = hasGeneratedGovernedClientContract(client, {
      authorizedOperation: 'executeRecordsWithAuthorization',
      defaultApiPrefix: `/${vertical}-api`,
      endpointGroup: 'records',
      generatedHeader: '// @generated by OntOS Codesmith module-api v1\n',
      invocationKind: 'module-api',
      ownerApiValue: 'RecordsApi',
      ownerContractImport: '../../shared/apis/records.ts',
      publicOperation: 'executeRecords',
    });
    expect(generated).toBe(true);
    const accepts = adapterAcceptance(root, graph, module, originalModule, generated);
    return { accepts, original, source };
  });

const consumedFacades: readonly (readonly [string, readonly string[]])[] = [
  ['sales-pipeline', ['executeRecords', 'executeRecordsWithAuthorization', 'listOpportunities']],
  ['finance-billing', ['listInvoices']],
  ['workforce', ['executeRecords', 'executeRecordsWithAuthorization', 'executeFreshRecords', 'listEmployees']],
  ['work-tasks', ['executeRecords', 'executeRecordsWithAuthorization', 'listTasks']],
];

for (const [vertical, operations] of consumedFacades) {
  it.effect(`proves the real ${vertical} consumed facade and rejects absent enrollment`, () =>
    Effect.gen(function* realConsumedFacade() {
      const { accepts } = yield* realVerticalFixture(vertical);
      for (const operation of operations) {
        expect(accepts(operation)).toBe(true);
        expect(accepts(operation, false)).toBe(false);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

const salesPipelineFacades = ['listOpportunities', 'executeRecords'];
const financeFacades = ['listInvoices'];
const workTasksFacades = ['executeRecords', 'listTasks'];
const workforceFacades = ['executeRecords', 'executeFreshRecords', 'listEmployees'];

const salesPipelineMutations: readonly (readonly [string, (source: string) => string])[] = [
  [CHANGED_PAYLOAD, (source) => source.replace(FORWARDED_FILTERS, 'executeRecords({}, ...invocation)')],
  ['dropped rest context', (source) => source.replace(FORWARDED_FILTERS, 'executeRecords(filters)')],
  [
    'extra forwarding argument',
    (source) => source.replace(FORWARDED_FILTERS, "executeRecords(filters, ...invocation, 'extra')"),
  ],
  [
    'mutated rest context',
    (source) => source.replace(FORWARDED_FILTERS, 'executeRecords(filters, ...invocation.map((value) => value))'),
  ],
  [
    MISSING_CREDENTIALS,
    (source) => source.replace(FORWARDED_FILTERS, 'executeRecordsWithAuthorization(filters, ...invocation)'),
  ],
  [
    FALLBACK_AUTHORITY,
    (source) =>
      source.replace(
        FORWARDED_FILTERS,
        'executeRecords(filters, ...invocation).pipe(Effect.orElse(() => fetch("/fallback")))',
      ),
  ],
  [
    IMPURE_DEFAULT,
    (source) =>
      source.replace('filters: OpportunityListFilters = {}', 'filters: OpportunityListFilters = fetch("/leak")'),
  ],
  [UNDECODED_PAYLOAD, (source) => source.replaceAll(DECODE_RECORDS_PAYLOAD, 'payload')],
  [FOREIGN_CLIENT, (source) => source.replace(CLIENT_EXPORT_SUFFIX, FOREIGN_CLIENT_EXPORT_SUFFIX)],
  [EAGER_SIDE_EFFECT, (source) => `${source}\nfetch('/leak');\n`],
  [
    UNRELATED_EXPORT,
    (source) => `${source}\nexport const unrelated = () => { void executeRecords; return fetch('/other'); };\n`,
  ],
];

const financeMutations: readonly (readonly [string, (source: string) => string])[] = [
  [CHANGED_PAYLOAD, (source) => source.replace(FORWARDED_OPTIONS, 'executeRecords({}, requestCorrelation, options)')],
  [CHANGED_CORRELATION, (source) => source.replace(FORWARDED_OPTIONS, 'executeRecords(filters, "other", options)')],
  [
    'dropped client context',
    (source) => source.replace(FORWARDED_OPTIONS, 'executeRecords(filters, requestCorrelation)'),
  ],
  [
    'replacement options context',
    (source) =>
      source.replace(FORWARDED_OPTIONS, "executeRecords(filters, requestCorrelation, { requestCache: 'no-store' })"),
  ],
  [
    'extra projection argument',
    (source) => source.replace(FORWARDED_OPTIONS, 'executeRecords(filters, requestCorrelation, options, {})'),
  ],
  [
    MISSING_CREDENTIALS,
    (source) =>
      source
        .replace(
          "import { executeRecords } from './records-client.ts';",
          "import { executeRecords, executeRecordsWithAuthorization } from './records-client.ts';",
        )
        .replace(FORWARDED_OPTIONS, 'executeRecordsWithAuthorization(filters, requestCorrelation, options)'),
  ],
  [
    FOREIGN_CLIENT,
    (source) =>
      source.replace(
        "import { executeRecords } from './records-client.ts';",
        "import { executeRecords } from './foreign-client.ts';",
      ),
  ],
  [
    IMPURE_DEFAULT,
    (source) => source.replace('filters: InvoiceListFilters = {}', 'filters: InvoiceListFilters = fetch("/leak")'),
  ],
  [
    'projection side effect',
    (source) => source.replace(INVOICE_PROJECTION, '(fetch("/leak"), response.state.invoices)'),
  ],
  ['projection callback invocation', (source) => source.replace(INVOICE_PROJECTION, 'response.state.invoices()')],
  ['shallow projection', (source) => source.replace(INVOICE_PROJECTION, 'response.state')],
  ['computed projection', (source) => source.replace(INVOICE_PROJECTION, 'response["state"].invoices')],
  ['map replaced by flatMap', (source) => source.replace('Effect.map((response)', 'Effect.flatMap((response)')],
  [
    'non-governed re-export',
    (source) =>
      source.replace(
        "export { executeRecords, executeRecordsWithAuthorization } from './records-client.ts';",
        "export { Effect } from 'effect';",
      ),
  ],
  [
    'foreign re-export source',
    (source) =>
      source.replace(
        "export { executeRecords, executeRecordsWithAuthorization } from './records-client.ts';",
        "export { executeRecords, executeRecordsWithAuthorization } from './foreign-client.ts';",
      ),
  ],
  [EAGER_SIDE_EFFECT, (source) => `${source}\nfetch('/leak');\n`],
  [
    UNRELATED_EXPORT,
    (source) => `${source}\nexport const unrelated = () => { void executeRecords; return fetch('/other'); };\n`,
  ],
];

const workTasksMutations: readonly (readonly [string, (source: string) => string])[] = [
  [
    'mutated Random import',
    (source) =>
      source.replace(
        EFFECT_RANDOM_SCHEMA_IMPORT,
        "import { Effect, Schema } from 'effect';\nimport { Random } from './foreign-effect.ts';",
      ),
  ],
  [
    'mutated Effect import',
    (source) =>
      source.replace(
        EFFECT_RANDOM_SCHEMA_IMPORT,
        "import { Random, Schema } from 'effect';\nimport { Effect } from './foreign-effect.ts';",
      ),
  ],
  [
    'dropped correlation provenance',
    (source) => source.replace('Random.nextInt, Random.nextInt', 'Effect.succeed(1), Effect.succeed(2)'),
  ],
  [CHANGED_PAYLOAD, (source) => source.replace(WORK_TASKS_FORWARD, 'executeRecords({}, requestCorrelation)')],
  [CHANGED_CORRELATION, (source) => source.replace(WORK_TASKS_FORWARD, 'executeRecords(filters, "other")')],
  [
    MISSING_CREDENTIALS,
    (source) => source.replace(WORK_TASKS_FORWARD, 'executeRecordsWithAuthorization(filters, requestCorrelation)'),
  ],
  [
    'extra forwarding argument',
    (source) => source.replace(WORK_TASKS_FORWARD, "executeRecords(filters, requestCorrelation, 'extra')"),
  ],
  [
    FALLBACK_AUTHORITY,
    (source) =>
      source.replace(
        'listTasksCorrelation.pipe(Effect.flatMap((requestCorrelation) => executeRecords(filters, requestCorrelation)))',
        'listTasksCorrelation.pipe(Effect.flatMap((requestCorrelation) => executeRecords(filters, requestCorrelation)), Effect.orElse(() => fetch("/fallback")))',
      ),
  ],
  [
    IMPURE_DEFAULT,
    (source) =>
      source.replace('filters: RecordsRequestEncoded = {}', 'filters: RecordsRequestEncoded = fetch("/leak")'),
  ],
  [UNDECODED_PAYLOAD, (source) => source.replaceAll(DECODE_RECORDS_PAYLOAD, 'payload')],
  [FOREIGN_CLIENT, (source) => source.replace(CLIENT_EXPORT_SUFFIX, FOREIGN_CLIENT_EXPORT_SUFFIX)],
  [EAGER_SIDE_EFFECT, (source) => `${source}\nfetch('/leak');\n`],
  [
    UNRELATED_EXPORT,
    (source) => `${source}\nexport const unrelated = () => { void executeRecords; return fetch('/other'); };\n`,
  ],
];

const workforceMutations: readonly (readonly [string, (source: string) => string])[] = [
  [
    'mutated Random import',
    (source) =>
      source.replace(
        EFFECT_RANDOM_SCHEMA_IMPORT,
        "import { Effect, Schema } from 'effect';\nimport { Random } from './foreign-effect.ts';",
      ),
  ],
  [
    'mutated Effect import',
    (source) =>
      source.replace(
        EFFECT_RANDOM_SCHEMA_IMPORT,
        "import { Random, Schema } from 'effect';\nimport { Effect } from './foreign-effect.ts';",
      ),
  ],
  ['dropped correlation provenance', (source) => source.replace(WORKFORCE_RANDOM, 'yield* Effect.succeed(1)')],
  [CHANGED_CORRELATION, (source) => source.replace(WORKFORCE_LABEL, WORKFORCE_ALTERNATE_LABEL)],
  [
    CHANGED_PAYLOAD,
    (source) => source.replace(`executeRecords({}, ${WORKFORCE_LABEL})`, `executeRecords(payload, ${WORKFORCE_LABEL})`),
  ],
  [
    'hidden generator side effect',
    (source) =>
      source.replace(
        'const nonce = yield* Random.nextInt;',
        "const nonce = yield* Random.nextInt;\n  yield* fetch('/leak');",
      ),
  ],
  [
    MISSING_CREDENTIALS,
    (source) => source.replace(FRESH_FORWARD, 'executeRecordsWithAuthorization(payload, requestCorrelation, options)'),
  ],
  ['dropped options context', (source) => source.replace(FRESH_FORWARD, 'executeRecords(payload, requestCorrelation)')],
  [
    'changed options context',
    (source) => source.replace(FRESH_FORWARD, 'executeRecords(payload, requestCorrelation, {})'),
  ],
  ['impure options value', (source) => source.replace(FRESH_OPTION_VALUE, "requestCache: fetch('/leak')")],
  [
    FALLBACK_AUTHORITY,
    (source) => source.replace(WORKFORCE_READ, `${WORKFORCE_READ}.pipe(Effect.orElse(() => fetch("/fallback")))`),
  ],
  [
    IMPURE_DEFAULT,
    (source) =>
      source.replace(
        'payload: RecordsRequestEncoded, requestCorrelation: string',
        'payload: RecordsRequestEncoded = fetch("/leak"), requestCorrelation: string',
      ),
  ],
  [UNDECODED_PAYLOAD, (source) => source.replaceAll(DECODE_RECORDS_PAYLOAD, 'payload')],
  [FOREIGN_CLIENT, (source) => source.replace(CLIENT_EXPORT_SUFFIX, FOREIGN_CLIENT_EXPORT_SUFFIX)],
  [EAGER_SIDE_EFFECT, (source) => `${source}\nfetch('/leak');\n`],
  [
    UNRELATED_EXPORT,
    (source) => `${source}\nexport const unrelated = () => { void executeRecords; return fetch('/other'); };\n`,
  ],
];

for (const [vertical, facades, facadeMutations] of [
  ['sales-pipeline', salesPipelineFacades, salesPipelineMutations],
  ['finance-billing', financeFacades, financeMutations],
  ['work-tasks', workTasksFacades, workTasksMutations],
  ['workforce', workforceFacades, workforceMutations],
] as const) {
  for (const [name, change] of facadeMutations) {
    it.effect(`rejects the real ${vertical} ${name}`, () =>
      Effect.gen(function* rejectUnsafeRealFacade() {
        const { accepts, original, source } = yield* realVerticalFixture(vertical, change);
        expect(source).not.toBe(original);
        for (const facade of facades) {
          expect(accepts(facade)).toBe(false);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }
}
