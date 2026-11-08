import { Schema } from 'effect';

import { AccessDeclarationSchema, AccessFieldGroupSchema } from '../../authorization/access-declaration.ts';
import { ModuleKeySchema } from '../ids.ts';
import { ModuleEntrypointSchema } from '../../modules/module-entrypoint.ts';

/*
 * The shape of the declaration set an installation run compiles a release from (O69). A stage or local
 * bootstrap receives the declarations of the composition as data — the repository catalog scan hands them
 * over as `unknown` — and decodes them here before Core touches them, so a scanner that drifts from the
 * descriptor contract fails the bootstrap instead of publishing a smaller release.
 *
 * The entrypoint and the declaration schemas are the same ones `defineAction`, `defineRead` and the
 * catalog collector use, so a decoded module is a module Core would have accepted from source.
 */
export const AccessCatalogDescriptorSchema = Schema.Struct({
  accessDeclaration: AccessDeclarationSchema,
  accessFieldGroups: Schema.optionalKey(Schema.Array(AccessFieldGroupSchema)),
  entrypoint: ModuleEntrypointSchema,
});
export type AccessCatalogDescriptorInput = typeof AccessCatalogDescriptorSchema.Type;

/** One module of the running composition: its key and the descriptors it declares. */
export const AccessCatalogModuleSchema = Schema.Struct({
  descriptors: Schema.Array(AccessCatalogDescriptorSchema),
  moduleId: ModuleKeySchema,
});
export type AccessCatalogModuleInput = typeof AccessCatalogModuleSchema.Type;

/** The composition an installation run serves, as the process root hands it over. */
export const AccessCatalogModulesSchema = Schema.Array(AccessCatalogModuleSchema);
