#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Config, Console, Effect, FileSystem, Layer, Option, Order, Path, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { Command, Flag } from 'effect/cli';

import {
  AccessCatalogDescriptorSchema,
  AccessCatalogModuleSchema,
} from '../packages/core-runtime/src/access/catalog/module-schema.ts';
import { AccessActorSchema, WorkloadKeySchema } from '../packages/core-runtime/src/authorization/access-declaration.ts';
import type { WorkloadKey } from '../packages/core-runtime/src/authorization/access-declaration.ts';
import { loadStageAccessModules } from './stage-access-catalog.mts';
import type { StageAccessCatalogError } from './stage-access-catalog.mts';

/**
 * `authorization:catalog:artifact` — the pinned catalog artifact (O69).
 *
 * Core never scans source code. A stage or local bootstrap compiles a tenant's release from the
 * declarations of the installed modules, so it needs that declaration set as data. This command
 * derives it with the repository catalog scan and writes one deterministic, committed JSON document
 * that deployments ship beside the workspace; `--check` proves the committed document is current.
 *
 * The document is canonical: modules in module-key order and each module's descriptors in
 * declaration-key order, so a scan-order change never rewrites the artifact.
 */

export const ACCESS_CATALOG_ARTIFACT_SCHEMA_VERSION = 2 as const;

/** The shipped document, relative to the workspace root (`app/`). */
export const AUTHORIZATION_CATALOG_ARTIFACT_PATH = 'topology/authorization-catalog.json';

/**
 * The modules that get a module credential, generated beside the artifact from the same declarations: every module a
 * carrier admits as its delegated caller (`accessActor.callers`). Nobody keeps that list by hand, so a module that
 * starts calling another one gets its key from the declaration that admits it.
 */
export const MODULE_CREDENTIAL_CALLERS_PATH = 'scripts/zerops/module-credential-callers.generated.mts';

/**
 * The module caller a descriptor pins (D5): core's own `accessActor` fields, so a hand-edited artifact with an
 * empty, repeated or malformed caller list is refused. Core's descriptor decoder would strip `actor`, so the
 * artifact decodes with this schema instead.
 */
const ArtifactActorSchema = Schema.Struct({
  callers: AccessActorSchema.fields.callers,
  subject: AccessActorSchema.fields.subject,
  subjectWorkloadCallers: AccessActorSchema.fields.subjectWorkloadCallers,
  subjectWorkloads: AccessActorSchema.fields.subjectWorkloads,
});

export const AccessCatalogArtifactDescriptorSchema = Schema.Struct({
  ...AccessCatalogDescriptorSchema.fields,
  actor: Schema.optionalKey(ArtifactActorSchema),
});
export type AccessCatalogArtifactDescriptor = typeof AccessCatalogArtifactDescriptorSchema.Type;

export const AccessCatalogArtifactModulesSchema = Schema.Array(
  Schema.Struct({
    ...AccessCatalogModuleSchema.fields,
    descriptors: Schema.Array(AccessCatalogArtifactDescriptorSchema),
  }),
);
export type AccessCatalogArtifactModule = (typeof AccessCatalogArtifactModulesSchema.Type)[number];

export const AccessCatalogArtifactSchema = Schema.Struct({
  declaredWorkloadKeys: Schema.Array(WorkloadKeySchema).check(Schema.isUnique()),
  modules: AccessCatalogArtifactModulesSchema,
  schemaVersion: Schema.Literal(ACCESS_CATALOG_ARTIFACT_SCHEMA_VERSION),
});
export type AccessCatalogArtifact = typeof AccessCatalogArtifactSchema.Type;

export class AccessCatalogArtifactError extends Schema.TaggedError<AccessCatalogArtifactError>()(
  'AccessCatalogArtifactError',
  { code: Schema.Literals(['artifact_unreadable', 'artifact_stale']), reason: Schema.String },
) {}

const refusal = (code: AccessCatalogArtifactError['code'], reason: string): AccessCatalogArtifactError =>
  new AccessCatalogArtifactError({ code, reason });

const declarationKeyOf = (descriptor: AccessCatalogArtifactDescriptor): string => descriptor.accessDeclaration.key;

type Ordering = -1 | 0 | 1;

/** `toSorted` is absent from the script type environment, so ordering goes through Effect. */
const sortedBy = <Value,>(
  values: Iterable<Value>,
  compare: (left: Value, right: Value) => Ordering,
): readonly Value[] => EffectArray.sort(values, Order.make(compare));

const compareText = (left: string, right: string): Ordering => {
  const order = left.localeCompare(right);
  if (order < 0) {
    return -1;
  }
  return order > 0 ? 1 : 0;
};

type ArtifactActor = NonNullable<AccessCatalogArtifactDescriptor['actor']>;

/** One module caller in canonical order: callers and workload subjects by key, absent when not declared. */
const sortedActorOf = (actor: ArtifactActor): ArtifactActor => {
  const callers = EffectArray.sort(actor.callers, Order.make(compareText));
  if (actor.subjectWorkloads === undefined) {
    return { callers, subject: actor.subject };
  }
  const withWorkloads = {
    callers,
    subject: actor.subject,
    subjectWorkloads: EffectArray.sort(actor.subjectWorkloads, Order.make(compareText)),
  };
  return actor.subjectWorkloadCallers === undefined
    ? withWorkloads
    : {
        ...withWorkloads,
        subjectWorkloadCallers: EffectArray.sort(actor.subjectWorkloadCallers, Order.make(compareText)),
      };
};

/** Canonical order: modules by module key, descriptors by declaration key, field groups and callers by key. */
export const sortAccessCatalogModules = (
  modules: readonly AccessCatalogArtifactModule[],
): readonly AccessCatalogArtifactModule[] =>
  sortedBy(modules, (left, right) => compareText(left.moduleId, right.moduleId)).map(
    (module): AccessCatalogArtifactModule => ({
      descriptors: sortedBy(module.descriptors, (left, right) =>
        compareText(declarationKeyOf(left), declarationKeyOf(right)),
      ).map((descriptor): AccessCatalogArtifactDescriptor => {
        const sorted: AccessCatalogArtifactDescriptor = {
          ...descriptor,
          accessFieldGroups: sortedBy(descriptor.accessFieldGroups ?? [], (left, right) =>
            compareText(left.key, right.key),
          ),
        };
        if (descriptor.actor === undefined) {
          return sorted;
        }
        return {
          ...sorted,
          actor: sortedActorOf(descriptor.actor),
        };
      }),
      moduleId: module.moduleId,
    }),
  );

/** The deterministic document a workspace's declarations pin, as bytes with a trailing newline. */
export const renderAccessCatalogArtifact = (
  modules: readonly AccessCatalogArtifactModule[],
  declaredWorkloadKeys: readonly WorkloadKey[],
): Effect.Effect<string, AccessCatalogArtifactError> =>
  Effect.gen(function* renderAccessCatalogArtifactEffect() {
    const artifact: AccessCatalogArtifact = {
      declaredWorkloadKeys: sortedBy(new Set(declaredWorkloadKeys), compareText),
      modules: sortAccessCatalogModules(modules),
      schemaVersion: ACCESS_CATALOG_ARTIFACT_SCHEMA_VERSION,
    };
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(AccessCatalogArtifactSchema, { space: 2 }))(
      artifact,
    ).pipe(
      Effect.mapError((issue) =>
        refusal('artifact_unreadable', `unable to encode the catalog artifact: ${issue.message}`),
      ),
    );
    return `${encoded}\n`;
  });

/** Every module some carrier admits as its delegated caller, each once, in key order. */
export const declaredDelegatedCallers = (modules: readonly AccessCatalogArtifactModule[]): readonly string[] =>
  sortedBy(
    new Set(
      modules.flatMap(({ descriptors }) =>
        descriptors.flatMap(({ actor }) => (actor === undefined ? [] : actor.callers)),
      ),
    ),
    compareText,
  );

/** The generated module that names the module credential callers, as bytes with a trailing newline. */
export const renderModuleCredentialCallers = (modules: readonly AccessCatalogArtifactModule[]): string =>
  [
    `// @generated by scripts/authorization-catalog-artifact.mts from the delegated callers ${AUTHORIZATION_CATALOG_ARTIFACT_PATH} declares`,
    '',
    '/** Every module a carrier admits as its delegated caller (`accessActor.callers`); each gets a module credential. */',
    'export const DECLARED_DELEGATED_CALLERS: readonly string[] = Object.freeze([',
    ...declaredDelegatedCallers(modules).map((appId) => `  '${appId}',`),
    ']);',
    '',
  ].join('\n');

interface WorkspaceArtifacts {
  readonly artifact: string;
  readonly callers: string;
}

const buildArtifactFromWorkspace = (
  root: string,
): Effect.Effect<
  WorkspaceArtifacts,
  AccessCatalogArtifactError | StageAccessCatalogError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* buildArtifactFromWorkspaceEffect() {
    const catalog = yield* loadStageAccessModules(root);
    const modules = yield* Schema.decodeUnknownEffect(AccessCatalogArtifactModulesSchema)(catalog.modules).pipe(
      Effect.mapError((issue) =>
        refusal('artifact_unreadable', `the scanned catalog does not match the descriptor contract: ${issue.message}`),
      ),
    );
    return {
      artifact: yield* renderAccessCatalogArtifact(modules, catalog.declaredWorkloadKeys),
      callers: renderModuleCredentialCallers(modules),
    };
  });

/** Reads the committed artifact as the declaration set a bootstrap compiles a release from. */
export const readAccessCatalogArtifactDocument = (
  root: string,
): Effect.Effect<AccessCatalogArtifact, AccessCatalogArtifactError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* readAccessCatalogArtifactEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const artifactPath = path.join(root, AUTHORIZATION_CATALOG_ARTIFACT_PATH);
    const source = yield* fileSystem
      .readFileString(artifactPath)
      .pipe(
        Effect.catchTag('PlatformError', () =>
          Effect.fail(
            refusal(
              'artifact_unreadable',
              `${AUTHORIZATION_CATALOG_ARTIFACT_PATH} is missing; run "pnpm authorization:catalog:artifact"`,
            ),
          ),
        ),
      );
    const artifact = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AccessCatalogArtifactSchema))(source).pipe(
      Effect.mapError(() =>
        refusal('artifact_unreadable', `${AUTHORIZATION_CATALOG_ARTIFACT_PATH} does not match the descriptor contract`),
      ),
    );
    return artifact;
  });

/** The human catalog projection still requires the complete, current document schema. */
export const readAccessCatalogArtifact = (root: string) =>
  readAccessCatalogArtifactDocument(root).pipe(Effect.map((artifact) => artifact.modules));

export const writeAccessCatalogArtifact = (
  root: string,
): Effect.Effect<
  string,
  AccessCatalogArtifactError | StageAccessCatalogError | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* writeAccessCatalogArtifactEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { artifact, callers } = yield* buildArtifactFromWorkspace(root);
    const artifactPath = path.join(root, AUTHORIZATION_CATALOG_ARTIFACT_PATH);
    yield* fileSystem.makeDirectory(path.dirname(artifactPath), { recursive: true });
    yield* fileSystem.writeFileString(artifactPath, artifact);
    const callersPath = path.join(root, MODULE_CREDENTIAL_CALLERS_PATH);
    yield* fileSystem.makeDirectory(path.dirname(callersPath), { recursive: true });
    yield* fileSystem.writeFileString(callersPath, callers);
    return artifactPath;
  });

export const checkAccessCatalogArtifact = (
  root: string,
): Effect.Effect<
  void,
  AccessCatalogArtifactError | StageAccessCatalogError | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* checkAccessCatalogArtifactEffect() {
    const current = yield* buildArtifactFromWorkspace(root);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const committedCallers = yield* fileSystem
      .readFileString(path.join(root, MODULE_CREDENTIAL_CALLERS_PATH))
      .pipe(Effect.catchTag('PlatformError', () => Effect.succeed('')));
    if (committedCallers !== current.callers) {
      return yield* Effect.fail(
        refusal(
          'artifact_stale',
          `${MODULE_CREDENTIAL_CALLERS_PATH} is stale; run "pnpm authorization:catalog:artifact" and commit the result`,
        ),
      );
    }
    const artifactPath = path.join(root, AUTHORIZATION_CATALOG_ARTIFACT_PATH);
    const committed = yield* fileSystem
      .readFileString(artifactPath)
      .pipe(
        Effect.catchTag('PlatformError', () =>
          Effect.fail(
            refusal(
              'artifact_unreadable',
              `${AUTHORIZATION_CATALOG_ARTIFACT_PATH} is missing; run "pnpm authorization:catalog:artifact"`,
            ),
          ),
        ),
      );
    if (committed !== current.artifact) {
      return yield* Effect.fail(
        refusal(
          'artifact_stale',
          `${AUTHORIZATION_CATALOG_ARTIFACT_PATH} is stale; run "pnpm authorization:catalog:artifact" and commit the result`,
        ),
      );
    }
    return yield* Effect.void;
  });

const resolveRoot = (configured: string | undefined) =>
  Effect.gen(function* resolveRootEffect() {
    const path = yield* Path.Path;
    return (
      configured ??
      (yield* Config.String('ULTRAMODERN_WORKSPACE_ROOT').pipe(
        Config.withDefault(path.resolve(path.join(import.meta.dirname, '..'))),
      ))
    );
  });

const command = Command.make(
  'authorization-catalog-artifact',
  {
    check: Flag.Boolean('check').pipe(Flag.withDefault(false)),
    root: Flag.String('root').pipe(Flag.optional),
  },
  ({ check, root }) =>
    Effect.gen(function* accessCatalogArtifactCommand() {
      const resolvedRoot = yield* resolveRoot(Option.getOrUndefined(root));
      if (check) {
        yield* checkAccessCatalogArtifact(resolvedRoot);
        yield* Console.log(
          `Authorization v2 access catalog artifact is current (${AUTHORIZATION_CATALOG_ARTIFACT_PATH}).`,
        );
        return yield* Effect.void;
      }
      const artifactPath = yield* writeAccessCatalogArtifact(resolvedRoot);
      yield* Console.log(`Wrote the Authorization v2 access catalog artifact to ${artifactPath}.`);
      return yield* Effect.void;
    }),
);

const [, invokedPath] = process.argv;
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const mainLayer = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(NodeServices.layer),
  );
  NodeRuntime.runMain(Effect.scoped(Layer.build(mainLayer)).pipe(Effect.asVoid));
}
