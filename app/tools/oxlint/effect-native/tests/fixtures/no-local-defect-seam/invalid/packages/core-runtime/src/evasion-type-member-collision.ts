// expect-count: 1
// Only the call is a seam. `defects` / `squash` as *type* member names (TSPropertySignature,
// TSMethodSignature) are not references to the import and must not be reported.
import { defects } from 'effect/Cause';

export interface DefectReport {
  readonly defects: readonly unknown[];
  squash(): string;
}

declare const cause: never;

export const report = (): DefectReport => ({ defects: defects(cause), squash: () => '' });
