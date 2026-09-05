import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_MANIFEST_RESOURCE_SLOT_END,
  MODULE_MANIFEST_RESOURCE_SLOT_START,
  RESOURCE_GENERATOR_HEADER,
  asJsonObject,
  createMutation,
  discoverOntosModule,
  ensureUniqueMutationPaths,
  insertSortedSlot,
  isModuleManifestImport,
  patchJsonObjectProperty,
  requireCanonicalSlug,
  resolveContainedPath,
  toCamelCase,
  toPascalCase,
  toTitle,
  updateMutation,
} from '../shared.mts';
import type {
  OntosVerticalMetadata,
  ResourceScaffoldConfig,
  ResourceScaffoldResult,
  ScaffoldPlan,
} from '../shared.mts';

const renderResource = (vertical: OntosVerticalMetadata, resource: string): string => {
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

const withResourceSlot = (manifest: string): string => {
  const hasStart = manifest.includes(MODULE_MANIFEST_RESOURCE_SLOT_START);
  const hasEnd = manifest.includes(MODULE_MANIFEST_RESOURCE_SLOT_END);
  if (hasStart || hasEnd) {
    return manifest;
  }
  const legacyField = '    resourceTypes: [],';
  const first = manifest.indexOf(legacyField);
  if (first === -1 || manifest.includes(legacyField, first + legacyField.length)) {
    throw new Error(
      'generated owner manifest does not contain one resource slot or legacy empty resourceTypes field',
    );
  }
  return manifest.replace(
    legacyField,
    `    resourceTypes: [
      ${MODULE_MANIFEST_RESOURCE_SLOT_START}
      ${MODULE_MANIFEST_RESOURCE_SLOT_END}
    ],`,
  );
};

const isResourceDescriptor = (candidate: string): boolean =>
  /^[a-z][A-Za-z0-9]*ResourceDescriptor,$/u.test(candidate);

export const planResourceScaffold = async (
  workspaceRoot: string,
  config: ResourceScaffoldConfig,
): Promise<ScaffoldPlan<ResourceScaffoldResult>> => {
  const resource = requireCanonicalSlug(config.resource, 'resource');
  const vertical = await discoverOntosModule(workspaceRoot, config.vertical);
  const resourcePath = resolveContainedPath(
    vertical.directory,
    'shared',
    'resources',
    `${resource}.ts`,
  );
  const resourceMutation = await createMutation(resourcePath, renderResource(vertical, resource));

  const descriptor = `${toCamelCase(resource)}ResourceDescriptor`;
  const ownerImport = `import { ${descriptor} } from './shared/resources/${resource}.ts';`;
  const manifestWithSlot = withResourceSlot(vertical.manifestContent);
  const nextManifest = insertSortedSlot(
    insertSortedSlot(
      manifestWithSlot,
      MODULE_MANIFEST_IMPORT_SLOT_START,
      MODULE_MANIFEST_IMPORT_SLOT_END,
      [ownerImport],
      isModuleManifestImport,
    ),
    MODULE_MANIFEST_RESOURCE_SLOT_START,
    MODULE_MANIFEST_RESOURCE_SLOT_END,
    [`${descriptor},`],
    isResourceDescriptor,
  );
  const manifestMutation = updateMutation(
    vertical.manifestPath,
    vertical.manifestContent,
    nextManifest,
  );
  if (manifestMutation === undefined) {
    throw new Error('Resource manifest patch unexpectedly made no change');
  }

  const exportsValue = asJsonObject(
    vertical.packageJson['exports'],
    `vertical ${vertical.slug} package exports`,
  );
  const contractExport = `./resources/${resource}`;
  if (exportsValue[contractExport] !== undefined) {
    throw new Error(`resource contract export ${contractExport} already exists`);
  }
  const patchedExports = Object.fromEntries(
    Object.entries({
      ...exportsValue,
      [contractExport]: `./shared/resources/${resource}.ts`,
    }).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const packageMutation = updateMutation(
    vertical.packagePath,
    vertical.packageContent,
    patchJsonObjectProperty(vertical.packageContent, [], 'exports', patchedExports),
  );
  if (packageMutation === undefined) {
    throw new Error('Resource package export patch unexpectedly made no change');
  }

  const mutations = [resourceMutation, manifestMutation, packageMutation];
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { resourcePath } };
};

export default createCodesmithGenerator(planResourceScaffold);
