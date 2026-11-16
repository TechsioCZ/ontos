import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  IntegrationWorkerSettingsSchema,
  integrationWorkerEnvironment,
} from '../ci/integration-worker-environment.mts';

const decode = Schema.decodeUnknownResult(IntegrationWorkerSettingsSchema);

const environment = {
  DATABASE_ADMIN_URL: 'postgresql://admin:admin@localhost:5433/ontos_ci',
  DATABASE_URL: 'postgresql://runtime:runtime@localhost:5433/ontos_ci',
  ONTOS_CI_ISOLATED_WORKERS: '4',
  PARTY_REGISTRY_DATABASE_URL: 'postgresql://party:party@localhost:5433/ontos_ci',
  PARTY_REGISTRY_WORKER_DATABASE_URL: 'postgresql://worker:worker@localhost:5433/ontos_ci',
  SHELL_GATEWAY_ISSUER_DATABASE_URL: 'postgresql://issuer:issuer@localhost:5433/ontos_ci',
};

it('leaves ordinary local test configuration untouched', () => {
  expect(
    Result.getOrThrow(decode({}).pipe(Result.map(integrationWorkerEnvironment), Result.map(Option.getOrUndefined))),
  ).toBeUndefined();
});

it('retargets every identity and child fixture to four distinct clusters and datastores', () => {
  for (const worker of ['1', '2', '3', '4']) {
    const current = Result.getOrThrow(
      decode({ ...environment, RSTEST_WORKER_ID: worker }).pipe(
        Result.map(integrationWorkerEnvironment),
        Result.map(Option.getOrUndefined),
      ),
    );
    for (const key of [
      'DATABASE_ADMIN_URL',
      'DATABASE_URL',
      'PARTY_REGISTRY_DATABASE_URL',
      'PARTY_REGISTRY_WORKER_DATABASE_URL',
      'SHELL_GATEWAY_ISSUER_DATABASE_URL',
    ] as const) {
      const original = new URL(environment[key]);
      const retargeted = new URL(current?.[key] ?? '');
      expect(retargeted.port).toBe(String(5540 + Number(worker)));
      expect(retargeted.username).toBe(original.username);
      expect(retargeted.password).toBe(original.password);
      expect(retargeted.pathname).toBe(original.pathname);
    }
    expect(current?.ONTOS_TEST_DB_CONTAINER).toBe(`ontos-ci-db-${worker}`);
    expect(current?.SPICEDB_ENDPOINT).toBe(`localhost:${55_050 + Number(worker)}`);
    expect(current?.SPICEDB_GRPC_PORT).toBe(String(55_050 + Number(worker)));
    expect(current?.SPICEDB_HTTP_PORT).toBe(String(58_440 + Number(worker)));
  }
});

it('refuses a missing or unprovisioned slot instead of sharing the source cluster', () => {
  for (const worker of [undefined, '0', '5', 'invalid']) {
    expect(Result.isFailure(decode({ ...environment, RSTEST_WORKER_ID: worker }))).toBe(true);
  }
  expect(Result.isFailure(decode({ ...environment, ONTOS_CI_ISOLATED_WORKERS: '2' }))).toBe(true);
  expect(Result.isFailure(decode({ ...environment, ONTOS_CI_WORKER_SLOT: '5', RSTEST_WORKER_ID: '1' }))).toBe(true);
});

it('keeps a single-worker package process in the scheduler-owned lane', () => {
  const current = Result.getOrThrow(
    decode({ ...environment, ONTOS_CI_WORKER_SLOT: '3', RSTEST_WORKER_ID: '1' }).pipe(
      Result.map(integrationWorkerEnvironment),
      Result.map(Option.getOrUndefined),
    ),
  );
  expect(current?.ONTOS_TEST_DB_CONTAINER).toBe('ontos-ci-db-3');
  expect(new URL(current?.DATABASE_ADMIN_URL ?? '').port).toBe('5543');
  expect(current?.SPICEDB_ENDPOINT).toBe('localhost:55053');
});

it('launches package and root suites with the assigned lane and propagates failures', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-integration-lane-'));
  const pricingSelector = './verticals/pricing';
  const output = path.join(directory, 'launch');
  const mise = path.join(directory, 'mise');
  const script = fileURLToPath(new URL('../ci/run-integration-suites.sh', import.meta.url));
  writeFileSync(
    mise,
    '#!/bin/sh\nprintf "%s\\n" "$ONTOS_CI_WORKER_SLOT" "$*" > "$LAUNCH_OUTPUT"\nexit "$LAUNCH_STATUS"\n',
  );
  chmodSync(mise, 0o755);
  const launchEnvironment = {
    LAUNCH_OUTPUT: output,
    LAUNCH_STATUS: '0',
    ONTOS_CI_WORKER_SLOT: '2',
    PATH: `${directory}:/usr/bin:/bin`,
  };
  try {
    execFileSync('/bin/bash', [script, '--task', pricingSelector], { env: launchEnvironment });
    expect(readFileSync(output, 'utf-8').trim().split('\n')).toEqual([
      '3',
      'exec -- pnpm --filter ./verticals/pricing run test:integration --pool.maxWorkers 1',
    ]);
    execFileSync('/bin/bash', [script, '--task', 'root:2/4'], { env: launchEnvironment });
    expect(readFileSync(output, 'utf-8').trim().split('\n')).toEqual([
      '3',
      'exec -- pnpm exec rstest --project integration --pool.maxWorkers 1 --shard 2/4',
    ]);
    expect(() =>
      execFileSync('/bin/bash', [script, '--task', pricingSelector], {
        env: { ...launchEnvironment, LAUNCH_STATUS: '9' },
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(() =>
      execFileSync('/bin/bash', [script, '--task', pricingSelector], {
        env: { ...launchEnvironment, ONTOS_CI_WORKER_SLOT: '4' },
        stdio: 'pipe',
      }),
    ).toThrow();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
