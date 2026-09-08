import { betterAuth as auth } from 'better-auth';
import { Effect as Fx } from 'effect';

// A5/D: better-auth owns databaseHooks.session.create.before's Promise signature.
const createAuth = auth;
export const provider = createAuth({
  databaseHooks: { session: { create: {
    [`before`]: (async (session: { userId: string }) => ({ data: session })) satisfies unknown,
  } } },
});

// Resolve immutable aliases and computed Effect members, not their spelling.
const convert = Fx[`tryPromise`];
const execute = async () => 'driver';
export const operation = convert({ try: () => execute(), catch: String });

// Platform default-parameter evidence identifies the structural fetch mirror.
type PlatformFetch = (input: string) => Promise<Response>;
export const runFetch = (fetcher: PlatformFetch = globalThis.fetch) =>
  Fx.tryPromise(() => fetcher('https://example.invalid'));
