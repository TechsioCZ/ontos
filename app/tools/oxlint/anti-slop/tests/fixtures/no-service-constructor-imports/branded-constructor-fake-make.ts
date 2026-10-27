import { Effect } from 'effect';

const EntityIdSchema = { make: (value: string) => Effect.runSync(Effect.sync(() => value)) };
export const makeEntityId = (value: string) => EntityIdSchema.make(value);
