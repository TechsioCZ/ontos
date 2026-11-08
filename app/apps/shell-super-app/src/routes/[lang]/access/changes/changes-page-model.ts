import { Effect } from 'effect';

import type { ShellAuthenticationClientOptions } from '../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { liveChangesClient } from '../../../access-admin/changes/changes-bff-adapter.ts';
import { changesFailureNotice } from '../../../access-admin/changes/changes-client.ts';
import type { ChangesClient, ChangesListView } from '../../../access-admin/changes/changes-client.ts';
import type { ChangesNotice } from '../../../access-admin/changes/changes-model.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../shell-authentication-client-options.ts';
import { loadHomePageModel } from '../../home-page-model.ts';
import type { HomePageModel } from '../../home-page-model.ts';

export interface ChangesPageModel {
  readonly list: ChangesListView;
  readonly notice: ChangesNotice | null;
  readonly shell: HomePageModel;
}

export const loadChangesPageModel = (
  shell: HomePageModel,
  client: ChangesClient,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ChangesPageModel> => {
  const empty: ChangesListView = { items: [], nextCursor: null };
  if (shell.state !== 'authenticated') {
    return Effect.succeed({
      list: empty,
      notice: shell.state === 'anonymous' ? 'unauthenticated' : 'unavailable',
      shell,
    });
  }
  // Tenant administration also runs for selection_required/access_blocked: the BFF gate decides.
  return client.list(undefined, options).pipe(
    Effect.timeout('30 seconds'),
    Effect.match({
      onFailure: (error): ChangesPageModel => ({
        list: empty,
        notice: changesFailureNotice(error),
        shell,
      }),
      onSuccess: (list): ChangesPageModel => ({ list, notice: null, shell }),
    }),
  );
};

export const loader = ({ request }: { readonly request: Request }): Promise<ChangesPageModel> =>
  browserRuntime.runPromise(
    loadHomePageModel(request).pipe(
      Effect.flatMap((shell) =>
        shellAuthenticationClientOptionsFromRequest(request).pipe(
          Effect.flatMap((options) => loadChangesPageModel(shell, liveChangesClient, options)),
          Effect.catchTag('ConfigError', () =>
            Effect.succeed<ChangesPageModel>({ list: { items: [], nextCursor: null }, notice: 'unavailable', shell }),
          ),
        ),
      ),
    ),
    { signal: request.signal },
  );
