/**
 * The rules of the gate matrices (scripts/ci-matrices.json and the overlay a trunk names) that need no installed
 * dependency: the integration task forms, the keys and literal values every entry may carry, and how an overlay is
 * added to the base. The plan job reads the matrices with nothing installed and checks them here; the installed tools
 * decode them through scripts/ci/ci-matrices.mts, whose schemas carry the same keys and call the same rules.
 */

/** The workspace directory a package task such as `./verticals/privacy#2/8` runs in; undefined for root and whole proofs. */
export const taskDirectory = (task: string) =>
  /^\.\/(?<directory>[a-z0-9-]+(?:\/[a-z0-9-]+)*)(?:#\d+\/\d+)?$/u.exec(task)?.groups?.directory;

/** Every task form scripts/ci/run-integration-suites.sh executes; anything else widens the plan instead of vanishing. */
export const knownTask = (task: string) =>
  /^root:\d+\/\d+$/u.test(task) ||
  /^whole:(?:organization|organization-identity|customer-readback|customer-roundtrip|pricing-routes|privacy|privacy-recovery|pricing|migrations|party-worker|preproposal-basis|preproposal-approval|migrator-owner-access|stage-recovery|vat-deploy-sequence|core-runtime-migrations|customer-context-migrations|party-migrations)$/u.test(
    task,
  ) ||
  taskDirectory(task) !== undefined;

/** A source or unit row: the commands one runner runs, from app/. */
export interface CiCommandEntry {
  readonly 'artifact-units'?: string;
  readonly commands: string;
  readonly fetch_depth?: number;
  readonly name: string;
  readonly 'node-artifacts'?: boolean;
  /** Shell commands the row runs before its own, from app/: system tools or provisioned fixtures its tests need. */
  readonly setup?: string;
  readonly 'typescript-build'?: boolean;
}

export const CI_INTEGRATION_SUITES = ['bootstrap', 'integration', 'browser', 'database'] as const;

/**
 * One integration row. The database row prepares this run's database once; each owner row restores it into one
 * PostgreSQL cluster per lane and runs its tasks two at a time (scripts/ci/run-integration-suites.sh); the bootstrap
 * row proves the deployment bootstrap and the built topology; the browser row migrates its own database.
 */
export interface CiIntegrationEntry {
  readonly lanes?: 2 | 4;
  readonly name: string;
  readonly 'native-composition'?: boolean;
  readonly 'proof-packages'?: readonly string[];
  readonly suite: (typeof CI_INTEGRATION_SUITES)[number];
  readonly tasks?: readonly string[];
}

/**
 * A change confined to these paths is proved by the named source rows, the static contracts, the lint of the changed
 * files and the unit rows of the packages it changes; it builds no unit and starts no service. A path matches when it
 * matches a glob and no `!` glob. app/scripts/tests/demo-trunk-ci.test.mts proves that nothing outside those rows reads
 * a scoped file.
 */
export interface CiScope {
  readonly name: string;
  readonly paths: readonly [string, ...string[]];
  readonly source: readonly [string, ...string[]];
}

export interface CiTemplates {
  /** Public origins a unit build bakes in, as the gates' unit output cache names them (scripts/ci/unit-output-cache.mts). */
  readonly 'build-origin-variables'?: readonly string[];
  readonly integration: readonly CiIntegrationEntry[];
  /**
   * The workspace packages app/pnpm-workspace.yaml names one by one, outside `apps`, `packages` and `verticals`, each
   * named after its directory. Such a package that is not listed here leaves the workspace unaccounted: every gate runs.
   */
  readonly 'root-packages'?: readonly string[];
  readonly scopes?: readonly CiScope[];
  readonly source: readonly CiCommandEntry[];
  /** Measured seconds of a test-file family by file-name prefix; scripts/ci/rstest-weighted-shard.sh deals by it. */
  readonly 'test-weights'?: Readonly<Record<string, number>>;
  readonly unit: readonly CiCommandEntry[];
}

/** An overlay names only what it adds. */
export type CiMatricesOverlay = Partial<CiTemplates>;

const ORIGINS = 'build-origin-variables';
const ROOT_PACKAGES = 'root-packages';
const TEST_WEIGHTS = 'test-weights';

const JSON_PRIMITIVES = ['boolean', 'number', 'string'] as const;
/**
 * What an authored JSON value must be, as data. The plan job runs before anything is installed, so it cannot decode
 * authored JSON with the Effect schemas; scripts/plan-ci-without-install.sh checks each document against these
 * contracts instead, to the strictness of the schema each one mirrors, and rebuilds every object in its contract's key
 * order, as that decode does. A `tree` is a leaf of its contract, or a list or map of trees; a `closed` object refuses
 * a key it does not declare.
 */
export type CiAuthoredValue =
  | { readonly closed: boolean; readonly fields: CiAuthoredFields }
  | { readonly list: CiAuthoredValue; readonly nonEmpty?: true }
  | { readonly literals: readonly (number | string)[] }
  | { readonly map: CiAuthoredValue }
  | { readonly primitive: (typeof JSON_PRIMITIVES)[number] }
  | { readonly tree: CiAuthoredValue };
/** The keys of an object form, in the order its schema declares them. */
export type CiAuthoredFields = Readonly<Record<string, { readonly optional?: true; readonly value: CiAuthoredValue }>>;

export const CI_TEXT: CiAuthoredValue = { primitive: 'string' };
export const CI_TEXTS: CiAuthoredValue = { list: CI_TEXT };
const FLAG: CiAuthoredValue = { primitive: 'boolean' };
export const requiredField = (value: CiAuthoredValue) => ({ value });
export const optionalField = (value: CiAuthoredValue) => ({ optional: true as const, value });

const commandFields = {
  'artifact-units': optionalField(CI_TEXT),
  commands: requiredField(CI_TEXT),
  fetch_depth: optionalField({ primitive: 'number' }),
  name: requiredField(CI_TEXT),
  'node-artifacts': optionalField(FLAG),
  setup: optionalField(CI_TEXT),
  'typescript-build': optionalField(FLAG),
} satisfies CiAuthoredFields;
const integrationFields = {
  lanes: optionalField({ literals: [2, 4] }),
  name: requiredField(CI_TEXT),
  'native-composition': optionalField(FLAG),
  'proof-packages': optionalField(CI_TEXTS),
  suite: requiredField({ literals: CI_INTEGRATION_SUITES }),
  tasks: optionalField(CI_TEXTS),
} satisfies CiAuthoredFields;
const scopeFields = {
  name: requiredField(CI_TEXT),
  paths: requiredField({ list: CI_TEXT, nonEmpty: true }),
  source: requiredField({ list: CI_TEXT, nonEmpty: true }),
} satisfies CiAuthoredFields;
const matricesFields = {
  integration: requiredField({ list: { closed: true, fields: integrationFields } }),
  [ORIGINS]: optionalField(CI_TEXTS),
  [ROOT_PACKAGES]: optionalField(CI_TEXTS),
  scopes: optionalField({ list: { closed: true, fields: scopeFields } }),
  source: requiredField({ list: { closed: true, fields: commandFields } }),
  [TEST_WEIGHTS]: optionalField({ map: { primitive: 'number' } }),
  unit: requiredField({ list: { closed: true, fields: commandFields } }),
} satisfies CiAuthoredFields;

/**
 * The fields of the matrices, their rows and an overlay, as scripts/ci/ci-matrices.mts declares them;
 * app/scripts/tests/ci-change-plan.test.mts pins them to those schemas' fields and to their verdicts.
 */
export const CI_MATRICES_FIELDS = {
  command: commandFields,
  integration: integrationFields,
  matrices: matricesFields,
  /** An overlay names only what it adds: every key is optional. */
  overlay: Object.fromEntries(Object.entries(matricesFields).map(([key, field]) => [key, optionalField(field.value)])),
  scope: scopeFields,
};

/** Why an integration row cannot run as written, if it cannot. */
export const integrationEntryProblem = (entry: CiIntegrationEntry) => {
  if (entry.suite === 'integration' && (entry.tasks === undefined || entry.tasks.length === 0)) {
    return 'Integration templates must list the tasks they run';
  }
  if ((entry.tasks ?? []).some((task) => !knownTask(task))) {
    return 'Integration tasks must use a runnable task form';
  }
  return (entry.tasks ?? []).some((task) => task.startsWith('whole:preproposal-')) &&
    (entry['proof-packages']?.length ?? 0) === 0
    ? 'Native preproposal templates must name their runtime proof packages'
    : undefined;
};

/** Every integration row of a document that cannot run as written. */
const integrationProblems = (label: string, document: CiMatricesOverlay) =>
  (document.integration ?? []).flatMap((entry, index) => {
    const problem = integrationEntryProblem(entry);
    return problem === undefined ? [] : [`${label} integration[${String(index)}]: ${problem}`];
  });

interface Appended<Entry> {
  readonly entries: readonly Entry[];
  readonly repeated: readonly string[];
}
/** The base list with the overlay's entries appended, and every overlay entry either list already holds. */
const appended = <Entry,>(
  base: readonly Entry[] | undefined,
  added: readonly Entry[] | undefined,
  nameOf: (entry: Entry) => string,
): Appended<Entry> => {
  const existing = base ?? [];
  const extra = added ?? [];
  const names = new Set(existing.map(nameOf));
  return {
    entries: [...existing, ...extra],
    repeated: extra.map(nameOf).filter((name, index, all) => names.has(name) || all.indexOf(name) !== index),
  };
};
const byName = (entry: { readonly name: string }) => entry.name;
const itself = (entry: string) => entry;

/** The base with the overlay's entries added; every list and map is present, empty if neither file names it. */
export const mergeCiMatrices = (
  base: CiTemplates,
  overlay: CiMatricesOverlay,
): { readonly matrices: Required<CiTemplates> } | { readonly invalid: string } => {
  const weights = overlay[TEST_WEIGHTS] ?? {};
  const lists = {
    integration: appended(base.integration, overlay.integration, byName),
    [ORIGINS]: appended(base[ORIGINS], overlay[ORIGINS], itself),
    [ROOT_PACKAGES]: appended(base[ROOT_PACKAGES], overlay[ROOT_PACKAGES], itself),
    scopes: appended(base.scopes, overlay.scopes, byName),
    source: appended(base.source, overlay.source, byName),
    [TEST_WEIGHTS]: {
      entries: [],
      repeated: Object.keys(weights).filter((name) => Object.hasOwn(base[TEST_WEIGHTS] ?? {}, name)),
    },
    unit: appended(base.unit, overlay.unit, byName),
  };
  const [repeated] = Object.entries(lists).flatMap(([key, list]) =>
    list.repeated.length === 0 ? [] : [`The overlay repeats ${key} entries: ${list.repeated.join(', ')}`],
  );
  if (repeated !== undefined) {
    return { invalid: repeated };
  }
  return {
    matrices: {
      integration: lists.integration.entries,
      [ORIGINS]: lists[ORIGINS].entries,
      [ROOT_PACKAGES]: lists[ROOT_PACKAGES].entries,
      scopes: lists.scopes.entries,
      source: lists.source.entries,
      [TEST_WEIGHTS]: { ...base[TEST_WEIGHTS], ...weights },
      unit: lists.unit.entries,
    },
  };
};

/**
 * The merged matrices from a base document and an overlay already checked against CI_MATRICES_FIELDS, or why they
 * cannot be planned from: an integration row that cannot run, or an overlay entry the base already has.
 */
export const checkedCiMatrices = (base: CiTemplates, overlay: CiMatricesOverlay | undefined) => {
  const problems = [
    ...integrationProblems('scripts/ci-matrices.json', base),
    ...integrationProblems('the overlay', overlay ?? {}),
  ];
  return problems.length === 0 ? mergeCiMatrices(base, overlay ?? {}) : { invalid: problems.join('\n') };
};
