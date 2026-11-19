import { ActiveApplicationCompositionUnavailableError, narrowActiveApplicationComposition } from '@app/core-runtime';
import type { ActiveApplicationCompositionServiceContract } from '@app/core-runtime';
import { Context, Effect } from 'effect';

import { InstalledModuleCatalogUnavailableError } from './installed-module-catalog.ts';
import type { ShellInstalledCatalog } from './installed-module-catalog.ts';

/** Framework requests provide their admitted release once before governed context acquisition. */
export const CapturedShellCompositionCatalog = Context.Reference<ShellInstalledCatalog | null>(
  '@app/shell-super-app/api/modules/captured-shell-catalog/CapturedShellCompositionCatalog',
  { defaultValue: () => null },
);

export const capturedShellCatalog = CapturedShellCompositionCatalog.pipe(
  Effect.flatMap((catalog) => Effect.fromNullishOr(catalog)),
  Effect.mapError(
    (cause) =>
      new InstalledModuleCatalogUnavailableError({
        cause,
        reason: 'No approved release was captured for this Shell request',
      }),
  ),
);

/** A Shell-hosted Read admits only the release its request captured. */
export const narrowToCapturedRelease = (authority: ActiveApplicationCompositionServiceContract) =>
  narrowActiveApplicationComposition(authority, (checked) =>
    capturedShellCatalog.pipe(
      Effect.mapError(
        (cause) =>
          new ActiveApplicationCompositionUnavailableError({
            cause,
            reason: 'The Shell request release is unavailable',
          }),
      ),
      Effect.filterOrFail(
        (catalog) => catalog.composition.revision === checked.snapshot.composition.revision,
        () =>
          new ActiveApplicationCompositionUnavailableError({
            reason: 'The Shell request release changed',
          }),
      ),
      Effect.asVoid,
    ),
  );
