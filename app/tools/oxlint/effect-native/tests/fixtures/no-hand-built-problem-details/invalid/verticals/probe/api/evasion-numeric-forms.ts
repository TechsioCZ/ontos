// expect-count: 4
// The same status, spelled so a naive `=== 503` check would miss it.
export const hex = {
  status: 0x1f7,
  title: 'Probe unavailable',
  type: 'https://ontos.dev/problems/probe-unavailable',
};

export const separated = {
  status: 5_03,
  title: 'Probe unavailable',
  type: 'https://ontos.dev/problems/probe-unavailable',
};

export const decimalZero = {
  status: 503.0,
  title: 'Probe unavailable',
  type: 'https://ontos.dev/problems/probe-unavailable',
};

export const parenthesised = {
  _tag: 'ProbeRateLimitedProblem',
  detail: 'The probe rate limit was exceeded.',
  status: (429) as const,
  title: 'Probe rate limited',
};
