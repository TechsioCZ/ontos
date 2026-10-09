import { Effect } from 'effect';

import { installedModuleCatalog } from '../modules/installed-module-catalog.ts';

/** Issuer admission uses the complete approved release, never placement or remote health. */
export const installedVerticalIds = installedModuleCatalog.pipe(
  Effect.map(({ contracts }) => new Set(contracts.map(({ deployment }) => deployment.appId))),
);
