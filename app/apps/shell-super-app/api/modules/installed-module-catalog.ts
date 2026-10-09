import {
  ActiveApplicationCompositionService,
  buildApplicationCompositionCatalog,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type {
  ActiveApplicationCompositionServiceContract,
  ApplicationComposition,
  InstalledModuleCatalog,
} from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';

const unavailableFields = {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.tag('installed_module_catalog_unavailable'),
  reason: Schema.String,
};
const invalidFields = {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.tag('installed_module_catalog_invalid'),
  reason: Schema.String,
};
const InstalledModuleCatalogUnavailableErrorSchema = Schema.TaggedStruct(
  'InstalledModuleCatalogUnavailableError',
  unavailableFields,
);
const InstalledModuleCatalogInvalidErrorSchema = Schema.TaggedStruct(
  'InstalledModuleCatalogInvalidError',
  invalidFields,
);
export type InstalledModuleCatalogUnavailableError = typeof InstalledModuleCatalogUnavailableErrorSchema.Type;
export type InstalledModuleCatalogInvalidError = typeof InstalledModuleCatalogInvalidErrorSchema.Type;
const InstalledModuleCatalogUnavailableErrorConstructor = Schema.TaggedError<InstalledModuleCatalogUnavailableError>()(
  'InstalledModuleCatalogUnavailableError',
  unavailableFields,
);
const InstalledModuleCatalogInvalidErrorConstructor = Schema.TaggedError<InstalledModuleCatalogInvalidError>()(
  'InstalledModuleCatalogInvalidError',
  invalidFields,
);

export {
  InstalledModuleCatalogUnavailableErrorConstructor as InstalledModuleCatalogUnavailableError,
  InstalledModuleCatalogInvalidErrorConstructor as InstalledModuleCatalogInvalidError,
};

export type InstalledModuleCatalogError = InstalledModuleCatalogInvalidError | InstalledModuleCatalogUnavailableError;

/** The complete approved catalog and exact release captured by one operation. */
export interface ShellInstalledCatalog extends InstalledModuleCatalog {
  readonly composition: ApplicationComposition;
}

export interface ShellInstalledModuleCatalogService {
  readonly load: Effect.Effect<ShellInstalledCatalog, InstalledModuleCatalogError>;
}

export class ShellInstalledModuleCatalog extends Context.Service<
  ShellInstalledModuleCatalog,
  ShellInstalledModuleCatalogService
>()('@app/shell-super-app/api/modules/installed-module-catalog/ShellInstalledModuleCatalog') {}

/** Fresh authority is required for each operation. Remote health never changes approved membership. */
export const makeInstalledModuleCatalogLoader = (
  load: ActiveApplicationCompositionServiceContract['load'],
): ShellInstalledModuleCatalogService['load'] =>
  load.pipe(
    Effect.flatMap(validateActiveApplicationCompositionSnapshot),
    Effect.mapError(
      (cause) =>
        new InstalledModuleCatalogUnavailableErrorConstructor({
          cause,
          reason: 'The approved Application Composition is unavailable or expired',
        }),
    ),
    Effect.flatMap(({ composition }) =>
      buildApplicationCompositionCatalog(composition).pipe(
        Effect.map((catalog) => Object.freeze({ ...catalog, composition })),
        Effect.mapError(
          (cause) =>
            new InstalledModuleCatalogInvalidErrorConstructor({
              cause,
              reason: 'The approved Application Composition catalog is contradictory or malformed',
            }),
        ),
      ),
    ),
  );

export const makeInstalledModuleCatalogLayer = (
  load: ActiveApplicationCompositionServiceContract['load'],
): Layer.Layer<ShellInstalledModuleCatalog> =>
  Layer.succeed(ShellInstalledModuleCatalog, {
    load: makeInstalledModuleCatalogLoader(load),
  });

export const installedModuleCatalog = ShellInstalledModuleCatalog.pipe(Effect.flatMap(({ load }) => load));

/** Acquiring the service is independent of authority availability, allowing cold bootstrap. */
export const ShellInstalledModuleCatalogLive = Layer.effect(
  ShellInstalledModuleCatalog,
  ActiveApplicationCompositionService.pipe(
    Effect.map(({ load }) => ({ load: makeInstalledModuleCatalogLoader(load) })),
  ),
);
