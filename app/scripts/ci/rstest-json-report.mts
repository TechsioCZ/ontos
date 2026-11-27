// A package's Rstest config spreads this: a run that names ONTOS_RSTEST_JSON_REPORT also writes its results there
// as JSON, beside the reporters Rstest uses by default. The CI evidence records are generated from those files.
import type { RstestConfig } from '@rstest/core';

const environment = process.getBuiltinModule('node:process').env;
const outputPath = environment['ONTOS_RSTEST_JSON_REPORT'];
// Rstest adds its annotations by default in GitHub Actions, which is the only place that sets this name.
const annotations = environment['GITHUB_ACTIONS'] === undefined ? [] : ['github-actions' as const];

export const jsonReportConfig: Pick<RstestConfig, 'reporters'> =
  outputPath === undefined ? {} : { reporters: ['default', ...annotations, ['json', { outputPath }]] };
