// expect-count: 2
// A3: a hand-rolled `requireEnv` reader and the parser that consumes it.
import * as Effect from 'effect/Effect';

const requireEnv = (name: string): string => {
  const value = globalThis.process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

export const loadPermissionsConfig = () => {
  const endpoint = requireEnv('SPICEDB_ENDPOINT');
  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    throw new Error('SPICEDB_ENDPOINT must be an http(s) URL');
  }
  return Effect.succeed({ endpoint });
};
