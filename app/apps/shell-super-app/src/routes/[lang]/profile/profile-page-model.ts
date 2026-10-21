import { Effect } from 'effect';

import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { requireSignedIn } from '../../sign-in-return.ts';
import { loadHomePageModel } from '../home-page-model.ts';
import type { HomePageModel } from '../home-page-model.ts';

export interface ProfilePageModel {
  readonly shell: HomePageModel;
}

export const loader = ({ request }: { readonly request: Request }): Promise<ProfilePageModel> =>
  browserRuntime
    .runPromise(
      loadHomePageModel(request).pipe(
        Effect.timeout('30 seconds'),
        Effect.map((shell) => ({ shell })),
      ),
      { signal: request.signal },
    )
    .then((model) => requireSignedIn(request, model));
