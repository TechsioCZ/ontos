// Type-only imports and type-only re-exports load nothing at runtime.
import type { DotenvConfigOutput } from 'dotenv';
// With verbatimModuleSyntax inline `type` still emits a side-effect import; use the erased form.
import type { DotenvPopulateInput } from 'dotenv';

export type { DotenvConfigOutput as EnvironmentLoadResult } from 'dotenv';

export const describe = (result: DotenvConfigOutput, input: DotenvPopulateInput): string =>
  `${String(result.error)}:${String(Object.keys(input).length)}`;
