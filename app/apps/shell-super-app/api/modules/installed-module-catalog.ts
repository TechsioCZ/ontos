import {
  ActiveApplicationCompositionService,
  loadCheckedActiveApplicationComposition,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime';
import type {
  ActiveApplicationCompositionLoad,
  ActiveApplicationCompositionServiceContract,
  ApplicationComposition,
  InstalledModuleCatalog,
} from '@app/core-runtime';
import { Context, Effect, Layer, Schema, pipe } from 'effect';

const unavailableFields = {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.tag('installed_module_catalog_unavailable'),
  reason: Schema.String,
};
const InstalledModuleCatalogUnavailableErrorSchema = Schema.TaggedStruct(
  'InstalledModuleCatalogUnavailableError',
  unavailableFields,
);
export type InstalledModuleCatalogUnavailableError = typeof InstalledModuleCatalogUnavailableErrorSchema.Type;
const InstalledModuleCatalogUnavailableErrorConstructor = Schema.TaggedError<InstalledModuleCatalogUnavailableError>()(
  'InstalledModuleCatalogUnavailableError',
  unavailableFields,
);

export { InstalledModuleCatalogUnavailableErrorConstructor as InstalledModuleCatalogUnavailableError };

/** The complete approved catalog and exact release captured by one operation. */
export interface ShellInstalledCatalog extends InstalledModuleCatalog {
  readonly composition: ApplicationComposition;
}

export interface ShellInstalledModuleCatalogService {
  readonly load: Effect.Effect<ShellInstalledCatalog, InstalledModuleCatalogUnavailableError>;
}

export class ShellInstalledModuleCatalog extends Context.Service<
  ShellInstalledModuleCatalog,
  ShellInstalledModuleCatalogService
>()('@app/shell-super-app/api/modules/installed-module-catalog/ShellInstalledModuleCatalog') {}

/** Fresh authority is required for each operation. Remote health never changes approved membership. */
const installedCatalogOf = (
  authority: ActiveApplicationCompositionServiceContract,
): ShellInstalledModuleCatalogService['load'] =>
  loadCheckedActiveApplicationComposition(authority).pipe(
    Effect.mapError(
      (cause) =>
        new InstalledModuleCatalogUnavailableErrorConstructor({
          cause,
          reason: 'The approved Application Composition is unavailable, expired, or contradictory',
        }),
    ),
    Effect.map(({ catalog, snapshot }) => Object.freeze({ ...catalog, composition: snapshot.composition })),
  );

/** A catalog over an injected load, which is checked in full on every read. */
export const makeInstalledModuleCatalogLoader = (
  load: ActiveApplicationCompositionLoad,
): ShellInstalledModuleCatalogService['load'] =>
  pipe(load, makeActiveApplicationCompositionService, installedCatalogOf);

export const makeInstalledModuleCatalogLayer = (
  load: ActiveApplicationCompositionLoad,
): Layer.Layer<ShellInstalledModuleCatalog> =>
  Layer.succeed(ShellInstalledModuleCatalog, {
    load: makeInstalledModuleCatalogLoader(load),
  });

export const installedModuleCatalog = ShellInstalledModuleCatalog.pipe(Effect.flatMap(({ load }) => load));

/** Acquiring the service is independent of authority availability, allowing cold bootstrap. */
export const ShellInstalledModuleCatalogLive = Layer.effect(
  ShellInstalledModuleCatalog,
  ActiveApplicationCompositionService.pipe(Effect.map((authority) => ({ load: installedCatalogOf(authority) }))),
);
