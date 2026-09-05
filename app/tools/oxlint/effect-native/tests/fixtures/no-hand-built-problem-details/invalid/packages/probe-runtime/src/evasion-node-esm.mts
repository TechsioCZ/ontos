// expect-count: 2
// `.mts` is linted like `.ts`; top-level await and `satisfies` must not hide the payload.
interface ProblemDetails {
  readonly _tag: string;
  readonly detail: string;
  readonly status: number;
  readonly title: string;
}

export const unavailable = {
  _tag: 'RuntimeUnavailableProblem',
  detail: 'The runtime is temporarily unavailable.',
  status: 503,
  title: 'Runtime unavailable',
} satisfies ProblemDetails;

export const internal = await Promise.resolve({
  _tag: 'RuntimeInternalProblem',
  detail: 'The runtime operation failed.',
  status: 500,
  title: 'Runtime failed',
});
