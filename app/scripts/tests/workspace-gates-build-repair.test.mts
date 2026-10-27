import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const appRoot = path.resolve(import.meta.dirname, '../..');
const proofFile = path.join(appRoot, 'scripts/prove-cloudflare-local-topology.sh');
const mfConfigSchema = Schema.fromJsonString(
  Schema.Struct({
    extends: Schema.String,
    include: Schema.Array(Schema.String),
  }),
);

it.each([
  ['facility-operations', 'src/ui/pdf-worker.d.ts'],
  ['property-leasing', 'src/pdfjs-worker.d.ts'],
  ['legal-agreements', 'src/pdfjs-worker.d.ts'],
])('includes %s ambient PDF worker types in the native MF declaration project', (owner, declaration) => {
  const directory = path.join(appRoot, 'verticals', owner);
  const config = Schema.decodeUnknownSync(mfConfigSchema)(
    readFileSync(path.join(directory, 'tsconfig.mf-types.json'), 'utf-8'),
  );
  expect(config.extends).toBe('../../tsconfig.base.json');
  expect(config.include).toContain(declaration);
  expect(readFileSync(path.join(directory, declaration), 'utf-8')).toContain(
    "declare module 'pdfjs-dist/build/pdf.worker.mjs';",
  );
});

const proofCurl = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const url = args.at(-1);
const state = path.join(process.env.PROOF_FIXTURE, 'grant');
const calls = path.join(process.env.PROOF_FIXTURE, 'calls');
const withdrawn = () => fs.readFileSync(state, 'utf8') === 'withdrawn';
const mode = process.env.PROOF_MODE;
if (url.endsWith('/v1/relationships/write')) {
  const body = JSON.parse(option('--data'));
  if (body.updates.length !== 1) throw new Error('Only the exact module parent relationship may change');
  const { operation, relationship } = body.updates[0];
  const expected = {
    resource: { objectType: 'module_access', objectId: Buffer.from('["tenant","company","party.registry"]').toString('base64url').replace(/^/, 'ctx_') },
    relation: 'legal_entity',
    subject: { object: { objectType: 'legal_entity', objectId: Buffer.from('["tenant","company"]').toString('base64url').replace(/^/, 'ctx_') } },
  };
  if (JSON.stringify(relationship) !== JSON.stringify(expected)) throw new Error('A foreign grant changed');
  fs.appendFileSync(calls, operation + '\n');
  if (operation === 'OPERATION_TOUCH' && mode === 'restore-fails') process.exit(24);
  fs.writeFileSync(state, operation === 'OPERATION_DELETE' ? 'withdrawn' : 'present');
  process.exit(0);
}
const denied = withdrawn() || mode === 'initial-denied';
let status = 200;
let body;
if (url.includes('/shell/composition?')) {
  const leak = denied && mode === 'leaked-navigation';
  body = {
    state: denied && mode === 'blocked-frame' ? 'access_blocked' : 'available',
    compositionRevision: denied && mode === 'wrong-revision' ? 'wrong' : 'revision',
    navigation: denied && !leak ? [] : [{ appId: 'party-registry', moduleId: 'party.registry' }],
    homeComponents: denied && mode === 'leaked-home' ? [{ moduleId: 'party.registry' }] : [],
    gatewayAudiences: denied && mode !== 'leaked-audience' ? [] : ['party-registry'],
    deniedAppIds: denied && mode !== 'missing-denial' ? ['party-registry'] : [],
    unavailableDeployments: [],
  };
} else if (url.endsWith('/shell/module-target')) {
  if (!args.includes('--data-binary')) throw new Error('The admitted page selector is required');
  const selector = JSON.parse(fs.readFileSync(option('--data-binary').slice(1), 'utf8'));
  if (selector.canonicalPath !== '/people' || selector.compositionRevision !== 'revision') throw new Error('Unpinned page selector');
  status = denied && mode !== 'allowed-target' ? 403 : 200;
  body = { _tag: mode === 'wrong-problem' ? 'OtherProblem' : 'ShellTargetForbiddenProblem', status };
} else {
  throw new Error('Unexpected network operation: ' + url);
}
fs.appendFileSync(calls, (denied ? 'denied ' : 'allowed ') + url + '\n');
fs.writeFileSync(option('--output'), JSON.stringify(body));
process.stdout.write(String(status));
`;

/** Execute only the real authorization-control block, with every HTTP call replaced by local files. */
const runCompositionControl = (mode: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-workspace-gates-denial-'));
  try {
    const work = path.join(directory, 'run');
    const bin = path.join(directory, 'bin');
    mkdirSync(path.join(work, 'logs'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'curl'), proofCurl);
    chmodSync(path.join(bin, 'curl'), 0o700);
    writeFileSync(path.join(directory, 'grant'), 'present');
    writeFileSync(path.join(directory, 'calls'), '');
    writeFileSync(
      path.join(work, 'paths.json'),
      JSON.stringify({
        party: { appId: 'party-registry', moduleId: 'party.registry', routePath: '/people' },
        revision: 'revision',
      }),
    );
    const source = readFileSync(proofFile, 'utf-8');
    const cleanup = source.slice(source.indexOf('cleanup()'), source.indexOf('\ntrap cleanup EXIT INT TERM'));
    const requests = source.slice(source.indexOf('check() {'), source.indexOf('# 1. Database'));
    const control = source.slice(
      source.indexOf('# 2. SpiceDB'),
      source.indexOf('# Validate the restored target against'),
    );
    const result = spawnSync(
      '/bin/bash',
      [
        '-euo',
        'pipefail',
        '-c',
        [
          'work="$1"; shell_origin="http://localhost:8787"; owner_certificate=fixture; spicedb_certificate=fixture',
          'SPICEDB_HTTP_PORT=8443; SPICEDB_PRESHARED_KEY=fixture; tenant_id=tenant; legal_entity_id=company',
          'principal_id=principal; revision=revision; pids=(); dev_vars_outputs=(); local_configs=()',
          'authority_fixture_started=false; shell_grant_withdrawn=false',
          cleanup,
          'trap cleanup EXIT INT TERM',
          requests,
          control,
        ].join('\n'),
        'proof-fixture',
        work,
      ],
      {
        encoding: 'utf-8',
        env: {
          PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
          PROOF_FIXTURE: directory,
          PROOF_MODE: mode,
        },
        timeout: 20_000,
      },
    );
    return {
      calls: readFileSync(path.join(directory, 'calls'), 'utf-8').trim().split('\n'),
      grant: readFileSync(path.join(directory, 'grant'), 'utf-8'),
      output: result.stdout + result.stderr,
      status: result.status,
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

it('proves composition capability denial and a real forbidden page target before restoring its exact grant', () => {
  const result = runCompositionControl('valid');
  expect(result.status, result.output).toBe(0);
  expect(result.grant).toBe('present');
  expect(result.calls).toEqual([
    'allowed http://localhost:8787/shell-super-app-api/shell/composition?compositionRevision=revision',
    'OPERATION_DELETE',
    'denied http://localhost:8787/shell-super-app-api/shell/composition?compositionRevision=revision',
    'denied http://localhost:8787/shell-super-app-api/shell/module-target',
    'OPERATION_TOUCH',
    'allowed http://localhost:8787/shell-super-app-api/shell/composition?compositionRevision=revision',
    'allowed http://localhost:8787/shell-super-app-api/shell/module-target',
  ]);
});

it.each([
  'leaked-navigation',
  'leaked-home',
  'leaked-audience',
  'missing-denial',
  'wrong-revision',
  'blocked-frame',
  'allowed-target',
  'wrong-problem',
])('rejects %s while always restoring the withdrawn grant', (mode) => {
  const result = runCompositionControl(mode);
  expect(result.status, result.output).not.toBe(0);
  expect(result.grant).toBe('present');
  expect(result.calls).toContain('OPERATION_DELETE');
  expect(result.calls.at(-1)).toBe('OPERATION_TOUCH');
});

it('fails when restoration fails and retries the exact grant in exit cleanup', () => {
  const result = runCompositionControl('restore-fails');
  expect(result.status, result.output).not.toBe(0);
  expect(result.calls.filter((call) => call === 'OPERATION_TOUCH')).toHaveLength(2);
});

it('does not withdraw or create a grant when the initial composition lacks the capability', () => {
  const result = runCompositionControl('initial-denied');
  expect(result.status, result.output).not.toBe(0);
  expect(result.calls.some((call) => call.startsWith('OPERATION_'))).toBe(false);
  expect(result.grant).toBe('present');
});
