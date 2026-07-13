import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const appRoot = path.resolve(new URL('..', import.meta.url).pathname);

const createWorkspace = async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ontos-policy-boundaries-'));
  await mkdir(path.join(workspaceRoot, 'verticals/ticketing/src/actions'), {
    recursive: true,
  });
  await mkdir(path.join(workspaceRoot, 'verticals/ticketing/src/policies'), {
    recursive: true,
  });
  await mkdir(path.join(workspaceRoot, 'verticals/accounting/src/policies'), {
    recursive: true,
  });
  await writeFile(
    path.join(workspaceRoot, 'verticals/ticketing/package.json'),
    '{"name":"@app/ticketing"}\n',
    'utf-8',
  );
  await writeFile(
    path.join(workspaceRoot, 'verticals/accounting/package.json'),
    '{"name":"@app/accounting"}\n',
    'utf-8',
  );
  await writeFile(
    path.join(workspaceRoot, 'verticals/ticketing/src/policies/index.ts'),
    'export const ticketingPolicies = {} as const;\n',
    'utf-8',
  );
  await writeFile(
    path.join(workspaceRoot, 'verticals/accounting/src/policies/index.ts'),
    'export const accountingPolicies = {} as const;\n',
    'utf-8',
  );
  return workspaceRoot;
};

const runBoundaryCheck = (workspaceRoot) =>
  spawnSync(process.execPath, [path.join(appRoot, 'scripts/check-policy-boundaries.mts')], {
    cwd: appRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot,
    },
  });

test('policy boundary check allows core and same-microvertical policy imports', async () => {
  const workspaceRoot = await createWorkspace();
  try {
    await writeFile(
      path.join(workspaceRoot, 'verticals/ticketing/src/actions/create-ticket.ts'),
      `import { corePolicies } from '@app/core-runtime/policies';
import { ticketingPolicies } from '../policies';

void corePolicies;
void ticketingPolicies;
`,
      'utf-8',
    );

    const result = runBoundaryCheck(workspaceRoot);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Policy boundary check passed\./u);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test('policy boundary check blocks relative imports from another microvertical policy namespace', async () => {
  const workspaceRoot = await createWorkspace();
  try {
    await writeFile(
      path.join(workspaceRoot, 'verticals/ticketing/src/actions/create-ticket.ts'),
      `import { accountingPolicies } from '../../../accounting/src/policies';

void accountingPolicies;
`,
      'utf-8',
    );

    const result = runBoundaryCheck(workspaceRoot);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /must not import another microvertical's policies \(\.\.\/\.\.\/\.\.\/accounting\/src\/policies\)/u,
    );
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test('policy boundary check blocks package imports from another microvertical policy namespace', async () => {
  const workspaceRoot = await createWorkspace();
  try {
    await writeFile(
      path.join(workspaceRoot, 'verticals/ticketing/src/actions/create-ticket.ts'),
      `import { accountingPolicies } from '@app/accounting/policies';

void accountingPolicies;
`,
      'utf-8',
    );

    const result = runBoundaryCheck(workspaceRoot);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /must not import another microvertical's policies \(@app\/accounting\/policies\)/u,
    );
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});
