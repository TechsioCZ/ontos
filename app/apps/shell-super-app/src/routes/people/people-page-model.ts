import { Effect } from 'effect';

import { loadHomePageModel } from '../[lang]/home-page-model.ts';
import type { HomePageModel } from '../[lang]/home-page-model.ts';

export const PEOPLE_ADMIN_PATH = '/sprava/lide-a-role';
export interface PeoplePageModel {
  readonly peoplePage: true;
  readonly shell: HomePageModel;
}
export const loadPeoplePageModel = Effect.fn('loadPeoplePageModel')(function* loadPeoplePageModel(request: Request) {
  const shell = yield* loadHomePageModel(request).pipe(
    Effect.timeout('30 seconds'),
    Effect.orElseSucceed(() => ({ state: 'unavailable' }) as const),
  );
  return { peoplePage: true, shell } satisfies PeoplePageModel;
});
