// expect-count: 2
export const makeChecks = () => ({
  run: (payload: Record<string, unknown>) => () => {
    const inner = () => Array.isArray(payload['verticals']) && 'overlay' in payload;
    return inner();
  },
});
