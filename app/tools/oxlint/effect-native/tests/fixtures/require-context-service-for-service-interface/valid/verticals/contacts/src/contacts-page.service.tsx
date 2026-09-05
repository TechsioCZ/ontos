import { Effect } from 'effect';

/** `.tsx` frontend modules are the framework adapter surface (includeTsx defaults to false). */
export interface ContactsPageQueryService {
  readonly load: (id: string) => Effect.Effect<string, Error>;
}

export const ContactsPage = (): string => 'contacts';
