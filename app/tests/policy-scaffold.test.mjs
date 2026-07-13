import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const policyGenerator = require('../scripts/codesmith/generators/policy');
const appRoot = path.resolve(new URL('..', import.meta.url).pathname);

const createWorkspace = async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ontos-policy-scaffold-'));
  await mkdir(path.join(workspaceRoot, 'packages/core-runtime/src/policies'), {
    recursive: true,
  });
  await mkdir(path.join(workspaceRoot, 'verticals/ticketing/src/policies'), {
    recursive: true,
  });
  await mkdir(path.join(workspaceRoot, 'verticals/accounting/src/policies'), {
    recursive: true,
  });
  await symlink(path.join(appRoot, 'node_modules'), path.join(workspaceRoot, 'node_modules'));
  await writeFile(
    path.join(workspaceRoot, 'core-runtime-stub.ts'),
    `export interface PolicyAllowed {
  readonly ok: true;
  readonly policyKey: string;
  readonly reason: string;
}

export interface PolicyExecutionInput<TInput> {
  readonly data: TInput;
  readonly db: {
    readonly select: unknown;
  };
  readonly operation: {
    readonly action: TInput;
  };
}

export type PolicyDecision = PolicyAllowed;

export type PolicyCheck<TInput> = (
  input: PolicyExecutionInput<TInput>,
) => PolicyDecision | Promise<PolicyDecision>;

export declare const allowPolicy: (input: {
  readonly policyKey: string;
  readonly reason: string;
}) => PolicyAllowed;
`,
    'utf-8',
  );
  await writeFile(
    path.join(workspaceRoot, 'packages/core-runtime/src/policy.ts'),
    `export interface PolicyAllowed {
  readonly ok: true;
  readonly policyKey: string;
  readonly reason: string;
}

export interface PolicyExecutionInput<TInput> {
  readonly data: TInput;
  readonly db: {
    readonly select: unknown;
  };
  readonly operation: {
    readonly action: TInput;
  };
}

export type PolicyDecision = PolicyAllowed;

export type PolicyCheck<TInput> = (
  input: PolicyExecutionInput<TInput>,
) => PolicyDecision | Promise<PolicyDecision>;

export const allowPolicy = (input: {
  readonly policyKey: string;
  readonly reason: string;
}): PolicyAllowed => ({
  ok: true,
  policyKey: input.policyKey,
  reason: input.reason,
});
`,
    'utf-8',
  );
  await writeFile(
    path.join(workspaceRoot, 'packages/core-runtime/src/policies/index.ts'),
    'export const corePolicies = {} as const;\n',
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

  return workspaceRoot;
};

const runGenerator = (workspaceRoot, config) =>
  policyGenerator(
    {
      config,
      materials: {
        default: {
          basePath: workspaceRoot,
        },
      },
    },
    {
      logger: {
        info(message) {
          assert.equal(typeof message, 'string');
        },
      },
    },
  );

const pathExists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const assertGeneratedPoliciesAreWireable = async (workspaceRoot) => {
  await writeFile(
    path.join(workspaceRoot, 'policy-wiring-proof.ts'),
    `import { corePolicies } from './packages/core-runtime/src/policies/index.ts';
import type { PolicyCheck } from './packages/core-runtime/src/policy.ts';
import { ticketingPolicies } from './verticals/ticketing/src/policies/index.ts';

interface TInput {
  readonly targetResourceId: string;
}

const policyChecks: readonly PolicyCheck<TInput>[] = [
  corePolicies.requireAuthenticatedPrincipal,
  ticketingPolicies.targetResourcePresent,
];

void policyChecks;
`,
    'utf-8',
  );
  await writeFile(
    path.join(workspaceRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          allowImportingTsExtensions: true,
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          paths: {
            '@app/core-runtime': ['./core-runtime-stub.ts'],
          },
          strict: true,
          target: 'ESNext',
        },
        include: ['policy-wiring-proof.ts'],
      },
      null,
      2,
    ),
    'utf-8',
  );

  const result = spawnSync(path.join(appRoot, 'node_modules/.bin/tsgo'), ['-p', 'tsconfig.json'], {
    cwd: workspaceRoot,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
};

test('policy scaffold creates global and microvertical policies and rejects duplicates', async () => {
  const workspaceRoot = await createWorkspace();
  try {
    await runGenerator(workspaceRoot, {
      policy: 'require-authenticated-principal',
      scope: 'global',
    });
    await runGenerator(workspaceRoot, {
      policy: 'target-resource-present',
      scope: 'microvertical',
      vertical: 'ticketing',
    });
    await runGenerator(workspaceRoot, {
      policy: 'target-resource-present',
      scope: 'microvertical',
      vertical: 'accounting',
    });

    const globalPolicy = await readFile(
      path.join(
        workspaceRoot,
        'packages/core-runtime/src/policies/require-authenticated-principal.ts',
      ),
      'utf-8',
    );
    assert.match(globalPolicy, /policyKey: ["']core\.requireAuthenticatedPrincipal["']/u);
    assert.match(globalPolicy, /export interface TInput/u);
    assert.match(globalPolicy, /PolicyCheck<TInput>/u);
    assert.match(globalPolicy, /Policy placeholder allows by default until implemented\./u);

    const globalIndex = await readFile(
      path.join(workspaceRoot, 'packages/core-runtime/src/policies/index.ts'),
      'utf-8',
    );
    assert.match(globalIndex, /corePolicies/u);
    assert.match(globalIndex, /requireAuthenticatedPrincipal/u);

    const ticketingIndex = await readFile(
      path.join(workspaceRoot, 'verticals/ticketing/src/policies/index.ts'),
      'utf-8',
    );
    assert.match(ticketingIndex, /ticketingPolicies/u);
    assert.match(ticketingIndex, /targetResourcePresent/u);

    await assertGeneratedPoliciesAreWireable(workspaceRoot);

    await assert.rejects(
      () =>
        runGenerator(workspaceRoot, {
          policy: 'require-authenticated-principal',
          scope: 'global',
        }),
      /Global policy already exists/u,
    );
    await assert.rejects(
      () =>
        runGenerator(workspaceRoot, {
          policy: 'global-with-vertical',
          scope: 'global',
          vertical: 'ticketing',
        }),
      /vertical is only supported for microvertical policy generation/u,
    );
    await assert.rejects(
      () =>
        runGenerator(workspaceRoot, {
          policy: 'target-resource-present',
          scope: 'microvertical',
          vertical: 'ticketing',
        }),
      /Microvertical policy already exists/u,
    );
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test('policy scaffold fails safely when an index has an unrecognized shape', async () => {
  const workspaceRoot = await createWorkspace();
  try {
    await writeFile(
      path.join(workspaceRoot, 'verticals/ticketing/src/policies/index.ts'),
      'export const custom = true;\n',
      'utf-8',
    );

    await assert.rejects(
      () =>
        runGenerator(workspaceRoot, {
          policy: 'target-resource-present',
          scope: 'microvertical',
          vertical: 'ticketing',
        }),
      /Could not safely update verticals\/ticketing\/src\/policies\/index\.ts/u,
    );
    assert.equal(
      await pathExists(
        path.join(workspaceRoot, 'verticals/ticketing/src/policies/target-resource-present.ts'),
      ),
      false,
    );
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});
