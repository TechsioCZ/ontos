import type { ReactElement } from 'react';
import { Match, Option, Result } from 'effect';

import type { LookupResult } from '../../../apps/demo-app/shared/schema-first.ts';

/** Value-position tagged literals construct an existing contract; they are not a declaration. */
const rateLimited = () => ({ _tag: 'ShellRateLimitedProblem' as const, status: 429 });

export const describe = (result: LookupResult): string =>
  Match.value(result).pipe(
    Match.tag('found', (found) => found.value),
    Match.tag('not_found', () => 'missing'),
    Match.exhaustive,
  );

export const first = (values: readonly string[]): Option.Option<string> =>
  values.length === 0 ? Option.none() : Option.some(values[0] as string);

export const parsed = (raw: string): Result.Result<number, string> =>
  Number.isNaN(Number(raw)) ? Result.fail('not a number') : Result.succeed(Number(raw));

export function Banner(): ReactElement {
  return <output data-status={rateLimited().status}>{rateLimited()._tag}</output>;
}
