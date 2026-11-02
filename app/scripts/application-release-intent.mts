#!/usr/bin/env node
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { OntosDeploymentAppIdSchema } from '../packages/core-runtime/src/modules/manifest.ts';
import { ActiveApplicationCompositionSnapshotSchema } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import { ApplicationMigrationRequirementsSchema } from './application-migration-plan.mts';
import { OpsShellLive, runCommand } from './ops/ops-shell.mts';

const SHELL_APP_ID = 'shell-super-app';

/** A reviewed publication instruction. Runtime membership belongs only to the resulting composition. */
export const ApplicationReleaseIntentSchema = Schema.Struct({
  migrationRequirements: Schema.optionalKey(ApplicationMigrationRequirementsSchema),
  modules: Schema.Array(Schema.Struct({ appId: OntosDeploymentAppIdSchema })).check(Schema.isMaxLength(256)),
});
export type ApplicationReleaseIntent = typeof ApplicationReleaseIntentSchema.Type;

const DeploymentUnitSchema = Schema.Struct({
  id: OntosDeploymentAppIdSchema,
  packageName: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  workerName: Schema.NonEmptyString,
});
export type ApplicationReleaseDeploymentUnit = typeof DeploymentUnitSchema.Type;
export const ApplicationReleaseSelectionSchema = Schema.Struct({
  complete: Schema.Array(DeploymentUnitSchema),
  fresh: Schema.Array(DeploymentUnitSchema),
  migrationRequirements: Schema.optionalKey(ApplicationMigrationRequirementsSchema),
  removed: Schema.Array(Schema.Struct({ appId: OntosDeploymentAppIdSchema })),
  retained: Schema.Array(DeploymentUnitSchema),
  shell: Schema.Struct({
    mode: Schema.Literals(['fresh', 'retained']),
    unit: DeploymentUnitSchema,
  }),
});
export type ApplicationReleaseSelection = typeof ApplicationReleaseSelectionSchema.Type;

export class ApplicationReleaseIntentError extends Schema.TaggedError<ApplicationReleaseIntentError>()(
  'ApplicationReleaseIntentError',
  { message: Schema.String },
) {}

/** Deployment selection must come from reviewed checkout bytes, including when driven outside CI. */
export const readReviewedApplicationReleaseIntent = Effect.fn('ApplicationReleaseIntent.readReviewed')(
  function* readReviewedIntent(intentFile: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fileSystem.realPath(path.resolve(import.meta.dirname, '..'));
    const location = path.resolve(workspaceRoot, intentFile);
    if (!location.startsWith(`${workspaceRoot}${path.sep}`) || (yield* fileSystem.realPath(location)) !== location) {
      return yield* new ApplicationReleaseIntentError({
        message: 'the release intent must be a reviewed checkout file',
      });
    }
    yield* runCommand({
      args: ['ls-files', '--error-unmatch', '--', path.relative(workspaceRoot, location)],
      command: 'git',
      cwd: workspaceRoot,
      env: {},
      extendEnv: false,
    }).pipe(
      Effect.mapError(
        () => new ApplicationReleaseIntentError({ message: 'the complete release intent must be source-controlled' }),
      ),
    );
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApplicationReleaseIntentSchema), {
      onExcessProperty: 'error',
    })(yield* fileSystem.readFileString(location));
  },
);

/** Structural partition input only. Approval, exact receipts and artifact existence are later gates. */
const baselineModuleIds = Effect.fn('ApplicationReleaseIntent.baselineMembership')(function* baselineMembership(
  baseline?: ActiveApplicationCompositionSnapshot,
) {
  if (baseline === undefined) {
    return [];
  }
  yield* Schema.decodeUnknownEffect(Schema.toType(ActiveApplicationCompositionSnapshotSchema), {
    onExcessProperty: 'error',
  })(baseline);
  const ids = baseline.composition.modules.map(({ deployment }) => deployment.appId);
  if (
    new Set(ids).size !== ids.length ||
    ids.includes(SHELL_APP_ID) ||
    baseline.composition.shell.deployment.appId !== SHELL_APP_ID
  ) {
    return yield* new ApplicationReleaseIntentError({
      message: 'baseline module membership or Shell identity is ambiguous',
    });
  }
  return ids;
});

export const selectApplicationReleaseUnits = Effect.fn('ApplicationReleaseIntent.select')(function* selectReleaseUnits(
  intent: ApplicationReleaseIntent,
  available: readonly ApplicationReleaseDeploymentUnit[],
  impacted: readonly { readonly id: string }[],
  baseline?: ActiveApplicationCompositionSnapshot,
) {
  yield* Schema.decodeUnknownEffect(ApplicationReleaseIntentSchema, { onExcessProperty: 'error' })(intent);
  yield* Schema.decodeUnknownEffect(Schema.Array(DeploymentUnitSchema), { onExcessProperty: 'error' })(available);
  yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: OntosDeploymentAppIdSchema })), {
    onExcessProperty: 'error',
  })(impacted);
  const byApp = new Map(available.map((unit) => [unit.id, unit]));
  if (byApp.size !== available.length) {
    return yield* new ApplicationReleaseIntentError({
      message: 'execution placement must give each deployment exactly one owner',
    });
  }
  const impactedIds = new Set(impacted.map(({ id }) => id));
  if (impactedIds.size !== impacted.length || impacted.some(({ id }) => !byApp.has(id))) {
    return yield* new ApplicationReleaseIntentError({
      message: 'build impact contains a duplicate or unknown execution placement',
    });
  }
  const priorIds = yield* baselineModuleIds(baseline);
  const prior = new Set(priorIds);
  const shell = byApp.get(SHELL_APP_ID);
  if (shell === undefined) {
    return yield* new ApplicationReleaseIntentError({
      message: 'the Shell must have one declared execution placement',
    });
  }
  const selected = new Set<string>();
  const complete: ApplicationReleaseDeploymentUnit[] = [];
  const fresh: ApplicationReleaseDeploymentUnit[] = [];
  const retained: ApplicationReleaseDeploymentUnit[] = [];
  for (const module of intent.modules) {
    const unit = byApp.get(module.appId);
    if (selected.has(module.appId) || unit === undefined || unit.id === SHELL_APP_ID) {
      return yield* new ApplicationReleaseIntentError({
        message: 'the reviewed complete module selection contains a duplicate, unknown, or Shell deployment',
      });
    }
    selected.add(unit.id);
    complete.push(unit);
    if (baseline === undefined || !prior.has(unit.id) || impactedIds.has(unit.id)) {
      fresh.push(unit);
    } else {
      retained.push(unit);
    }
  }
  const selection: ApplicationReleaseSelection = {
    complete,
    fresh,
    removed: priorIds.filter((appId) => !selected.has(appId)).map((appId) => ({ appId })),
    retained,
    shell: { mode: baseline === undefined || impactedIds.has(SHELL_APP_ID) ? 'fresh' : 'retained', unit: shell },
  };
  if (intent.migrationRequirements !== undefined) {
    return { ...selection, migrationRequirements: intent.migrationRequirements };
  }
  return selection;
});

const TopologyUnitSchema = Schema.Struct({
  cloudflare: Schema.Struct({ workerName: Schema.NonEmptyString }),
  id: OntosDeploymentAppIdSchema,
  package: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
});
const TopologySchema = Schema.Struct({ shell: TopologyUnitSchema, verticals: Schema.Array(TopologyUnitSchema) });
const PlacementSchema = Schema.Struct({ units: Schema.Array(OntosDeploymentAppIdSchema) });

export const applicationReleaseSelectCommand = Command.make(
  'select',
  {
    baselineFile: Flag.String('baseline-file').pipe(Flag.optional),
    impactedUnitsFile: Flag.String('impacted-units-file'),
    intentFile: Flag.String('intent-file'),
    selectionFile: Flag.String('selection-file'),
  },
  ({ baselineFile, impactedUnitsFile, intentFile, selectionFile }) =>
    Effect.gen(function* selectCommandEffect() {
      const fileSystem = yield* FileSystem.FileSystem;
      const intent = yield* readReviewedApplicationReleaseIntent(intentFile);
      const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TopologySchema))(
        yield* fileSystem.readFileString('topology/reference-topology.json'),
      );
      const placement = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PlacementSchema))(
        yield* fileSystem.readFileString('topology/cloudflare-placement.json'),
      );
      const topologyUnits = [topology.shell, ...topology.verticals];
      const topologyIds = new Set(topologyUnits.map(({ id }) => id));
      if (
        topology.shell.id !== SHELL_APP_ID ||
        topologyIds.size !== topologyUnits.length ||
        new Set(placement.units).size !== placement.units.length ||
        placement.units.some((id) => !topologyIds.has(id))
      ) {
        return yield* new ApplicationReleaseIntentError({
          message: 'topology and execution placement must contain unique known deployments',
        });
      }
      const available = topologyUnits
        .filter((unit) => placement.units.includes(unit.id))
        .map((unit) => ({
          id: unit.id,
          packageName: unit.package,
          path: unit.path,
          workerName: unit.cloudflare.workerName,
        }));
      const impacted = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Array(
            Schema.Struct({
              id: OntosDeploymentAppIdSchema,
            }),
          ),
        ),
      )(yield* fileSystem.readFileString(impactedUnitsFile));
      const baseline = Option.isSome(baselineFile)
        ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema), {
            onExcessProperty: 'error',
          })(yield* fileSystem.readFileString(baselineFile.value))
        : undefined;
      const selection = yield* selectApplicationReleaseUnits(intent, available, impacted, baseline);
      return yield* fileSystem.writeFileString(
        selectionFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(ApplicationReleaseSelectionSchema))(selection),
      );
    }),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run(applicationReleaseSelectCommand, { version: '1.0.0' })).pipe(
        Layer.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    ).pipe(Effect.scoped),
  );
}
