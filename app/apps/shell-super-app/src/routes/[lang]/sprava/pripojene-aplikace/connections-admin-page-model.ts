import { Effect } from 'effect';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { loadHomePageModel } from '../../home-page-model.ts';
import type { HomePageModel } from '../../home-page-model.ts';
import { NAVIGATION_PREPARE_BUDGET } from '../../modules/[moduleId]/module-page-model.ts';
import { requireSignedIn } from '../../../sign-in-return.ts';
import { preloadConnectionsAdminPage } from './connections-admin-data.ts';

export const CONNECTIONS_ADMIN_PATH = '/sprava/pripojene-aplikace';

export interface ConnectionsAdminPageModel {
  readonly connectionsAdminPage: true;
  readonly shell: HomePageModel;
}

export const isConnectionsAdminPageModel = (model: unknown): model is ConnectionsAdminPageModel =>
  typeof model === 'object' && model !== null && 'connectionsAdminPage' in model;

export const loadConnectionsAdminPageModel = (request: Request): Promise<ConnectionsAdminPageModel> =>
  browserRuntime
    .runPromise(
      loadHomePageModel(request).pipe(
        Effect.timeout('30 seconds'),
        Effect.orElseSucceed(() => ({ state: 'unavailable' }) as const),
        // The router keeps the previous page on screen until the list is ready (a no-op on the server).
        Effect.tap((shell) =>
          shell.state === 'authenticated'
            ? preloadConnectionsAdminPage.pipe(Effect.timeout(NAVIGATION_PREPARE_BUDGET), Effect.ignore)
            : Effect.void,
        ),
        Effect.map((shell): ConnectionsAdminPageModel => ({ connectionsAdminPage: true, shell })),
      ),
      { signal: request.signal },
    )
    .then((model) => requireSignedIn(request, model));
