import { Effect } from 'effect';

/** Outside `apps/**`, `verticals/**`, `packages/**`. */
export interface OutsideRepositoryService {
  readonly load: (id: string) => Effect.Effect<string>;
}
