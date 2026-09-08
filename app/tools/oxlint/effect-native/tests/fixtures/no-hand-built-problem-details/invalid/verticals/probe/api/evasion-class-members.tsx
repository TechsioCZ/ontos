// expect-count: 4
// TSX + class fields, accessors, async generators and `export default` must not hide the literal.
import type { ReactElement } from 'react';

class ProblemFactory {
  static readonly unavailable = {
    _tag: 'ProbeUnavailableProblem',
    detail: 'The probe operation is temporarily unavailable.',
    status: 503,
    title: 'Probe unavailable',
  };

  get notFound(): unknown {
    return {
      _tag: 'ProbeNotFoundProblem',
      detail: 'The probe record was not found.',
      status: 404,
      title: 'Probe not found',
    };
  }

  async *stream(): AsyncGenerator<unknown> {
    yield {
      _tag: 'ProbeRateLimitedProblem',
      detail: 'The probe rate limit was exceeded.',
      status: 429,
      title: 'Probe rate limited',
    };
  }
}

export { ProblemFactory };

export const Panel = (): ReactElement => <section>{'probe'}</section>;

export default {
  _tag: 'ProbeInternalProblem',
  detail: 'The probe operation failed.',
  status: 500,
  title: 'Probe failed',
};
