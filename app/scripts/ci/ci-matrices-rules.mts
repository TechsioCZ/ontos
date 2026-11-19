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

/**
 * The keys each matrices document and entry may carry, and those it must carry; any other key is refused, never
 * dropped. app/scripts/tests/ci-change-plan.test.mts pins them to the fields of the schemas in ci-matrices.mts.
 */
export const CI_MATRICES_KEYS = {
  command: {
    allowed: ['artifact-units', 'commands', 'fetch_depth', 'name', 'node-artifacts', 'setup', 'typescript-build'],
    required: ['commands', 'name'],
  },
  integration: {
    allowed: ['lanes', 'name', 'native-composition', 'proof-packages', 'suite', 'tasks'],
    required: ['name', 'suite'],
  },
  matrices: {
    allowed: [ORIGINS, 'integration', ROOT_PACKAGES, 'scopes', 'source', TEST_WEIGHTS, 'unit'],
    required: ['integration', 'source', 'unit'],
  },
  scope: { allowed: ['name', 'paths', 'source'], required: ['name', 'paths', 'source'] },
} as const;

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

/** Every key the entry carries that its kind does not allow, and every key its kind requires that it lacks. */
const keyProblems = (
  where: string,
  keys: readonly string[],
  kind: { readonly allowed: readonly string[]; readonly required: readonly string[] },
) => [
  ...keys.filter((key) => !kind.allowed.includes(key)).map((key) => `${where} has the unknown key ${key}`),
  ...kind.required.filter((key) => !keys.includes(key)).map((key) => `${where} lacks the key ${key}`),
];

const commandProblems = (where: string, entry: CiCommandEntry) =>
  keyProblems(where, Object.keys(entry), CI_MATRICES_KEYS.command);

const integrationProblems = (where: string, entry: CiIntegrationEntry) => {
  const problem = integrationEntryProblem(entry);
  return [
    ...keyProblems(where, Object.keys(entry), CI_MATRICES_KEYS.integration),
    ...(CI_INTEGRATION_SUITES.includes(entry.suite) ? [] : [`${where} names no known suite`]),
    ...(entry.lanes === undefined || entry.lanes === 2 || entry.lanes === 4 ? [] : [`${where} runs 2 or 4 lanes`]),
    ...(problem === undefined ? [] : [`${where}: ${problem}`]),
  ];
};

const scopeProblems = (where: string, scope: CiScope) => [
  ...keyProblems(where, Object.keys(scope), CI_MATRICES_KEYS.scope),
  ...(scope.paths.length > 0 && scope.source.length > 0 ? [] : [`${where} needs at least one path and source row`]),
];

const rowProblems = <Entry,>(
  where: string,
  entries: readonly Entry[] | undefined,
  check: (row: string, entry: Entry) => readonly string[],
) => (entries ?? []).flatMap((entry, index) => check(`${where}[${String(index)}]`, entry));

/** Every way a matrices document breaks the keys, literal values and integration rules above. */
const documentProblems = (
  label: string,
  document: CiMatricesOverlay,
  kind: { readonly allowed: readonly string[]; readonly required: readonly string[] },
) => [
  ...keyProblems(label, Object.keys(document), kind),
  ...rowProblems(`${label} source`, document.source, commandProblems),
  ...rowProblems(`${label} unit`, document.unit, commandProblems),
  ...rowProblems(`${label} integration`, document.integration, integrationProblems),
  ...rowProblems(`${label} scopes`, document.scopes, scopeProblems),
];

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
 * The merged matrices from the base document and overlay the plan job parsed with nothing installed, or every reason
 * they cannot be planned from: a key, a suite, a lane count or an integration task this planner does not know fails the
 * plan instead of being dropped. A value of another JSON type fails the planner where it reads it, and the installed
 * tools' strict decode (scripts/ci/ci-matrices.mts) refuses it in every run.
 */
export const checkedCiMatrices = (base: CiTemplates, overlay: CiMatricesOverlay | undefined) => {
  const problems = [
    ...documentProblems('scripts/ci-matrices.json', base, CI_MATRICES_KEYS.matrices),
    ...(overlay === undefined
      ? []
      : documentProblems('the overlay', overlay, { allowed: CI_MATRICES_KEYS.matrices.allowed, required: [] })),
  ];
  return problems.length === 0 ? mergeCiMatrices(base, overlay ?? {}) : { invalid: problems.join('\n') };
};
