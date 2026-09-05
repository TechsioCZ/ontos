// A look-alike `gen` on a non-Effect binding must never be treated as an Effect generator, and TSX
// parses like any other source file.
import { Effect } from 'effect';

declare const api: {
  readonly fetchUsers: () => Generator<unknown, readonly string[]>;
  readonly fetchRoles: () => Generator<unknown, readonly string[]>;
};
const saga = { gen: <A,>(body: () => Generator<unknown, A>) => body };

export const workflow = saga.gen(function* () {
  const users = yield* api.fetchUsers();
  const roles = yield* api.fetchRoles();
  return { roles, users };
});

export const ok = Effect.succeed('page');

export const Panel = () => <div>{'panel'}</div>;
