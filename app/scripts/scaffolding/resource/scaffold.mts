import { Effect, FileSystem, Schema } from 'effect';

import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_MANIFEST_RESOURCE_SLOT_END,
  MODULE_MANIFEST_RESOURCE_SLOT_START,
  RESOURCE_GENERATOR_HEADER,
  asJsonObject,
  createMutationEffect,
  discoverOntosModuleEffect,
  ensureUniqueMutationPaths,
  insertSortedSlot,
  isModuleManifestImport,
  patchJsonObjectProperty,
  requireCanonicalSlug,
  resolveContainedPath,
  scaffoldFailure,
  toCamelCase,
  toPascalCase,
  toTitle,
  tryScaffold,
  updateMutation,
} from '../shared.mts';
import type { OntosVerticalMetadata, ResourceScaffoldConfig } from '../shared.mts';

const renderResource = (vertical: Pick<OntosVerticalMetadata, 'moduleId'>, resource: string, core = false): string => {
  const type = toPascalCase(resource);
  const descriptor = `${toCamelCase(resource)}ResourceDescriptor`;
  const resourceType = `${vertical.moduleId}.${resource}`;
  // Demo-only exception (Core people): a Core person is addressed by its company and principal UUIDs.
  const corePerson = core && resource === 'person';
  const coreIdValidation = corePerson
    ? "Schema.makeFilter((value) => value.split('.').length === 2 && value.split('.').every(Schema.is(Schema.String.check(Schema.isUUID()))) ? undefined : 'Expected company and principal UUIDs')"
    : 'Schema.isUUID()';
  const coreIdBrand = corePerson ? ".pipe(Schema.brand('PersonResourceId'))" : ".pipe(Schema.brand('LegalEntityId'))";
  return `${RESOURCE_GENERATOR_HEADER}
// @ontos-resource-owner ${vertical.moduleId}
// @ontos-resource-slug ${resource}
import type { OntosResourceType } from '${core ? '../modules/manifest.ts' : '@app/core-runtime'}';
import { Schema } from 'effect';

const ResourceIdSchema = Schema.String.check(${core ? coreIdValidation : 'Schema.isMinLength(1), Schema.isMaxLength(300)'})${core ? coreIdBrand : ''};
const TenantIdSchema = Schema.String.check(Schema.isUUID())${core ? ".pipe(Schema.brand('TenantId'))" : ''};

export const ${type}RefSchema = Schema.Struct({
  moduleId: Schema.Literal('${vertical.moduleId}'),
  resourceId: ${core ? 'Schema.toEncoded(ResourceIdSchema)' : 'ResourceIdSchema'},
  resourceType: Schema.Literal('${resourceType}'),
  tenantId: ${core ? 'Schema.toEncoded(TenantIdSchema)' : 'TenantIdSchema'},
});
export type ${type}Ref = typeof ${type}RefSchema.Type;

export const ${descriptor} = {
  capabilities: {
    graphVisible: false,
    linkable: false,
    mediaAttachable: false,
    searchable: false,
    timelineVisible: false,
  },
  description: '${toTitle(resource)} resource.',
  key: '${resourceType}',
  label: '${toTitle(resource)}',
  owningModuleId: '${vertical.moduleId}',
} as const satisfies OntosResourceType;
`;
};

const isResourceDescriptor = (candidate: string): boolean => /^[a-z][A-Za-z0-9]*ResourceDescriptor,$/u.test(candidate);
const CorePackageSchema = Schema.Struct({
  // Demo-only exception (Core people): Core's package publishes conditional exports.
  exports: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
  name: Schema.Literal('@app/core-runtime'),
});

const planCoreResourceScaffold = Effect.fn('ResourceScaffold.planCore')(function* planCoreResourceScaffold(
  workspaceRoot: string,
  resource: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const packagePath = yield* tryScaffold('failed to resolve Core package', () =>
    resolveContainedPath(workspaceRoot, 'packages', 'core-runtime', 'package.json'),
  );
  const packageContent = yield* fileSystem
    .readFileString(packagePath)
    .pipe(Effect.mapError((cause) => scaffoldFailure('failed to read Core package', cause)));
  const packageObject = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CorePackageSchema))(
    packageContent,
  ).pipe(Effect.mapError((cause) => scaffoldFailure('invalid Core package', cause)));
  const exportsValue = packageObject.exports;
  const contractExport = `./resources/${resource}`;
  if (exportsValue[contractExport] !== undefined) {
    return yield* scaffoldFailure(`resource contract export ${contractExport} already exists`);
  }
  const resourcePath = yield* tryScaffold('failed to resolve Core resource path', () =>
    resolveContainedPath(workspaceRoot, 'packages', 'core-runtime', 'src', 'resources', `${resource}.ts`),
  );
  const resourceMutation = yield* createMutationEffect(
    resourcePath,
    renderResource({ moduleId: 'core.identity' }, resource, true),
  );
  const patchedExports = Object.fromEntries(
    Object.entries({ ...exportsValue, [contractExport]: `./src/resources/${resource}.ts` }).toSorted(
      ([left], [right]) => left.localeCompare(right),
    ),
  );
  const packageMutation = updateMutation(
    packagePath,
    packageContent,
    patchJsonObjectProperty(packageContent, [], 'exports', patchedExports),
  );
  if (packageMutation === undefined) {
    return yield* scaffoldFailure('Core resource package export patch unexpectedly made no change');
  }
  const mutations = [resourceMutation, packageMutation];
  yield* tryScaffold('Core resource mutation paths are invalid', () => ensureUniqueMutationPaths(mutations));
  return { mutations, result: { resourcePath } };
});

const planResourceScaffold = Effect.fn('ResourceScaffold.plan')(function* planResourceScaffold(
  workspaceRoot: string,
  config: ResourceScaffoldConfig,
) {
  const resource = yield* tryScaffold('resource name is invalid', () =>
    requireCanonicalSlug(config.resource, 'resource'),
  );
  if (config.vertical === 'core') {
    // Demo-only exception (Core people): the Core person resource is generated too.
    if (resource !== 'legal-entity' && resource !== 'person') {
      return yield* scaffoldFailure('Core Resource generation supports only legal-entity and person');
    }
    return yield* planCoreResourceScaffold(workspaceRoot, resource);
  }
  const vertical = yield* discoverOntosModuleEffect(workspaceRoot, config.vertical);
  const resourcePath = yield* tryScaffold('failed to resolve resource path', () =>
    resolveContainedPath(vertical.directory, 'shared', 'resources', `${resource}.ts`),
  );
  const resourceMutation = yield* createMutationEffect(resourcePath, renderResource(vertical, resource));

  const descriptor = `${toCamelCase(resource)}ResourceDescriptor`;
  const ownerImport = `import { ${descriptor} } from './shared/resources/${resource}.ts';`;
  const nextManifest = yield* tryScaffold('failed to patch resource manifest', () =>
    insertSortedSlot(
      insertSortedSlot(
        vertical.manifestContent,
        MODULE_MANIFEST_IMPORT_SLOT_START,
        MODULE_MANIFEST_IMPORT_SLOT_END,
        [ownerImport],
        isModuleManifestImport,
      ),
      MODULE_MANIFEST_RESOURCE_SLOT_START,
      MODULE_MANIFEST_RESOURCE_SLOT_END,
      [`${descriptor},`],
      isResourceDescriptor,
    ),
  );
  const manifestMutation = updateMutation(vertical.manifestPath, vertical.manifestContent, nextManifest);
  if (manifestMutation === undefined) {
    return yield* scaffoldFailure('Resource manifest patch unexpectedly made no change');
  }

  const exportsValue = yield* tryScaffold('failed to read resource package exports', () =>
    asJsonObject(vertical.packageJson['exports'], `vertical ${vertical.slug} package exports`),
  );
  const contractExport = `./resources/${resource}`;
  if (exportsValue[contractExport] !== undefined) {
    return yield* scaffoldFailure(`resource contract export ${contractExport} already exists`);
  }
  const packageMutation = yield* tryScaffold('failed to patch resource package export', () => {
    const patchedExports = Object.fromEntries(
      Object.entries({
        ...exportsValue,
        [contractExport]: `./shared/resources/${resource}.ts`,
      }).toSorted(([left], [right]) => left.localeCompare(right)),
    );
    return updateMutation(
      vertical.packagePath,
      vertical.packageContent,
      patchJsonObjectProperty(vertical.packageContent, [], 'exports', patchedExports),
    );
  });
  if (packageMutation === undefined) {
    return yield* scaffoldFailure('Resource package export patch unexpectedly made no change');
  }

  const mutations = [resourceMutation, manifestMutation, packageMutation];
  yield* tryScaffold('resource mutation paths are invalid', () => ensureUniqueMutationPaths(mutations));
  return { mutations, result: { resourcePath } };
});

export default createCodesmithGenerator(planResourceScaffold);
