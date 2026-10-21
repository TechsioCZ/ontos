import { Effect } from 'effect';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { loadHomePageModel } from '../../home-page-model.ts';
import type { HomePageModel } from '../../home-page-model.ts';
import { requireSignedIn } from '../../../sign-in-return.ts';

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
        Effect.map((shell): ConnectionsAdminPageModel => ({ connectionsAdminPage: true, shell })),
      ),
      { signal: request.signal },
    )
    .then((model) => requireSignedIn(request, model));
