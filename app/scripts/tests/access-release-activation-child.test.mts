import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'effect-rstest';

import { accessReleaseActivationArguments } from '../access-release-activation-child.mts';

/*
 * The access catalog release activation as the migrator starts it (`run-zerops-migrator.mjs`): this Node, the
 * argument vector the migrator itself builds (no argument at all), the application directory. Settings that stop
 * it right after argument parsing make every case finish in seconds and prove the arguments were accepted.
 */
const appDirectory = fileURLToPath(new URL('../../', import.meta.url));
const FAILED = '[access-release] ACCESS CATALOG RELEASE ACTIVATION FAILED:';
const USAGE_ERRORS = /Missing required|Unrecognized flag|ShowHelp|USAGE/u;

const startActivation = (extraArguments: readonly string[]) => {
  const result = spawnSync(process.execPath, [...accessReleaseActivationArguments(appDirectory), ...extraArguments], {
    cwd: appDirectory,
    encoding: 'utf-8',
    // Only these settings, present but unusable: they win over any local .env file, so the stop is the same everywhere.
    env: {
      DATABASE_URL: 'not-a-database-url',
      SPICEDB_ENDPOINT: '',
      SPICEDB_PRESHARED_KEY: '',
    },
    timeout: 120_000,
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
};

describe('access catalog release activation started as the migrator starts it', () => {
  it('accepts no argument at all and stops only at the missing engine settings', () => {
    const { output, status } = startActivation([]);
    expect(status).toBe(1);
    expect(output).not.toMatch(USAGE_ERRORS);
    expect(output).toContain(`${FAILED} The SpiceDB settings are missing`);
  });

  it('accepts --dry-run alone, which needs no engine and stops at the database setting', () => {
    const { output, status } = startActivation(['--dry-run']);
    expect(status).toBe(1);
    expect(output).not.toMatch(USAGE_ERRORS);
    expect(output).toContain(`${FAILED} DATABASE_URL is not a runtime database address`);
  });

  it('reports an argument it does not know as a usage failure, loudly', () => {
    const { output, status } = startActivation(['--bogus']);
    expect(status).toBe(1);
    expect(output).toMatch(USAGE_ERRORS);
    expect(output).toContain(FAILED);
  });
});
