#!/usr/bin/env node
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { OntosDeploymentAppIdSchema } from '../packages/core-runtime/src/modules/manifest.ts';
import { OpsShellLive, runCommand } from './ops/ops-shell.mts';

const SHELL_APP_ID = 'shell-super-app';

/** A reviewed publication instruction. Runtime membership belongs only to the resulting composition. */
export const ApplicationReleaseIntentSchema = Schema.Struct({
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
export const ApplicationReleaseSelectionSchema = Schema.Array(DeploymentUnitSchema);

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

export const selectApplicationReleaseUnits = Effect.fn('ApplicationReleaseIntent.select')(function* selectReleaseUnits(
  intent: ApplicationReleaseIntent,
  available: readonly ApplicationReleaseDeploymentUnit[],
  impacted: readonly { readonly id: string }[],
) {
  yield* Schema.decodeUnknownEffect(ApplicationReleaseIntentSchema, { onExcessProperty: 'error' })(intent);
  const byApp = new Map(available.map((unit) => [unit.id, unit]));
  if (byApp.size !== available.length) {
    return yield* new ApplicationReleaseIntentError({
      message: 'execution placement must give each deployment exactly one owner',
    });
  }
  const selected = new Set<string>();
  const units: ApplicationReleaseDeploymentUnit[] = [];
  for (const module of intent.modules) {
    const unit = byApp.get(module.appId);
    if (selected.has(module.appId) || unit === undefined || unit.id === SHELL_APP_ID) {
      return yield* new ApplicationReleaseIntentError({
        message: 'the reviewed complete module selection contains a duplicate, unknown, or Shell deployment',
      });
    }
    selected.add(unit.id);
    units.push(unit);
  }
  if (impacted.some((unit) => unit.id === SHELL_APP_ID)) {
    const shell = byApp.get(SHELL_APP_ID);
    if (shell === undefined) {
      return yield* new ApplicationReleaseIntentError({
        message: 'the changed Shell has no declared execution placement',
      });
    }
    units.push(shell);
  }
  return units;
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
    impactedUnitsFile: Flag.String('impacted-units-file'),
    intentFile: Flag.String('intent-file'),
    selectionFile: Flag.String('selection-file'),
  },
  ({ impactedUnitsFile, intentFile, selectionFile }) =>
    Effect.gen(function* selectCommandEffect() {
      const fileSystem = yield* FileSystem.FileSystem;
      const intent = yield* readReviewedApplicationReleaseIntent(intentFile);
      const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TopologySchema))(
        yield* fileSystem.readFileString('topology/reference-topology.json'),
      );
      const placement = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PlacementSchema))(
        yield* fileSystem.readFileString('topology/cloudflare-placement.json'),
      );
      const available = [topology.shell, ...topology.verticals]
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
      const units = yield* selectApplicationReleaseUnits(intent, available, impacted);
      yield* fileSystem.writeFileString(
        selectionFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(ApplicationReleaseSelectionSchema))(units),
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
