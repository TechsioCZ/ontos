// expect-count: 4
// The duplicated status is moved out of literal position; the payload is still hand-declared.
const STATUS = 503;

export const unavailable = {
  _tag: 'GatewayUnavailableProblem',
  detail: 'The gateway is temporarily unavailable.',
  status: STATUS,
  title: 'Gateway unavailable',
};

export const notFound = {
  _tag: 'GatewayNotFoundProblem',
  detail: 'The gateway route was not found.',
  ['status']: 404,
  title: 'Gateway not found',
};

export const conflict = {
  _tag: 'GatewayConflictProblem',
  detail: 'The gateway operation conflicts with the current state.',
  status: Number('409'),
  title: 'Gateway conflict',
};

export const rateLimited = {
  _tag: 'GatewayRateLimitedProblem',
  detail: 'The gateway rate limit was exceeded.',
  status: '429',
  title: 'Gateway rate limited',
};
