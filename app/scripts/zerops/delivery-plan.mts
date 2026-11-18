import path from 'node:path';

import { Effect, Order, Schema } from 'effect';
import { sort as sortArray } from 'effect/Array';

import {
  inside,
  isDocumentation,
  isTestInput,
  isUnitDocumentation,
  matches,
  unitIdentity as identifyUnit,
  unitInputs as collectUnitInputs,
  workspaceClosure,
} from '../ci/unit-inputs.mts';
import type { BuildDriver, DeliveryUnit, UnitInputGraph, WorkspacePackage } from '../ci/unit-inputs.mts';

export {
  buildEnvironment,
  isDocumentation,
  isReferenceSource,
  isTestInput,
  unitInputGraph,
  workspaceClosure,
} from '../ci/unit-inputs.mts';
export type { DeliveryUnit, ExcludedInput, GitEntry, UnitInputGraph, WorkspacePackage } from '../ci/unit-inputs.mts';

export const SERVICES = ['app', 'storefront', 'shop', 'n1'] as const;
export type DeliveryService = (typeof SERVICES)[number];
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Service = Schema.Literals(SERVICES);
/**
 * One run's plan, the `zerops-delivery-plan` artifact every run uploads before it changes stage. A later plan reads
 * only `services` back (a run that changed stage without being verified hands its services on), so a plan of any
 * schema version decodes as a past run's plan.
 */
export const PastPlanSchema = Schema.Struct({ services: Schema.Array(Service) });
export const DeliveryPlanSchema = Schema.Struct({
  affectedUnits: Schema.Array(Schema.String),
  base: Schema.String,
  changedPaths: Schema.Array(Schema.String),
  full: Schema.Boolean,
  migrations: Schema.Array(Schema.String),
  reasons: Schema.Array(Schema.String),
  schemaVersion: Schema.Literal(2),
  services: Schema.Array(Service),
  sourceRevision: Revision,
  /** The runs after the base that changed stage without being verified; their services are redeployed. */
  unverifiedRuns: Schema.Array(Schema.Number),
});
const STOREFRONT_DIRECTORY = 'app/akros-storefront';
const N1_DIRECTORY = 'app/n1-storefront';

export interface PriorRun {
  readonly conclusion: string | null;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly id: number;
  readonly path: string;
  readonly run_attempt: number;
  readonly run_number: number;
  readonly status: string;
}
/**
 * What an earlier run that ended without success did to stage, read from GitHub (scripts/zerops/read-delivery-history.sh):
 * `mutated` says whether any attempt reached the step that precedes every stage mutation (MUTATION_MARKER), null when
 * its jobs could not be read; `services` is its plan, null when that could not be read.
 */
export interface RunMutation {
  readonly mutated: boolean | null;
  readonly runId: number;
  readonly services: readonly DeliveryService[] | null;
}
/** The changes between the verified base and HEAD, from GitHub's compare API; null when it could not be read. */
export interface Comparison {
  readonly ancestor: boolean;
  readonly base: string;
  readonly changedPaths: readonly string[];
  /** GitHub lists at most 300 changed files; a list that may be cut short cannot select services. */
  readonly truncated: boolean;
}
export interface DeliveryInputs {
  readonly comparison: Comparison | null;
  /**
   * Every tracked path a delivered service reads: the inputs of every unit, and every file reached from the app host,
   * the migrator, the Zerops build and deploy commands and the stage delivery workflow (deliveryReads).
   */
  readonly deliveryReads: ReadonlySet<string>;
  readonly forceFull: boolean;
  readonly head: string;
  readonly mutations: readonly RunMutation[];
  readonly packages: readonly WorkspacePackage[];
  readonly previousRuns: readonly PriorRun[];
  readonly runAttempt: number;
  readonly runNumber: number;
  readonly units: readonly DeliveryUnit[];
}
/**
 * The step that runs right before the first stage mutation of a run (secret syncs and pushes come after it). A run
 * whose jobs never started it did not change stage.
 */
export const MUTATION_MARKER = 'Mark the actual deployment attempt';

/**
 * scripts/zerops/build-app.sh drives every stage unit build and exports its environment. Every script it names is an
 * input of every unit (owner-entry.mts writes the served entry into dist, its imports included) unless it is listed here.
 */
export const BUILD_DRIVER = 'app/scripts/zerops/build-app.sh';
/** Scripts build-app.sh names that write nothing into a unit's output, and why. */
export const BUILD_DRIVER_TOOLS = new Map([
  ['scripts/materialize-outbox-worker.mjs', 'bundles the Outbox Worker host, outside every unit'],
  ['scripts/outbox-worker-host.generated.mts', "lists the Outbox Worker host's owners, read only for that host"],
  ['scripts/zerops/delivery-plan-cli.mts', 'computes these identities; build-app.sh only compares them'],
  ['scripts/zerops/outbox-build-digest.mjs', 'the Outbox Worker host cache, outside every unit'],
]);
const STAGE_DRIVER: BuildDriver = { extraInputs: [], path: BUILD_DRIVER, tools: BUILD_DRIVER_TOOLS };
/** A stage unit's committed inputs, built by build-app.sh (see unitInputs of scripts/ci/unit-inputs.mts). */
export const unitInputs = (directory: string, graph: UnitInputGraph) =>
  collectUnitInputs(directory, graph, STAGE_DRIVER);
interface StageDigestInput {
  readonly environment: readonly (readonly [string, string])[];
  readonly graph: UnitInputGraph;
}
export const unitIdentity = (directory: string, input: StageDigestInput) =>
  identifyUnit(directory, { ...input, driver: STAGE_DRIVER });
export const unitInputDigest = (directory: string, input: StageDigestInput) =>
  unitIdentity(directory, input).pipe(Effect.map((identity) => identity.digest));
/** The workflow whose runs deliver stage, and the branch it delivers. */
export const STAGE_WORKFLOW = '.github/workflows/zerops-stage.yml';
export const STAGE_BRANCH = 'demo/sales-crm';
/**
 * What runs on stage or delivers it besides the units: the app host and the migrator it runs, the Zerops build, init
 * and start commands, and the stage workflow's own steps with the delivery action that holds its pushes, warm-up and
 * proofs. Every tracked file these reach is a delivery read.
 */
export const DELIVERY_ROOTS = [
  'app/scripts/zerops/app-host.mts',
  'app/scripts/run-zerops-migrator.mjs',
  'app/zerops.yaml',
  STAGE_WORKFLOW,
  '.github/actions/deliver-stage/action.yml',
] as const;
/** In shell and YAML, any slash-separated token can be a path a command reads (`$root/` and `${root}/` stripped). */
const PATH_TOKEN = /(?:\$\{?root\}?\/)?(?<value>[\w@.-]+(?:\/[\w@.-]+)+)/gu;
/**
 * Every tracked file a delivered service reads: each unit's inputs, and every file reached from DELIVERY_ROOTS through
 * the reference graph (imports, path literals, whole workspace packages) and, in shell and YAML, through path tokens
 * resolved from the repository root, from app/ and from the file's own directory. `texts` holds the text of roots the
 * graph does not read as sources (the YAML files).
 */
export const deliveryReads = (
  graph: UnitInputGraph,
  units: readonly DeliveryUnit[],
  texts: ReadonlyMap<string, string>,
) =>
  Effect.gen(function* collectDeliveryReads() {
    const reads = new Set<string>();
    for (const unit of units) {
      for (const entry of (yield* unitInputs(unit.directory, graph)).inputs) {
        reads.add(entry.path);
      }
    }
    const pending: string[] = [];
    const add = (filepath: string) => {
      if (graph.tracked.has(filepath) && !reads.has(filepath)) {
        reads.add(filepath);
        pending.push(filepath);
      }
    };
    const packagesAdded = new Set<string>();
    for (const root of DELIVERY_ROOTS) {
      add(root);
      // A root that is already a unit input is still followed.
      pending.push(root);
    }
    for (const filepath of pending) {
      const reached = graph.reach(filepath);
      for (const file of [...reached.files, ...reached.directories.flatMap((directory) => graph.under(directory))]) {
        add(file);
      }
      for (const root of reached.packages.filter((entry) => !packagesAdded.has(entry))) {
        packagesAdded.add(root);
        for (const file of graph.under(root)) {
          if (!isTestInput(file) && !isUnitDocumentation(file)) {
            add(file);
          }
        }
      }
      if (/\.(?:sh|ya?ml)$/u.test(filepath)) {
        const text = texts.get(filepath) ?? graph.workspace.sources.get(filepath) ?? '';
        for (const token of matches(PATH_TOKEN, text.replaceAll(/^[\t ]*#.*$/gmu, ''))) {
          for (const candidate of [token, `app/${token}`, path.posix.join(path.posix.dirname(filepath), token)]) {
            add(path.posix.normalize(candidate));
          }
        }
      }
    }
    return reads;
  });
const newestFirst = sortArray(Order.mapInput(Order.Number, (run: PriorRun) => -run.run_number));
/** This workflow's earlier runs on the stage branch, newest first. */
const earlierRuns = (runs: readonly PriorRun[], runNumber: number) =>
  newestFirst(
    runs.filter((run) => run.head_branch === STAGE_BRANCH && run.path === STAGE_WORKFLOW && run.run_number < runNumber),
  );
/**
 * The verified base: the newest earlier run that ended in success. A green run deployed and verified every service its
 * plan selected, and its plan held every service an earlier unverified run had changed, so stage was verified at its
 * commit. Null when no such run is in the history read.
 */
export const previousVerifiedBase = (runs: readonly PriorRun[], runNumber: number): PriorRun | null =>
  earlierRuns(runs, runNumber).find((run) => run.status === 'completed' && run.conclusion === 'success') ?? null;
/** The runs after the base, newest first: each ended without success, or has not ended. */
export const runsSinceBase = (runs: readonly PriorRun[], runNumber: number, base: PriorRun) =>
  earlierRuns(runs, runNumber).filter((run) => run.run_number > base.run_number);

/**
 * Paths no service reads by role, whatever the reference graph says: the stage delivery itself and the shared inputs
 * of every build and install. A change here deploys every service.
 */
const DELIVERY_MACHINERY: readonly RegExp[] = [
  /^\.github\/workflows\/zerops-stage\.yml$/u,
  /^\.github\/actions\//u,
  /^app\/zerops(?:-import)?\.yaml$/u,
  /^app\/(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.mise\.toml|\.npmrc)$/u,
  /^app\/patches\//u,
  /^app\/database\//u,
  /^app\/topology\//u,
];
/**
 * Paths that are read by no delivered service unless the reference graph reaches them (DeliveryInputs.deliveryReads):
 * other CI workflows, repository and lint tooling, and app scripts. A test outside every workspace package counts too.
 * The deploy scripts of app/scripts/zerops stay inputs whatever the graph says.
 */
const UNREAD_UNLESS_REACHED: readonly RegExp[] = [
  /^\.github\/workflows\//u,
  /^app\/scripts\/(?!zerops\/)/u,
  /^app\/tools\//u,
  /^app\/quality-audit\//u,
  /^app\/(?:oxfmt|oxlint|rstest)\.config\.ts$/u,
  /^app\/docker-compose\.yml$/u,
  /^app\/\.env\.example$/u,
  /^(?:app\/)?(?:\.agents|\.codex)\//u,
  /^lefthook\.yml$/u,
];
/** Why a changed path outside the storefronts and the units selects every service, or null when it selects none. */
const sharedPathReason = (filepath: string, input: DeliveryInputs): string | null => {
  if (DELIVERY_MACHINERY.some((pattern) => pattern.test(filepath))) {
    return `delivery machinery or shared install input: ${filepath}`;
  }
  if (filepath.startsWith('app/scripts/zerops/') && !isTestInput(filepath)) {
    return `stage delivery script: ${filepath}`;
  }
  if (input.deliveryReads.has(filepath)) {
    return `read by a delivered service: ${filepath}`;
  }
  const insidePackage = input.packages.some((entry) => inside(filepath, entry.directory));
  if (!insidePackage && (isTestInput(filepath) || UNREAD_UNLESS_REACHED.some((pattern) => pattern.test(filepath)))) {
    return null;
  }
  return `shared or unknown input: ${filepath}`;
};

const dependentUnitIds = (
  units: readonly DeliveryUnit[],
  closures: ReadonlyMap<string, readonly string[]>,
  directory: string,
): readonly string[] => units.filter((unit) => closures.get(unit.id)?.includes(directory) === true).map(({ id }) => id);

/** Why the plan cannot start from a verified base and a complete list of changes, or null when it can. */
const fullReleaseReason = (input: DeliveryInputs, base: PriorRun | null): string | null => {
  if (input.forceFull) {
    return 'a dispatched run deploys every service';
  }
  if (input.runAttempt > 1) {
    return 'a re-run attempt deploys every service';
  }
  if (base === null) {
    return 'no verified earlier run in the history read';
  }
  const { comparison } = input;
  if (comparison === null || comparison.base !== base.head_sha) {
    return `the changes since the verified base ${base.head_sha} could not be read`;
  }
  if (!comparison.ancestor) {
    return `the verified base ${base.head_sha} is not an ancestor of this commit`;
  }
  return comparison.truncated ? 'the list of changed files may be cut short' : null;
};

/** What a plan has selected so far, and why it deploys every service when it does. */
interface Selection {
  readonly affected: Set<string>;
  full: boolean;
  readonly migrations: string[];
  readonly reasons: string[];
  readonly selected: Set<DeliveryService>;
  readonly unverifiedRuns: number[];
}
const forceFull = (selection: Selection, reason: string) => {
  selection.full = true;
  selection.reasons.push(reason);
};

/**
 * A run since the base that changed stage and was not verified leaves its services on an unverified release: they
 * deploy again. A run that never reached the mutation marker changed nothing. Anything unknown deploys everything.
 */
const selectUnverifiedRuns = (input: DeliveryInputs, base: PriorRun, selection: Selection) => {
  for (const run of runsSinceBase(input.previousRuns, input.runNumber, base)) {
    const mutation = input.mutations.find((entry) => entry.runId === run.id);
    if (run.status !== 'completed') {
      forceFull(selection, `run ${run.id} has not ended`);
    } else if (mutation === undefined || mutation.mutated === null) {
      forceFull(selection, `whether run ${run.id} changed stage could not be read`);
    } else if (mutation.mutated) {
      selection.unverifiedRuns.push(run.id);
      if (mutation.services === null) {
        forceFull(selection, `run ${run.id} changed stage and its plan could not be read`);
      } else {
        for (const service of mutation.services) {
          selection.selected.add(service);
        }
        selection.reasons.push(
          `run ${run.id} changed ${mutation.services.join(', ') || 'nothing'} without being verified`,
        );
      }
    }
  }
};

interface Closures {
  readonly n1: readonly string[];
  readonly storefront: readonly string[];
  readonly units: ReadonlyMap<string, readonly string[]>;
}
const MIGRATION_PATH = /\/(?:drizzle\/|drizzle[^/]*\.config\.|src\/database\/|scripts\/verify-.*schema)/u;

/** An owner unit's change: the app, every unit that depends on the owner, and the storefronts built from it. */
const selectOwnerChange = (
  filepath: string,
  owner: DeliveryUnit,
  input: DeliveryInputs,
  closures: Closures,
  selection: Selection,
) => {
  selection.selected.add('app');
  for (const id of dependentUnitIds(input.units, closures.units, owner.directory)) {
    selection.affected.add(id);
  }
  if (closures.storefront.includes(owner.directory)) {
    selection.selected.add('storefront');
    selection.selected.add('shop');
  }
  if (closures.n1.includes(owner.directory)) {
    selection.selected.add('n1');
  }
  if (MIGRATION_PATH.test(filepath)) {
    selection.migrations.push(filepath);
  }
};

const selectChangedPath = (filepath: string, input: DeliveryInputs, closures: Closures, selection: Selection) => {
  if (inside(filepath, STOREFRONT_DIRECTORY)) {
    selection.selected.add('storefront');
    selection.selected.add('shop');
    for (const id of dependentUnitIds(input.units, closures.units, STOREFRONT_DIRECTORY)) {
      selection.selected.add('app');
      selection.affected.add(id);
    }
    return;
  }
  if (inside(filepath, N1_DIRECTORY)) {
    selection.selected.add('n1');
    return;
  }
  const owner = input.units.find((unit) => inside(filepath, unit.directory));
  if (owner !== undefined && !inside(filepath, `${owner.directory}/shared`)) {
    selectOwnerChange(filepath, owner, input, closures, selection);
    return;
  }
  const reason = owner === undefined ? sharedPathReason(filepath, input) : `shared unit input: ${filepath}`;
  if (reason !== null) {
    forceFull(selection, reason);
  }
};

export const planDelivery = (input: DeliveryInputs) =>
  Effect.gen(function* createDeliveryPlan() {
    const base = previousVerifiedBase(input.previousRuns, input.runNumber);
    const selection: Selection = {
      affected: new Set(),
      full: false,
      migrations: [],
      reasons: [],
      selected: new Set(),
      unverifiedRuns: [],
    };
    const fullReason = fullReleaseReason(input, base);
    if (fullReason !== null) {
      forceFull(selection, fullReason);
    }
    if (base !== null) {
      selectUnverifiedRuns(input, base, selection);
    }
    const units = new Map<string, readonly string[]>();
    for (const unit of input.units) {
      units.set(unit.id, yield* workspaceClosure(unit.directory, input.packages));
    }
    const closures: Closures = {
      n1: yield* workspaceClosure(N1_DIRECTORY, input.packages),
      storefront: yield* workspaceClosure(STOREFRONT_DIRECTORY, input.packages),
      units,
    };
    const changedPaths = selection.full ? [] : (input.comparison?.changedPaths ?? []);
    for (const filepath of changedPaths.filter((entry) => !isDocumentation(entry))) {
      selectChangedPath(filepath, input, closures, selection);
    }
    if (selection.full) {
      for (const service of SERVICES) {
        selection.selected.add(service);
      }
      for (const unit of input.units) {
        selection.affected.add(unit.id);
      }
    }
    return {
      affectedUnits: sortArray(Order.String)([...selection.affected]),
      base: base?.head_sha ?? '',
      changedPaths: input.comparison?.changedPaths ?? [],
      full: selection.full,
      migrations: selection.migrations,
      reasons: selection.reasons,
      schemaVersion: 2 as const,
      services: SERVICES.filter((service) => selection.selected.has(service)),
      sourceRevision: input.head,
      unverifiedRuns: selection.unverifiedRuns,
    };
  });
