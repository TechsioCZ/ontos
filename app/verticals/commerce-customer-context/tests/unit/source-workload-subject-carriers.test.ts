import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AccessActorSchema,
  AccessWorkloadSchema,
} from '../../../../packages/core-runtime/src/authorization/access-declaration.ts';
import { isAccessCatalogSourcePath, scanAccessCatalogSource } from '../../../../scripts/authorization-catalog.mts';
import type { AccessCatalogSource, ScannedCarrier } from '../../../../scripts/authorization-catalog.mts';
import { STAGE_ACCESS_CATALOG_ROOTS, withOwnerLocalImportSources } from '../../../../scripts/stage-access-catalog.mts';

/*
 * Customer Context's owner overlay (`authorizeSourceOwnerFacts`) skips the Counterparty grant check whenever the
 * gate admitted the call for the `source-write` / `source-read` workload. The gate gives that mark to a direct
 * workload call, but also to a call made THROUGH a module: a carrier that lists one of these keys as an allowed
 * subject workload (`accessActor.subjectWorkloads`, which `subjectWorkloadCallers` narrows) admits the workload as
 * the subject of another module's call. No carrier does today; this test keeps it so. A carrier that needs it must
 * first give the overlay its own Counterparty check for module-relayed calls.
 *
 * Every carrier of every module in the workspace is read with the authorization catalogue's own source scan (the
 * one `authorization:catalog:artifact:check` runs), which, unlike the catalogue artefact, keeps actor-only and
 * workload-only carriers. A carrier the scan cannot read statically fails the test instead of being skipped.
 */

const GUARDED_WORKLOADS: ReadonlySet<string> = new Set([
  'commerce.customer-context.source-read',
  'commerce.customer-context.source-write',
]);

const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));

interface ThroughModuleListing {
  readonly entrypointKey: string;
  readonly file: string;
  readonly via: string;
  readonly workload: string;
}

const decodeActor = Schema.decodeUnknownResult(AccessActorSchema, { onExcessProperty: 'error' });
const decodeWorkload = Schema.decodeUnknownResult(AccessWorkloadSchema, { onExcessProperty: 'error' });

/** The guarded keys a carrier admits as the subject of a module call, or why its markers cannot be read. */
const listingsOf = (carrier: ScannedCarrier): readonly ThroughModuleListing[] => {
  if (carrier.accessActor === null) {
    return [];
  }
  const at = { entrypointKey: carrier.entrypoint.entrypointKey, file: carrier.file };
  const actor = decodeActor(carrier.accessActor);
  if (Result.isFailure(actor)) {
    return [{ ...at, via: `unreadable accessActor (${actor.failure.message})`, workload: '' }];
  }
  const subjects = (actor.success.subjectWorkloads ?? [])
    .filter((key) => GUARDED_WORKLOADS.has(key))
    .map((workload) => ({ ...at, via: 'accessActor.subjectWorkloads', workload }));
  if (carrier.accessWorkload === null || actor.success.subjectWorkloadCallers === undefined) {
    return subjects;
  }
  // A workload carrier that also lets named module callers bring a workload subject.
  const workload = decodeWorkload(carrier.accessWorkload);
  if (Result.isFailure(workload)) {
    return [...subjects, { ...at, via: `unreadable accessWorkload (${workload.failure.message})`, workload: '' }];
  }
  return [
    ...subjects,
    ...workload.success.workloads
      .filter((key) => GUARDED_WORKLOADS.has(key))
      .map((key) => ({ ...at, via: 'accessWorkload with accessActor.subjectWorkloadCallers', workload: key })),
  ];
};

/** Every scanned carrier of `sources`; a source the scan cannot read is reported as a listing. */
const throughModuleListings = (sources: readonly AccessCatalogSource[]) => {
  const moduleSources = new Map(sources.map(({ file, source }) => [file, source] as const));
  let carriers = 0;
  const listings = sources.flatMap(({ file, source }) => {
    const scanned = scanAccessCatalogSource(source, file, moduleSources);
    carriers += scanned.carriers.length;
    return [
      ...scanned.problems.map((problem) => ({
        entrypointKey: problem.entrypointKey ?? '',
        file: problem.file,
        via: `unreadable carrier (${problem.reason})`,
        workload: '',
      })),
      ...scanned.carriers.flatMap(listingsOf),
    ];
  });
  return { carriers, listings };
};

/** The workspace sources the catalogue scan reads, with the module-local files their constants come from. */
const workspaceSources = Effect.gen(function* readWorkspaceSources() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const walk = (directory: string): Effect.Effect<readonly string[], unknown> =>
    Effect.gen(function* walkDirectory() {
      const files: string[] = [];
      for (const entry of yield* fileSystem.readDirectory(directory)) {
        if (entry === 'node_modules' || entry === '.output' || entry.startsWith('dist') || entry.startsWith('.')) {
          continue;
        }
        const entryPath = path.join(directory, entry);
        const info = yield* fileSystem.stat(entryPath);
        files.push(...(info.type === 'Directory' ? yield* walk(entryPath) : [entryPath]));
      }
      return files;
    });
  const sources: AccessCatalogSource[] = [];
  for (const segment of STAGE_ACCESS_CATALOG_ROOTS) {
    for (const file of yield* walk(path.join(workspaceRoot, segment))) {
      const relative = path.relative(workspaceRoot, file).replaceAll('\\', '/');
      if (isAccessCatalogSourcePath(relative)) {
        sources.push({ file: relative, source: yield* fileSystem.readFileString(file, 'utf-8') });
      }
    }
  }
  return yield* withOwnerLocalImportSources(workspaceRoot, sources);
}).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

const plantedCarrier = (marker: string) => ({
  file: 'verticals/planted-relay/src/actions/relay.action.ts',
  source: `
export const relayAction = defineAction(
  {
    accessActor: ${marker},
    accessDeclaration: {
      key: 'planted.relay.write',
      kind: 'action',
      modes: ['run'],
      placement: { group: 'relay', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    actionKey: 'planted.relay.write',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: 'planted.relay.write',
      moduleKey: 'planted.relay',
      role: 'action',
    }),
  },
  handler,
);
`,
});

it.effect(
  'no carrier admits the Customer Context source workloads as the subject of a module call',
  () =>
    Effect.gen(function* noRelayedSourceWorkload() {
      const sources = yield* workspaceSources;
      const { carriers, listings } = throughModuleListings(sources);
      // The scan reached the workspace's carriers, including Customer Context's own source-workload Actions.
      expect(carriers).toBeGreaterThan(500);
      expect(sources.some(({ file }) => file.startsWith('verticals/commerce-customer-context/src/actions/'))).toBe(
        true,
      );
      expect(listings).toEqual([]);
    }),
  120_000,
);

it.effect(
  'a planted carrier that relays a source workload is detected',
  () =>
    Effect.gen(function* plantedRelayDetected() {
      const sources = yield* workspaceSources;
      const relayed = throughModuleListings([
        ...sources,
        plantedCarrier(
          "{ callers: ['crm'], reason: 'Relays a source import.', subject: 'identity', subjectWorkloads: ['commerce.customer-context.source-write'] }",
        ),
      ]);
      expect(relayed.listings).toEqual([
        {
          entrypointKey: 'planted.relay.write',
          file: 'verticals/planted-relay/src/actions/relay.action.ts',
          via: 'accessActor.subjectWorkloads',
          workload: 'commerce.customer-context.source-write',
        },
      ]);
      // A narrowed caller list is still a module-relayed source workload.
      const narrowed = throughModuleListings([
        plantedCarrier(
          "{ callers: ['crm', 'sales-pipeline'], reason: 'Relays a source read.', subject: 'workload', subjectWorkloadCallers: ['crm'], subjectWorkloads: ['commerce.customer-context.source-read'] }",
        ),
      ]);
      expect(narrowed.listings.map(({ via, workload }) => `${via}:${workload}`)).toEqual([
        'accessActor.subjectWorkloads:commerce.customer-context.source-read',
      ]);
      // An unrelated subject workload is not a finding.
      const unrelated = throughModuleListings([
        plantedCarrier(
          "{ callers: ['crm'], reason: 'Relays a CRM intake.', subject: 'identity', subjectWorkloads: ['demo.crm.party-intake'] }",
        ),
      ]);
      expect(unrelated).toEqual({ carriers: 1, listings: [] });
    }),
  120_000,
);
