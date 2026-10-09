import { Effect } from 'effect';

/** The Response body, read from a clone so the caller's own handle stays consumable. */
export const jsonBody = (response: Response) => Effect.promise(async () => await response.clone().json());
