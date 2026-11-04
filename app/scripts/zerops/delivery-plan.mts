import { createHash } from 'node:crypto';

import { Effect, Order, Schema } from 'effect';
import { sort as sortArray } from 'effect/Array';

export const SERVICES = ['app', 'storefront', 'shop', 'n1'] as const;
export type DeliveryService = (typeof SERVICES)[number];
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
// `n1` is optional: receipts written before the N1 service existed carry no pin for it, and must still decode.
const SourcePins = Schema.Struct({
  app: Revision,
  n1: Schema.optionalKey(Revision),
  shop: Revision,
  storefront: Revision,
});
export const DeliveryAttemptSchema = Schema.Struct({
  runAttempt: Schema.Number,
  runId: Schema.Number,
  sourceRevision: Revision,
});
export type DeliveryAttempt = typeof DeliveryAttemptSchema.Type;
export const DeliveryReceiptSchema = Schema.Struct({
  lastAttempt: DeliveryAttemptSchema,
  runAttempt: Schema.Number,
  runId: Schema.Number,
  schemaVersion: Schema.Literal(1),
  services: SourcePins,
  validatedHead: Revision,
});
export type DeliveryReceipt = typeof DeliveryReceiptSchema.Type;
export const DeliveryPlanSchema = Schema.Struct({
  affectedUnits: Schema.Array(Schema.String),
  base: Schema.String,
  changedPaths: Schema.Array(Schema.String),
  full: Schema.Boolean,
  migrations: Schema.Array(Schema.String),
  reasons: Schema.Array(Schema.String),
  receipt: DeliveryReceiptSchema,
  schemaVersion: Schema.Literal(1),
  services: Schema.Array(Schema.Literals(SERVICES)),
  sourceRevision: Revision,
});
const DigestInputsSchema = Schema.Struct({
  closure: Schema.Array(Schema.String),
  inputs: Schema.Array(Schema.Struct({ identity: Schema.String, path: Schema.String })),
  origins: Schema.Array(Schema.String),
  version: Schema.Literal(2),
});
const STOREFRONT_DIRECTORY = 'app/akros-storefront';
const N1_DIRECTORY = 'app/n1-storefront';

export interface WorkspacePackage {
  readonly directory: string;
  readonly name: string;
  readonly workspaceDependencies: readonly string[];
}
export interface DeliveryUnit {
  readonly directory: string;
  readonly id: string;
}
export interface GitEntry {
  readonly identity: string;
  readonly path: string;
}
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
export interface DeliveryInputs {
  readonly ancestor: boolean;
  readonly changedPaths: readonly string[];
  readonly forceFull: boolean;
  readonly head: string;
  readonly packages: readonly WorkspacePackage[];
  readonly previousAttempt: DeliveryAttempt | null;
  readonly previousReceipt: DeliveryReceipt | null;
  readonly previousRuns: readonly PriorRun[];
  readonly runAttempt: number;
  readonly runId: number;
  readonly runNumber: number;
  readonly units: readonly DeliveryUnit[];
}
export class WorkspaceInputsInvalid extends Schema.TaggedError<WorkspaceInputsInvalid>()('WorkspaceInputsInvalid', {
  reason: Schema.String,
}) {}

export const isDocumentation = (filepath: string): boolean =>
  filepath.startsWith('docs/') ||
  filepath.startsWith('app/docs/') ||
  /(?:^|\/)(?:README|AGENTS|CLAUDE|CONTRIBUTING|SECURITY|CHANGELOG|LICENSE)\.md$/u.test(filepath);
const inside = (filepath: string, directory: string): boolean => filepath.startsWith(`${directory}/`);

/** Resolve committed workspace manifests, not node_modules symlinks or the runner's installed graph. */
export const workspaceClosure = (directory: string, packages: readonly WorkspacePackage[]) =>
  Effect.gen(function* resolveWorkspaceClosure() {
    const byName = new Map(packages.map((entry) => [entry.name, entry]));
    const byDirectory = new Map(packages.map((entry) => [entry.directory, entry]));
    const seen = new Set<string>();
    const pending = [directory];
    for (const current of pending) {
      if (seen.has(current)) {
        continue;
      }
      const entry = byDirectory.get(current);
      if (entry === undefined) {
        return yield* new WorkspaceInputsInvalid({ reason: `Missing workspace manifest: ${current}` });
      }
      seen.add(current);
      for (const name of entry.workspaceDependencies) {
        const dependency = byName.get(name);
        if (dependency === undefined) {
          return yield* new WorkspaceInputsInvalid({ reason: `Unresolved workspace dependency ${name} in ${current}` });
        }
        pending.push(dependency.directory);
      }
    }
    return sortArray(Order.String)([...seen]);
  });

/** Common inputs include unknown paths, root tooling, patches, scripts, topology and all shared packages.
 * Only known independent service/unit directories are excluded, then the unit's full dependency closure is added.
 */
export const unitInputDigest = (
  directory: string,
  packages: readonly WorkspacePackage[],
  units: readonly DeliveryUnit[],
  entries: readonly GitEntry[],
  origins: readonly string[],
) =>
  Effect.gen(function* digestUnitInputs() {
    const closure = yield* workspaceClosure(directory, packages);
    const independent = [...units.map((unit) => unit.directory), STOREFRONT_DIRECTORY, N1_DIRECTORY];
    const inputs = entries.filter(
      (entry) =>
        !isDocumentation(entry.path) &&
        (entry.path.includes('/shared/') ||
          !independent.some((root) => inside(entry.path, root)) ||
          closure.some((root) => inside(entry.path, root))),
    );
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(DigestInputsSchema))({
      closure,
      inputs,
      origins,
      version: 2,
    });
    return createHash('sha256').update(encoded).digest('hex');
  });

export const previousVerifiedBase = (
  receipt: DeliveryReceipt | null,
  runs: readonly PriorRun[],
  runNumber: number,
): string | null => {
  const [previous] = sortArray(Order.mapInput(Order.Number, (run: PriorRun) => -run.run_number))(
    runs.filter(
      (run) =>
        run.head_branch === 'demo/sales-crm' &&
        run.path === '.github/workflows/zerops-stage.yml' &&
        run.run_number < runNumber,
    ),
  );
  if (
    receipt === null ||
    previous === undefined ||
    previous.status !== 'completed' ||
    previous.conclusion !== 'success' ||
    previous.id !== receipt.runId ||
    previous.run_attempt !== receipt.runAttempt ||
    previous.head_sha !== receipt.validatedHead
  ) {
    return null;
  }
  return receipt.validatedHead;
};
const needsFullRelease = (input: DeliveryInputs, base: string | null) =>
  input.forceFull ||
  input.runAttempt > 1 ||
  base === null ||
  !input.ancestor ||
  input.previousAttempt?.runId !== input.previousReceipt?.lastAttempt.runId ||
  input.previousAttempt?.runAttempt !== input.previousReceipt?.lastAttempt.runAttempt ||
  input.previousAttempt?.sourceRevision !== input.previousReceipt?.lastAttempt.sourceRevision;
const nextAttempt = (input: DeliveryInputs, services: readonly DeliveryService[]) =>
  services.length > 0
    ? { runAttempt: input.runAttempt, runId: input.runId, sourceRevision: input.head }
    : input.previousReceipt?.lastAttempt;

export const planDelivery = (input: DeliveryInputs) =>
  Effect.gen(function* createDeliveryPlan() {
    const base = previousVerifiedBase(input.previousReceipt, input.previousRuns, input.runNumber);
    const reasons: string[] = [];
    let full = needsFullRelease(input, base);
    if (full) {
      reasons.push('forced, retried, missing/failed previous verified release, or non-ancestor base');
    }
    const selected = new Set<DeliveryService>();
    const affected = new Set<string>();
    const migrations: string[] = [];
    const closures = new Map<string, readonly string[]>();
    for (const unit of input.units) {
      closures.set(unit.id, yield* workspaceClosure(unit.directory, input.packages));
    }
    const storefrontClosure = yield* workspaceClosure(STOREFRONT_DIRECTORY, input.packages);
    const n1Closure = yield* workspaceClosure(N1_DIRECTORY, input.packages);
    for (const filepath of input.changedPaths.filter((entry) => !isDocumentation(entry))) {
      if (inside(filepath, STOREFRONT_DIRECTORY)) {
        selected.add('storefront');
        selected.add('shop');
        for (const unit of input.units) {
          if (closures.get(unit.id)?.includes(STOREFRONT_DIRECTORY) === true) {
            selected.add('app');
            affected.add(unit.id);
          }
        }
      } else if (inside(filepath, N1_DIRECTORY)) {
        selected.add('n1');
      } else {
        const owner = input.units.find((unit) => inside(filepath, unit.directory));
        if (owner === undefined || inside(filepath, `${owner.directory}/shared`)) {
          full = true;
          reasons.push(`shared or unknown input: ${filepath}`);
        } else {
          selected.add('app');
          for (const unit of input.units) {
            if (closures.get(unit.id)?.includes(owner.directory) === true) {
              affected.add(unit.id);
            }
          }
          if (storefrontClosure.includes(owner.directory)) {
            selected.add('storefront');
            selected.add('shop');
          }
          if (n1Closure.includes(owner.directory)) {
            selected.add('n1');
          }
          if (/\/(?:drizzle\/|drizzle[^/]*\.config\.|src\/database\/|scripts\/verify-.*schema)/u.test(filepath)) {
            migrations.push(filepath);
          }
        }
      }
    }
    if (full) {
      for (const service of SERVICES) {
        selected.add(service);
      }
      for (const unit of input.units) {
        affected.add(unit.id);
      }
    }
    const services = SERVICES.filter((service) => selected.has(service));
    // A service with no revision yet (N1 before its first deploy) carries no pin, rather than an undefined one.
    const pins = Object.fromEntries(
      SERVICES.flatMap((service) => {
        const revision = selected.has(service) ? input.head : input.previousReceipt?.services[service];
        return revision === undefined ? [] : [[service, revision]];
      }),
    );
    const receipt = yield* Schema.decodeUnknownEffect(DeliveryReceiptSchema)({
      lastAttempt: nextAttempt(input, services),
      runAttempt: input.runAttempt,
      runId: input.runId,
      schemaVersion: 1,
      services: pins,
      validatedHead: input.head,
    });
    return {
      affectedUnits: sortArray(Order.String)([...affected]),
      base: base ?? '',
      changedPaths: input.changedPaths,
      full,
      migrations,
      reasons,
      receipt,
      schemaVersion: 1 as const,
      services,
      sourceRevision: input.head,
    };
  });
