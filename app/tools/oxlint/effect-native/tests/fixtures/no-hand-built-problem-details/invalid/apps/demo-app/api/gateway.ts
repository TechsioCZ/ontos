// expect-count: 6
import { Effect } from 'effect';

declare const computeStatus: () => number;
declare const error: { readonly message: string; readonly _tag: string };
declare const dbError: { readonly message: string };

export const rateLimited = () => ({
  _tag: 'GatewayRateLimitedProblem',
  detail: 'The API key rate limit was exceeded.',
  retryAfterSeconds: 60,
  status: 429,
  title: 'Gateway rate limited',
  type: 'https://ontos.dev/problems/gateway-rate-limited',
});

// `as const` around both the tag and the status must not hide the literal.
export const unavailable = () => ({
  _tag: 'GatewayUnavailableProblem' as const,
  detail: 'Gateway authentication is temporarily unavailable. Please retry.',
  retryable: true as const,
  status: 503 as const,
  title: 'Gateway unavailable',
  type: 'https://ontos.dev/problems/gateway-unavailable',
});

// No literal status, but still a hand-declared Problem Details payload.
export const internal = () => ({
  _tag: 'GatewayInternalProblem',
  detail: 'Gateway authentication could not complete.',
  title: 'Gateway authentication failed',
  type: 'https://ontos.dev/problems/gateway-internal',
});

// Raw driver message leaked into `detail` beside a duplicated status (A5).
export const fromDefect = () =>
  Effect.succeed({
    _tag: 'GatewayInternalProblem',
    detail: error.message,
    status: 500,
    title: 'Gateway authentication failed',
    type: 'https://ontos.dev/problems/gateway-internal',
  });

// Title + type make this an RFC 9457 payload even though the status is computed.
export const interpolated = {
  detail: `Query failed: ${dbError.message}`,
  status: computeStatus(),
  title: 'Persistence unavailable',
  type: 'https://ontos.dev/problems/persistence-unavailable',
};
