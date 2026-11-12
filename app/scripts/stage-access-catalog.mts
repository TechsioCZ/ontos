import { Array as EffectArray, Effect, FileSystem, Order, Path, Redacted, Result, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

import {
  collectAccessCatalog,
  decodeAccessDeclaration,
  decodeAccessFieldGroups,
  decodeAccessWorkload,
} from '../packages/core-runtime/src/authorization/access-declaration.ts';
import type {
  AccessActor,
  AccessCatalogDescriptor,
  AccessCatalogModule,
  WorkloadKey,
} from '../packages/core-runtime/src/authorization/access-declaration.ts';
import { ModuleEntrypointSchema } from '../packages/core-runtime/src/modules/module-entrypoint.ts';
import {
  decodeCarrierActor,
  decodeTopologyCallerAppIds,
  isAccessCatalogContextSourcePath,
  ownerLocalImportTargets,
  scanAccessCatalogSource,
} from './authorization-catalog.mts';
import type { AccessCatalogSource, ScannedCarrier } from './authorization-catalog.mts';

/*
 * The module declarations a stage or local bootstrap starts a tenant from (O69). `bootstrapTenantAccess`
 * compiles a new tenant's release from the entries of every module the running composition declares —
 * Actions, governed reads, shell pages and field groups — so the bootstrap needs that declaration set.
 * A deployment contract cannot supply it: it carries Actions and pages but no governed read, and a release
 * built from it would deny the tenant's owner every read. Core must not read repository sources either
 * (`lean-core`), so the set is derived here, in the repository tooling, and handed to the bootstrap
 * explicitly.
 *
 * The scan is the one the catalog report makes (`authorization-catalog.mts`): production sources only,
 * static literals only. Everything that report would merely print fails the bootstrap here, because a
 * silently smaller release denies a capability instead of reporting it. `authorization-catalog-artifact.mts`
 * runs this scan to derive the pinned artifact (O69); the stage and local bootstraps read that artifact
 * rather than scanning, so this entry point stays in the repository tooling and out of Core.
 */

export class StageAccessCatalogError extends Schema.TaggedError<StageAccessCatalogError>()('StageAccessCatalogError', {
  code: Schema.Literals(['stage_access_catalog_scan_refused', 'stage_access_catalog_unreadable']),
  reason: Schema.String,
}) {}

const refusal = (code: StageAccessCatalogError['code'], reason: string): StageAccessCatalogError =>
  new StageAccessCatalogError({ code, reason });

export interface StageAccessCatalog {
  /** Validated machine purposes from every carrier, including carriers excluded from human rights. */
  readonly declaredWorkloadKeys: readonly WorkloadKey[];
  /**
   * The composition's modules in module-key order, each module's descriptors in entrypoint order.
   * They leave this module as data: the caller decodes them through Core's
   * `AccessCatalogModulesSchema`, so a scanner that drifts from the descriptor contract fails the
   * bootstrap instead of publishing a release nobody declared (O69).
   */
  readonly modules: readonly unknown[];
  readonly scannedFiles: number;
}

/** The directories a workspace root is scanned through: the set the catalog report walks. */
export const STAGE_ACCESS_CATALOG_ROOTS = ['apps', 'verticals', 'packages'] as const;

/** The topology a workspace root declares; its verticals are the only module callers a scan accepts (D5). */
export const TOPOLOGY_RELATIVE_PATH = 'topology/reference-topology.json';

/** The topology verticals of one workspace root, read from that root and never from this checkout. */
export const readTopologyCallerAppIds = (
  root: string,
): Effect.Effect<ReadonlySet<string>, StageAccessCatalogError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* readTopologyCallerAppIdsEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* fileSystem
      .readFileString(path.join(root, TOPOLOGY_RELATIVE_PATH), 'utf-8')
      .pipe(
        Effect.mapError((error) =>
          refusal('stage_access_catalog_unreadable', `${TOPOLOGY_RELATIVE_PATH} could not be read (${error.message})`),
        ),
      );
    return yield* Effect.fromResult(decodeTopologyCallerAppIds(source)).pipe(
      Effect.mapError((reason) =>
        refusal('stage_access_catalog_unreadable', `${TOPOLOGY_RELATIVE_PATH} is not a topology (${reason})`),
      ),
    );
  });

/** The entrypoint as the descriptor schema reads it; a literal carries its credential as a string. */
const entrypointOf = (carrier: ScannedCarrier) => {
  const { authorization } = carrier.entrypoint;
  return {
    access: carrier.entrypoint.access,
    authorization:
      authorization.kind === 'capability_issuance'
        ? { credential: Redacted.value(authorization.credential), kind: 'capability_issuance' as const }
        : authorization,
    entrypointKey: carrier.entrypoint.entrypointKey,
    moduleKey: carrier.entrypoint.moduleKey,
    role: carrier.entrypoint.role,
    scope: carrier.entrypoint.scope,
  };
};

const carrierRef = (carrier: ScannedCarrier): string => `${carrier.file}: ${carrier.entrypoint.entrypointKey}`;

/** The module caller of a descriptor, as the pinned artifact records it (D5): callers and subject only. */
export interface StageAccessActor {
  readonly callers: readonly string[];
  readonly subject: AccessActor['subject'];
  /** The workload keys that may stand as the subject of an identity call (workload subject), when declared. */
  readonly subjectWorkloads?: readonly string[];
}

/** The module caller of a descriptor as the pinned artifact records it: the decoded carrier, minus its reason. */
const stageActorOf = (actor: AccessActor): StageAccessActor =>
  actor.subjectWorkloads === undefined
    ? { callers: actor.callers, subject: actor.subject }
    : { callers: actor.callers, subject: actor.subject, subjectWorkloads: actor.subjectWorkloads };

/** A catalog descriptor, plus the module caller a call to it declares when it carries one. */
export type StageAccessDescriptor = AccessCatalogDescriptor & {
  readonly accessDeclaration: NonNullable<AccessCatalogDescriptor['accessDeclaration']>;
  readonly actor?: StageAccessActor;
};

/**
 * One carrier as a catalog descriptor, or `null` when it is deliberately not a catalog entry: the
 * `public`, `authenticated_principal`, `owner_local_background` and `capability_issuance` kinds declare no
 * capability, and a workload-only carrier (O59) is never granted to a person. A `protected` carrier
 * without either is the one gap that must fail, because the release would silently omit it (O62.5).
 */
const descriptorOf = (
  carrier: ScannedCarrier,
  callerAppIds: ReadonlySet<string>,
): Result.Result<
  {
    readonly declaredWorkloadKeys: readonly WorkloadKey[];
    readonly descriptor: StageAccessDescriptor | null;
    readonly moduleId: string;
  },
  StageAccessCatalogError
> =>
  Result.gen(function* descriptorGen() {
    const entrypoint = yield* Schema.decodeUnknownResult(ModuleEntrypointSchema, { onExcessProperty: 'error' })(
      entrypointOf(carrier),
    ).pipe(
      Result.mapError((issue) =>
        refusal(
          'stage_access_catalog_scan_refused',
          `${carrierRef(carrier)}: the entrypoint is invalid (${issue.message})`,
        ),
      ),
    );
    const accessDeclaration =
      carrier.accessDeclaration === null
        ? undefined
        : yield* decodeAccessDeclaration(carrier.accessDeclaration, entrypoint).pipe(
            Result.mapError((failure) =>
              refusal(
                'stage_access_catalog_scan_refused',
                `${carrierRef(carrier)}: the accessDeclaration is invalid (${failure.reason})`,
              ),
            ),
          );
    const workload =
      carrier.accessWorkload === null
        ? undefined
        : yield* decodeAccessWorkload(carrier.accessWorkload, entrypoint).pipe(
            Result.mapError((error) =>
              refusal('stage_access_catalog_scan_refused', `${carrierRef(carrier)}: ${error.reason}`),
            ),
          );
    // The `rights` rule needs its own declaration; a workload-only actor must carry neither it nor a workload marker.
    const actor =
      carrier.accessActor === null
        ? undefined
        : yield* decodeCarrierActor(carrier.accessActor, entrypoint, accessDeclaration, callerAppIds, workload).pipe(
            Result.mapError((reason) =>
              refusal(
                'stage_access_catalog_scan_refused',
                `${carrierRef(carrier)}: the accessActor is invalid (${reason})`,
              ),
            ),
          );
    const declaredWorkloadKeys = [...(workload?.workloads ?? []), ...(actor?.subjectWorkloads ?? [])];
    if (accessDeclaration === undefined) {
      if ((carrier.accessFieldGroups?.length ?? 0) > 0) {
        return yield* Result.fail(
          refusal(
            'stage_access_catalog_scan_refused',
            `${carrierRef(carrier)}: accessFieldGroups require the descriptor to declare its own accessDeclaration`,
          ),
        );
      }
      // A validated actor-only or workload-only carrier grants no catalog cells.
      return { declaredWorkloadKeys, descriptor: null, moduleId: entrypoint.moduleKey };
    }
    const groups = yield* decodeAccessFieldGroups(
      carrier.accessFieldGroups ?? [],
      entrypoint,
      accessDeclaration.key,
    ).pipe(
      Result.mapError((failure) =>
        refusal(
          'stage_access_catalog_scan_refused',
          `${carrierRef(carrier)}: an accessFieldGroup is invalid (${failure.reason})`,
        ),
      ),
    );
    const withGroups =
      groups.length === 0
        ? { accessDeclaration, entrypoint }
        : { accessDeclaration, accessFieldGroups: groups, entrypoint };
    return {
      declaredWorkloadKeys,
      descriptor: actor === undefined ? withGroups : { ...withGroups, actor: stageActorOf(actor) },
      moduleId: entrypoint.moduleKey,
    };
  });

/** One entrypoint may be carried twice (a page and its navigation entry); declaring either settles it. */
const entrypointIdOf = (carrier: ScannedCarrier): string =>
  `${carrier.entrypoint.moduleKey}\u0000${carrier.entrypoint.entrypointKey}`;

/** The same scan the catalog report makes, as the declaration set a bootstrap compiles a release from. */
export const stageAccessModulesFromSources = (
  sources: readonly AccessCatalogSource[],
  callerAppIds: ReadonlySet<string>,
): Effect.Effect<StageAccessCatalog, StageAccessCatalogError> =>
  Effect.gen(function* stageAccessModules() {
    const carriers: ScannedCarrier[] = [];
    const moduleSources = new Map(sources.map(({ file, source }) => [file, source] as const));
    for (const source of sources) {
      const { file } = source;
      const scanned = scanAccessCatalogSource(source.source, file, moduleSources);
      const [problem] = scanned.problems;
      if (problem !== undefined) {
        return yield* refusal('stage_access_catalog_scan_refused', `${problem.file}: ${problem.reason}`);
      }
      carriers.push(...scanned.carriers);
    }
    const declaredIds: ReadonlySet<string> = new Set(
      carriers.filter((carrier) => carrier.accessDeclaration !== null).map(entrypointIdOf),
    );
    // The order of the modules and their descriptors never matters: `buildAccessCatalogRelease` sorts the
    // entries by key, so the release identity is the declaration set and not the walk order.
    const moduleOrder: string[] = [];
    const descriptorsByModule = new Map<string, StageAccessDescriptor[]>();
    const seen = new Set<string>();
    const declaredWorkloadKeys = new Set<WorkloadKey>();
    for (const carrier of carriers) {
      const declared = descriptorOf(carrier, callerAppIds);
      if (Result.isFailure(declared)) {
        return yield* declared.failure;
      }
      for (const key of declared.success.declaredWorkloadKeys) {
        declaredWorkloadKeys.add(key);
      }
      // A protected entrypoint that no copy of it declares is a gap in the composition, not a gap to skip:
      // releasing nothing for it would deny the tenant's owner a capability the composition serves (O62.5).
      if (
        carrier.entrypoint.authorization.kind === 'protected' &&
        carrier.accessWorkload === null &&
        carrier.accessActor === null &&
        !declaredIds.has(entrypointIdOf(carrier))
      ) {
        return yield* refusal(
          'stage_access_catalog_scan_refused',
          `${carrierRef(carrier)}: a protected entrypoint carries neither accessDeclaration, accessWorkload nor accessActor`,
        );
      }
      const { descriptor, moduleId } = declared.success;
      if (descriptor === null) {
        continue;
      }
      // Navigation and its destination page may share an entrypoint but declare distinct cells.
      const declarationId = `${entrypointIdOf(carrier)}:${descriptor.accessDeclaration.key}`;
      if (!seen.has(declarationId)) {
        seen.add(declarationId);
        const descriptors = descriptorsByModule.get(moduleId);
        if (descriptors === undefined) {
          moduleOrder.push(moduleId);
          descriptorsByModule.set(moduleId, [descriptor]);
        } else {
          descriptors.push(descriptor);
        }
      }
    }
    const modules: readonly AccessCatalogModule[] = moduleOrder.map((moduleId): AccessCatalogModule => ({
      descriptors: descriptorsByModule.get(moduleId) ?? [],
      moduleId,
    }));
    // Core's own collector is the last word: a release that cannot be collected must not be published.
    const collected = collectAccessCatalog(modules);
    if (Result.isFailure(collected)) {
      return yield* refusal(
        'stage_access_catalog_scan_refused',
        `${collected.failure.code}: ${collected.failure.reason}`,
      );
    }
    return {
      declaredWorkloadKeys: EffectArray.sort(declaredWorkloadKeys, Order.String),
      modules,
      scannedFiles: sources.length,
    };
  });

/** Every source under one root the catalog scan reads: the same walk the report makes. */
const readSources = (
  root: string,
): Effect.Effect<readonly AccessCatalogSource[], PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* readSourcesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const walk = (
      directory: string,
    ): Effect.Effect<readonly string[], PlatformError, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function* walkEffect() {
        const exists = yield* fileSystem.exists(directory);
        if (!exists) {
          return [];
        }
        const entries = yield* fileSystem.readDirectory(directory);
        const found: (readonly string[])[] = [];
        for (const entry of entries) {
          if (entry === 'node_modules' || entry === '.output' || entry.startsWith('dist')) {
            continue;
          }
          const entryPath = path.join(directory, entry);
          const info = yield* fileSystem.stat(entryPath);
          found.push(info.type === 'Directory' ? yield* walk(entryPath) : [entryPath]);
        }
        return found.flat();
      });
    const sources: AccessCatalogSource[] = [];
    for (const segment of STAGE_ACCESS_CATALOG_ROOTS) {
      for (const file of yield* walk(path.join(root, segment))) {
        const relative = path.relative(root, file).replaceAll('\\', '/');
        if (!isAccessCatalogContextSourcePath(relative)) {
          continue;
        }
        const source = yield* fileSystem.readFileString(file, 'utf-8');
        // Mutation-only importers are custody evidence even when they declare no carrier themselves.
        sources.push({ file: relative, source });
      }
    }
    return sources;
  });

/**
 * The module-local files that named constant imports of `sources` read, appended to them when they are not
 * already present. A support file declares no entrypoint of its own: it only supplies imported constants.
 * A target that does not exist stays unresolved, so the scan refuses the reference instead of guessing.
 */
export const withOwnerLocalImportSources = (
  root: string,
  sources: readonly AccessCatalogSource[],
): Effect.Effect<readonly AccessCatalogSource[], PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* withOwnerLocalImportSourcesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const known = new Set(sources.map(({ file }) => file));
    const support: AccessCatalogSource[] = [];
    const pending = [...sources];
    for (const { file, source } of pending) {
      for (const target of ownerLocalImportTargets(source, file)) {
        if (known.has(target)) {
          continue;
        }
        known.add(target);
        const absolute = path.join(root, target);
        if (yield* fileSystem.exists(absolute)) {
          const dependency = { file: target, source: yield* fileSystem.readFileString(absolute, 'utf-8') };
          support.push(dependency);
          pending.push(dependency);
        }
      }
    }
    return [...sources, ...support];
  });

/**
 * The declaration set of a workspace: what a stage or local bootstrap hands `bootstrapTenantAccess`.
 * A workspace whose sources cannot be read is a configuration failure, never an empty release.
 */
export const loadStageAccessModules = Effect.fn('StageAccessCatalog.load')(function* loadStageAccessModulesEffect(
  root: string,
): Effect.fn.Return<StageAccessCatalog, StageAccessCatalogError, FileSystem.FileSystem | Path.Path> {
  const sources = yield* readSources(root).pipe(
    Effect.flatMap((found) => withOwnerLocalImportSources(root, found)),
    Effect.catchTag('PlatformError', (error) =>
      Effect.fail(
        refusal('stage_access_catalog_unreadable', `the repository sources could not be read (${error.message})`),
      ),
    ),
  );
  const callerAppIds = yield* readTopologyCallerAppIds(root);
  return yield* stageAccessModulesFromSources(sources, callerAppIds);
});
