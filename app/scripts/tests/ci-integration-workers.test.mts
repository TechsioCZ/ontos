import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  IntegrationWorkerSettingsSchema,
  integrationWorkerEnvironment,
  isIntegrationWorkerEndpoint,
} from '../ci/integration-worker-environment.mts';

const testPath = '/usr/bin:/bin';
const integrationSuitesScript = fileURLToPath(new URL('../ci/run-integration-suites.sh', import.meta.url));

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
      decode({ ...environment, ONTOS_CI_WORKER_SLOT: worker }).pipe(
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
    expect(current?.ONTOS_TEST_SCHEMA_TEMPLATE_SOURCE).toBe('ontos_ci');
    expect(current?.SPICEDB_ENDPOINT).toBe(`localhost:${55_050 + Number(worker)}`);
    expect(current?.SPICEDB_GRPC_PORT).toBe(String(55_050 + Number(worker)));
    expect(current?.SPICEDB_HTTP_PORT).toBe(String(58_440 + Number(worker)));
  }
});

it('refuses a missing or unprovisioned slot instead of sharing the source cluster', () => {
  for (const worker of [undefined, '0', '5', 'invalid']) {
    expect(Result.isFailure(decode({ ...environment, ONTOS_CI_WORKER_SLOT: worker }))).toBe(true);
  }
  expect(Result.isFailure(decode({ ...environment, ONTOS_CI_ISOLATED_WORKERS: '1', ONTOS_CI_WORKER_SLOT: '1' }))).toBe(
    true,
  );
  // An Rstest worker id grows past the provisioned clusters, so it never stands in for the lane's slot.
  expect(Result.isFailure(decode({ ...environment, RSTEST_WORKER_ID: '1' }))).toBe(true);
  expect(Result.isFailure(decode({ ...environment, ONTOS_CI_WORKER_SLOT: '5', RSTEST_WORKER_ID: '1' }))).toBe(true);
});

it('keeps a single-worker package process in the scheduler-owned lane', () => {
  const current = Result.getOrThrow(
    decode({ ...environment, ONTOS_CI_WORKER_SLOT: '2', RSTEST_WORKER_ID: '1' }).pipe(
      Result.map(integrationWorkerEnvironment),
      Result.map(Option.getOrUndefined),
    ),
  );
  expect(current?.ONTOS_TEST_DB_CONTAINER).toBe('ontos-ci-db-2');
  expect(new URL(current?.DATABASE_ADMIN_URL ?? '').port).toBe('5542');
  expect(current?.SPICEDB_ENDPOINT).toBe('localhost:55052');
});

it('launches package and root suites with the assigned lane and propagates failures', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-integration-lane-'));
  const pricingSelector = './verticals/pricing';
  const output = path.join(directory, 'launch');
  const mise = path.join(directory, 'mise');
  const script = integrationSuitesScript;
  writeFileSync(
    mise,
    '#!/bin/sh\nprintf "%s\\n" "$ONTOS_CI_WORKER_SLOT" "$*" > "$LAUNCH_OUTPUT"\nexit "$LAUNCH_STATUS"\n',
  );
  chmodSync(mise, 0o755);
  const launchEnvironment = {
    LAUNCH_OUTPUT: output,
    LAUNCH_STATUS: '0',
    ONTOS_CI_WORKER_SLOT: '1',
    PATH: `${directory}:/usr/bin:/bin`,
  };
  try {
    execFileSync('/bin/bash', [script, '--task', pricingSelector], { env: launchEnvironment });
    expect(readFileSync(output, 'utf-8').trim().split('\n')).toEqual([
      '2',
      'exec -- pnpm --filter ./verticals/pricing run test:integration --pool.maxWorkers 1 --exclude tests/integration/market-revision-whole-current-pricing-postgres.test.ts',
    ]);
    execFileSync('/bin/bash', [script, '--task', 'root:2/4'], { env: launchEnvironment });
    expect(readFileSync(output, 'utf-8').trim().split('\n')).toEqual([
      '2',
      'exec -- pnpm exec rstest --project integration --pool.maxWorkers 1 --shard 2/4 --exclude scripts/integration/organization-source-customer-owner-conformance.test.mts --exclude scripts/integration/organization-source-customer-identity-conformance.test.mts --exclude scripts/integration/symmy-c14-pricing-routes-conformance.test.mts --exclude scripts/integration/scoped-owner-migrations.test.mts',
    ]);
    execFileSync('/bin/bash', [script, '--task', './verticals/commerce-customer-context#2/4'], {
      env: launchEnvironment,
    });
    expect(readFileSync(output, 'utf-8').trim().split('\n')).toEqual([
      '2',
      'exec -- pnpm --filter ./verticals/commerce-customer-context run test:integration --pool.maxWorkers 1 --shard 2/4',
    ]);
    execFileSync('/bin/bash', [script, '--task', './verticals/privacy#2/4'], {
      env: launchEnvironment,
    });
    expect(readFileSync(output, 'utf-8').trim().split('\n')).toEqual([
      '2',
      'exec -- pnpm --filter ./verticals/privacy run test:integration --pool.maxWorkers 1 --shard 2/4 --exclude tests/integration/privacy-composition-drain.test.ts',
    ]);
    for (const [task, file] of [
      ['whole:organization', 'organization-source-customer-owner-conformance'],
      ['whole:organization-identity', 'organization-source-customer-identity-conformance'],
      ['whole:pricing-routes', 'symmy-c14-pricing-routes-conformance'],
    ] as const) {
      execFileSync('/bin/bash', [script, '--task', task], { env: launchEnvironment });
      expect(readFileSync(output, 'utf-8').trim().split('\n')).toEqual([
        '2',
        `exec -- pnpm exec rstest --project integration scripts/integration/${file}.test.mts --pool.maxWorkers 1`,
      ]);
    }
    const privacyAdmissionTask = 'whole:privacy';
    const privacyRecoveryTask = 'whole:privacy-recovery';
    const privacyPatterns = new Map<string, RegExp>();
    for (const task of [privacyAdmissionTask, privacyRecoveryTask]) {
      execFileSync('/bin/bash', [script, '--task', task], { env: launchEnvironment });
      const command = readFileSync(output, 'utf-8');
      expect(command).toContain('tests/integration/privacy-composition-drain.test.ts --pool.maxWorkers 1 -t ');
      privacyPatterns.set(task, new RegExp(command.split(' -t ')[1]?.trim() ?? '', 'u'));
    }
    for (const [name, expectedTask] of [
      ['refuses foreign connection and elevated native identities before owned setup', privacyAdmissionTask],
      ['owned bootstrap source contract > matches closed fixture privileges', privacyAdmissionTask],
      ['Privacy private readiness transport > receives private Shell readiness', privacyAdmissionTask],
      ['Privacy message-bound completion admission > rolls back failed dispatch', privacyAdmissionTask],
      [
        'Privacy message-bound completion recovery > completes the real public BUSINESS_REJECTED receipt',
        privacyRecoveryTask,
      ],
      ['Privacy message-bound completion recovery > retains exact debt across process loss', privacyRecoveryTask],
    ] as const) {
      expect(
        [...privacyPatterns].filter(([, pattern]) => pattern.test(name)).map(([task]) => task),
        name,
      ).toEqual([expectedTask]);
    }
    // Both native proofs retain their package test entry and its lane environment setup.
    const timeout = path.join(directory, 'timeout');
    writeFileSync(timeout, '#!/bin/sh\nshift 2\nexec "$@"\n');
    chmodSync(timeout, 0o755);
    for (const [task, name] of [
      ['whole:preproposal-basis', 'produces an exact preproposal basis'],
      ['whole:preproposal-approval', 'submits and approves'],
    ] as const) {
      execFileSync('/bin/bash', [script, '--task', task], { env: launchEnvironment });
      expect(readFileSync(output, 'utf-8').trim().split('\n')).toEqual([
        '2',
        `exec -- pnpm --filter @app/commerce-customer-context run test:integration:native-preproposal -t ${name}`,
      ]);
    }
    expect(() =>
      execFileSync('/bin/bash', [script, '--task', pricingSelector], {
        env: { ...launchEnvironment, LAUNCH_STATUS: '9' },
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(() =>
      execFileSync('/bin/bash', [script, '--task', pricingSelector], {
        env: { ...launchEnvironment, ONTOS_CI_WORKER_SLOT: '5' },
        stdio: 'pipe',
      }),
    ).toThrow();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('recognizes only a provisioned worker container and port pair in isolated CI mode', () => {
  for (const slot of [1, 2, 3, 4]) {
    const endpoint = { container: `ontos-ci-db-${slot}`, isolatedWorkers: '4', port: 5540 + slot };
    expect(isIntegrationWorkerEndpoint(endpoint)).toBe(true);
    expect(isIntegrationWorkerEndpoint({ ...endpoint, isolatedWorkers: '' })).toBe(false);
    expect(isIntegrationWorkerEndpoint({ ...endpoint, port: 5433 })).toBe(false);
    expect(isIntegrationWorkerEndpoint({ ...endpoint, container: 'unowned-cluster' })).toBe(false);
  }
  expect(isIntegrationWorkerEndpoint({ container: 'ontos-ci-db-5', isolatedWorkers: '4', port: 5545 })).toBe(false);
});

/** Lists the scheduler's tasks for this environment. */
const listTasks = (env: Readonly<Record<string, string>>) => () =>
  execFileSync('/bin/bash', [integrationSuitesScript, '--list'], { env, stdio: 'pipe' });

it('refuses to start without an explicit task list instead of inventing one', () => {
  expect(listTasks({ PATH: testPath })).toThrow();
  for (const tasks of ['null', '[]']) {
    expect(listTasks({ INTEGRATION_TASKS: tasks, PATH: testPath })).toThrow();
  }
});

it('refuses a missing database archive before writing into any worker cluster', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-archive-boundary-'));
  const invoked = path.join(directory, 'docker-invoked');
  const docker = path.join(directory, 'docker');
  writeFileSync(docker, '#!/bin/sh\ntouch "$DOCKER_INVOKED"\n');
  chmodSync(docker, 0o755);
  try {
    expect(() =>
      execFileSync('/bin/bash', [fileURLToPath(new URL('../ci/restore-integration-workers.sh', import.meta.url))], {
        env: {
          DOCKER_INVOKED: invoked,
          GITHUB_SHA: 'a'.repeat(40),
          INTEGRATION_DATABASE_ARCHIVE: directory,
          ONTOS_CI_ISOLATED_WORKERS: '2',
          PATH: `${directory}:${testPath}`,
          POSTGRES_DB: 'ontos_ci',
          POSTGRES_PASSWORD: 'test',
          POSTGRES_USER: 'ci_admin',
          RUNNER_TEMP: directory,
          SPICEDB_PRESHARED_KEY: 'test',
        },
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(existsSync(invoked)).toBe(false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('runs the explicit measured schedule without adding implicit package or root tasks', () => {
  const rows = Schema.decodeUnknownSync(
    Schema.Struct({
      integration: Schema.Array(Schema.Struct({ tasks: Schema.optional(Schema.Array(Schema.String)) })),
    }),
  )(JSON.parse(readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'))).integration;
  for (const row of rows) {
    if (row.tasks === undefined) {
      continue;
    }
    const tasks = execFileSync('/bin/bash', [integrationSuitesScript, '--list'], {
      env: { INTEGRATION_TASKS: JSON.stringify(row.tasks), PATH: testPath },
    })
      .toString()
      .split('\0')
      .filter(Boolean);
    expect(tasks).toEqual(row.tasks);
  }
});

it('accepts two active lanes but refuses an unprovisioned third cluster', () => {
  const settings = { ...environment, ONTOS_CI_ISOLATED_WORKERS: '2', ONTOS_CI_WORKER_SLOT: '2' };
  expect(Result.isSuccess(decode(settings))).toBe(true);
  expect(Result.isFailure(decode({ ...settings, ONTOS_CI_WORKER_SLOT: '3' }))).toBe(true);
  expect(isIntegrationWorkerEndpoint({ container: 'ontos-ci-db-2', isolatedWorkers: '2', port: 5542 })).toBe(true);
  expect(isIntegrationWorkerEndpoint({ container: 'ontos-ci-db-3', isolatedWorkers: '2', port: 5543 })).toBe(false);
});
