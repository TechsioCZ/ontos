import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Option, Order } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreMediaEvidence } from '../ci/core-media-evidence.mts';
import type { RunInput } from '../ci/core-media-evidence.mts';

const app = fileURLToPath(new URL('../../', import.meta.url));
const SHELL = 'apps/shell-super-app';
const UNRECORDED = ['never', 'recorded', 'secret'].join('-');
const DECLARED = `${SHELL}/tests/integration/core-media-e2e-current.test.ts`;

const run = (results: readonly string[], overrides: Partial<RunInput> = {}): RunInput => ({
  declared: [DECLARED],
  name: 'shell-e2e',
  packageDirectory: SHELL,
  report: Option.some({
    files: [
      {
        results: results.map((status, index) => ({ fullName: `case ${index}`, status })),
        status: results.includes('fail') ? 'fail' : 'pass',
        testPath: 'tests/integration/core-media-e2e-current.test.ts',
      },
    ],
    status: results.includes('fail') ? 'fail' : 'pass',
  }),
  settings: { D20_E2E_REQUIRED: '1' },
  ...overrides,
});

it('records a pass only when every declared file ran and every one of its cases passed', () => {
  expect(coreMediaEvidence([run(['pass', 'pass'])])).toMatchObject({
    status: 'PASS',
    totals: { failed: 0, files: 1, passed: 2, skipped: 0 },
  });
  // A skip is never a pass, and neither is a run that reported nothing about a declared file.
  for (const incomplete of [
    run(['pass', 'skip']),
    run(['todo']),
    run([]),
    run(['pass'], { report: Option.none() }),
    run(['pass'], { declared: [DECLARED, `${SHELL}/tests/integration/core-media-e2e-http-routes.test.ts`] }),
  ]) {
    expect(coreMediaEvidence([incomplete]).status).toBe('NOT VERIFIED');
  }
  expect(coreMediaEvidence([]).status).toBe('NOT VERIFIED');
  expect(coreMediaEvidence([run(['pass', 'fail']), run(['skip'])]).status).toBe('FAIL');
  // A report can fail with no failed case, for example on an unhandled error.
  const unhandled = run(['pass']);
  expect(
    coreMediaEvidence([
      { ...unhandled, report: unhandled.report.pipe(Option.map((report) => ({ ...report, status: 'fail' }))) },
    ]).status,
  ).toBe('FAIL');
});

const fingerprint = (settings: RunInput['settings']) =>
  coreMediaEvidence([run(['pass'], { settings })]).runs[0]?.configFingerprint;

it('fingerprints the recorded settings independently of their order', () => {
  const recorded = fingerprint({ BUCKET: 'b', REGION: 'r' });
  expect(
    fingerprint(
      Object.fromEntries([
        ['REGION', 'r'],
        ['BUCKET', 'b'],
      ]),
    ),
  ).toBe(recorded);
  expect(fingerprint({ BUCKET: 'b', REGION: 'other' })).not.toBe(recorded);
});

const testFiles = (launch: string | undefined) => launch?.match(/tests\/integration\/\S+\.test\.ts/gu) ?? [];

it('requires every case, runs the digest guard with its own setting and records no credential', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-core-media-proof-'));
  const launches = path.join(directory, 'launches');
  const evidence = path.join(directory, 'evidence');
  // Stands in for pnpm and the evidence command: it records what each launch would have run with.
  writeFileSync(
    path.join(directory, 'mise'),
    [
      '#!/bin/sh',
      'guard="$(printenv CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS || echo unset)"',
      String.raw`printf "%s|%s|%s|%s|%s\n" "$D20_E2E_REQUIRED" "$guard" "$CORE_MEDIA_S3_ENDPOINT" "$SPICEDB_ENDPOINT" "$*" >>"$LAUNCHES"`,
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(directory, 'docker'), '#!/bin/sh\necho pinned-emulator-image\n');
  for (const executable of ['mise', 'docker']) {
    chmodSync(path.join(directory, executable), 0o755);
  }
  try {
    execFileSync('/bin/bash', [path.join(app, 'scripts/ci/run-core-media-proof.sh')], {
      cwd: app,
      env: {
        CORE_MEDIA_EVIDENCE_DIR: evidence,
        LAUNCHES: launches,
        ONTOS_CI_CORE_MEDIA_COMPOSITION_PORT: '19012',
        ONTOS_CI_CORE_MEDIA_ENGINE_RELAY_PORT: '19011',
        ONTOS_CI_CORE_MEDIA_S3_RELAY_PORT: '19010',
        ONTOS_CI_MINIO_BUCKET: 'bucket',
        ONTOS_CI_MINIO_PORT: '19000',
        ONTOS_CI_MINIO_ROOT_PASSWORD: UNRECORDED,
        ONTOS_CI_MINIO_ROOT_USER: 'never-recorded-user',
        ONTOS_GATEWAY_ISSUER: 'http://localhost:3020',
        ONTOS_GATEWAY_PRIVATE_JWK: 'never-recorded-key',
        ONTOS_GATEWAY_PUBLIC_JWKS: 'public',
        PATH: `${directory}:/usr/bin:/bin`,
        SPICEDB_ENDPOINT: 'localhost:50051',
      },
      stdio: 'pipe',
    });
    const [e2e, guard, providers, record] = readFileSync(launches, 'utf-8').trim().split('\n');
    expect(e2e).toContain(
      '1|unset|http://127.0.0.1:19010|localhost:19011|exec -- pnpm --filter ./apps/shell-super-app',
    );
    expect(guard).toContain('1|50|http://127.0.0.1:19010|localhost:19011|exec -- pnpm --filter ./apps/shell-super-app');
    expect(providers).toContain(
      '1|unset|http://127.0.0.1:19000|localhost:50051|exec -- pnpm --filter ./packages/core-runtime',
    );
    expect(record).toContain('exec -- node scripts/ci/core-media-evidence.mts --runs ');
    for (const launch of [e2e, guard, providers]) {
      expect(launch).toContain('--pool.maxWorkers 1 --testTimeout 120000');
    }
    // Every Shell end-to-end file runs exactly once, the digest guard only with its setting.
    const shellFiles = readdirSync(path.join(app, SHELL, 'tests/integration'))
      .filter((file) => file.startsWith('core-media-e2e-'))
      .map((file) => `tests/integration/${file}`);
    expect(EffectArray.sort([...testFiles(e2e), ...testFiles(guard)], Order.String)).toEqual(
      EffectArray.sort(shellFiles, Order.String),
    );
    expect(testFiles(guard)).toEqual(['tests/integration/core-media-e2e-digest-step-guard.test.ts']);
    // Every suite that registers the provider rows runs here: left in a shard without a store it would only skip.
    const coreIntegration = path.join(app, 'packages/core-runtime/tests/integration');
    const providerSuites = readdirSync(coreIntegration)
      .filter((file) => readFileSync(path.join(coreIntegration, file), 'utf-8').includes('/s3-provider-under-test.ts'))
      .map((file) => `tests/integration/${file}`);
    expect(EffectArray.sort(testFiles(providers), Order.String)).toEqual(
      EffectArray.sort(providerSuites, Order.String),
    );
    // The declarations and settings the record is built from hold no credential.
    const runs = path.join(evidence, 'runs');
    const recorded = readdirSync(runs)
      .map((file) => readFileSync(path.join(runs, file), 'utf-8'))
      .join('');
    expect(recorded).toContain('pinned-emulator-image');
    expect(recorded).not.toContain('never-recorded');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
