import { Effect } from 'effect';

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
import type {
  OntosVerticalMetadata,
  ResourceScaffoldConfig,
} from '../shared.mts';

const renderResource = (
  vertical: OntosVerticalMetadata,
  resource: string
): string => {
  const type = toPascalCase(resource);
  const descriptor = `${toCamelCase(resource)}ResourceDescriptor`;
  const resourceType = `${vertical.moduleId}.${resource}`;
  return `${RESOURCE_GENERATOR_HEADER}
// @ontos-resource-owner ${vertical.moduleId}
// @ontos-resource-slug ${resource}
import type { OntosResourceType } from '@app/core-runtime';
import { Schema } from 'effect';

const ResourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const TenantIdSchema = Schema.String.check(Schema.isUUID());

export const ${type}RefSchema = Schema.Struct({
  moduleId: Schema.Literal('${vertical.moduleId}'),
  resourceId: ResourceIdSchema,
  resourceType: Schema.Literal('${resourceType}'),
  tenantId: TenantIdSchema,
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

const isResourceDescriptor = (candidate: string): boolean =>
  /^[a-z][A-Za-z0-9]*ResourceDescriptor,$/u.test(candidate);

const planResourceScaffold = Effect.fn('ResourceScaffold.plan')(
  function* planResourceScaffold(
    workspaceRoot: string,
    config: ResourceScaffoldConfig
  ) {
    const resource = yield* tryScaffold('resource name is invalid', () =>
      requireCanonicalSlug(config.resource, 'resource')
    );
    const vertical = yield* discoverOntosModuleEffect(
      workspaceRoot,
      config.vertical
    );
    const resourcePath = yield* tryScaffold(
      'failed to resolve resource path',
      () =>
        resolveContainedPath(
          vertical.directory,
          'shared',
          'resources',
          `${resource}.ts`
        )
    );
    const resourceMutation = yield* createMutationEffect(
      resourcePath,
      renderResource(vertical, resource)
    );

    const descriptor = `${toCamelCase(resource)}ResourceDescriptor`;
    const ownerImport = `import { ${descriptor} } from './shared/resources/${resource}.ts';`;
    const nextManifest = yield* tryScaffold(
      'failed to patch resource manifest',
      () =>
        insertSortedSlot(
          insertSortedSlot(
            vertical.manifestContent,
            MODULE_MANIFEST_IMPORT_SLOT_START,
            MODULE_MANIFEST_IMPORT_SLOT_END,
            [ownerImport],
            isModuleManifestImport
          ),
          MODULE_MANIFEST_RESOURCE_SLOT_START,
          MODULE_MANIFEST_RESOURCE_SLOT_END,
          [`${descriptor},`],
          isResourceDescriptor
        )
    );
    const manifestMutation = updateMutation(
      vertical.manifestPath,
      vertical.manifestContent,
      nextManifest
    );
    if (manifestMutation === undefined) {
      return yield* scaffoldFailure(
        'Resource manifest patch unexpectedly made no change'
      );
    }

    const exportsValue = yield* tryScaffold(
      'failed to read resource package exports',
      () =>
        asJsonObject(
          vertical.packageJson['exports'],
          `vertical ${vertical.slug} package exports`
        )
    );
    const contractExport = `./resources/${resource}`;
    if (exportsValue[contractExport] !== undefined) {
      return yield* scaffoldFailure(
        `resource contract export ${contractExport} already exists`
      );
    }
    const packageMutation = yield* tryScaffold(
      'failed to patch resource package export',
      () => {
        const patchedExports = Object.fromEntries(
          Object.entries({
            ...exportsValue,
            [contractExport]: `./shared/resources/${resource}.ts`,
          }).toSorted(([left], [right]) => left.localeCompare(right))
        );
        return updateMutation(
          vertical.packagePath,
          vertical.packageContent,
          patchJsonObjectProperty(
            vertical.packageContent,
            [],
            'exports',
            patchedExports
          )
        );
      }
    );
    if (packageMutation === undefined) {
      return yield* scaffoldFailure(
        'Resource package export patch unexpectedly made no change'
      );
    }

    const mutations = [resourceMutation, manifestMutation, packageMutation];
    yield* tryScaffold('resource mutation paths are invalid', () =>
      ensureUniqueMutationPaths(mutations)
    );
    return { mutations, result: { resourcePath } };
  }
);

export default createCodesmithGenerator(planResourceScaffold);
