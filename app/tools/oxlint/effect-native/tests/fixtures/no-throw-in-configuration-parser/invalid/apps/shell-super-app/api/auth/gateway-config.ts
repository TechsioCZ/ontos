// expect-count: 3
// A3: ambient `process.env` at module scope and inside an exported reader, plus a helper it calls.
// The `Effect.try` body throws too, but that throw is owned by no-throw-in-effect-callback.
import { Effect } from 'effect';

const port = Number(process.env.PORT ?? '3000');
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new TypeError('PORT must be a TCP port number');
}

export const readIssuer = (): string => {
  const issuer = process.env['ONTOS_GATEWAY_ISSUER']?.trim();
  if (issuer === undefined || issuer.length === 0) {
    throw new Error('ONTOS_GATEWAY_ISSUER is required');
  }
  assertHttps(issuer);
  return issuer;
};

function assertHttps(value: string): void {
  if (!value.startsWith('https:')) {
    throw new Error('ONTOS_GATEWAY_ISSUER must use HTTPS');
  }
}

export const readSecret = Effect.try({
  catch: () => new Error('BETTER_AUTH_SECRET is missing'),
  try: () => {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (secret === undefined) {
      throw new Error('BETTER_AUTH_SECRET is required');
    }
    return secret;
  },
});

export const httpPort = port;
