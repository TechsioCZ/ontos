/**
 * The one release-catalog builder (O1, O67-Q7). It turns the declarations of the modules a tenant has
 * installed into the immutable snapshot every role revision is validated against, and it derives the
 * release identity from that content so the same declarations are the same release.
 */
export { AccessCatalogReleaseError, AccessCatalogReleaseErrorCodeSchema, releaseRefusal } from './errors.ts';
export type { AccessCatalogReleaseErrorCode } from './errors.ts';
export {
  buildAccessCatalogRelease,
  buildDeploymentCatalogRelease,
  catalogReleaseDigest,
  catalogReleaseId,
  catalogReleaseLines,
} from './release.ts';
export type { BuildAccessCatalogReleaseInput, BuildDeploymentCatalogReleaseInput } from './release.ts';
export { CatalogReleaseOrderingSchema, orderCatalogRelease } from './release-ordering.ts';
export type { CatalogReleaseOrdering, CatalogReleaseOrderingInput } from './release-ordering.ts';
export {
  AccessCatalogDescriptorSchema,
  AccessCatalogModuleSchema,
  AccessCatalogModulesSchema,
} from './module-schema.ts';
export type { AccessCatalogDescriptorInput, AccessCatalogModuleInput } from './module-schema.ts';
export { stableUuid } from './stable-id.ts';
