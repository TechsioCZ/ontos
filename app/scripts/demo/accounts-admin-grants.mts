#!/usr/bin/env node
/**
 * Accounts-admin lane: grants the company administrators the people-administration capability. LOCAL ONLY,
 * idempotent; run after `reset-permissions.mts` (SpiceDB is in-memory, so rerun after a container restart).
 *
 *   node scripts/demo/accounts-admin-grants.mts
 *
 * Per company administrator: tenant `identity_admin` (Core `manage_identity`), `core.identity` module access in
 * its company and the explicit executor grant of `core.identity.manage-demo-account`. The Siampark administrator
 * (management@siampark.demo) also gets the workforce module so the „Lidé a role“ page is reachable for them.
 * Relationships are written through the same Core development bootstrap port `reset-permissions.mts` uses.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { toSpiceDbActionObjectId } from '@app/core-runtime/actions/runtime-wiring';

import { demoId, demoTenantId } from './fixture-ids.mts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const actionKey = 'core.identity.manage-demo-account';

interface Administrator {
  readonly extraModules: readonly string[];
  readonly legalEntityId: string;
  readonly principalId: string;
}

const administrators: readonly Administrator[] = [
  {
    extraModules: [],
    legalEntityId: '71000000-0000-4000-8000-000000000020',
    principalId: demoId('core.principal', 'obchod'),
  },
  {
    extraModules: ['demo.workforce'],
    legalEntityId: '71000000-0000-4000-8000-000000000021',
    principalId: '72000000-0000-4000-8000-000000000021',
  },
  {
    extraModules: [],
    legalEntityId: '71000000-0000-4000-8000-000000000022',
    principalId: demoId('core.principal', 'hanak-spravce'),
  },
  {
    extraModules: [],
    legalEntityId: '71000000-0000-4000-8000-000000000023',
    principalId: demoId('core.principal', 'kavarna-eshop'),
  },
];

const administratorRelationships = administrators.flatMap(({ extraModules, legalEntityId, principalId }) => {
  const action = toSpiceDbActionObjectId(actionKey);
  const legal = toLegalEntityAccessObjectId(demoTenantId, legalEntityId) ?? '';
  const rel = (resourceType: string, resourceId: string, relation: string, subjectType: string, subjectId: string) => ({
    relation,
    resourceId,
    resourceType,
    subjectId,
    subjectType,
  });
  return [
    rel('action', action, 'restriction', 'action', action),
    rel('action', action, 'executor', 'principal', principalId),
    rel('tenant', demoTenantId, 'identity_admin', 'principal', principalId),
    ...['core.identity', ...extraModules].flatMap((moduleId) => {
      const object = toModuleAccessObjectId(demoTenantId, legalEntityId, moduleId) ?? '';
      return [
        rel('module_access', object, 'legal_entity', 'legal_entity', legal),
        rel('module_access', object, 'accessor', 'principal', principalId),
      ];
    }),
  ];
});

// S13: every Siampark persona can open My tasks. These two grants deliberately do NOT include
// read_all or an action executor: owner-scoped Reads return only the principal's assigned tasks.
const siampark = '71000000-0000-4000-8000-000000000021';
const management = '72000000-0000-4000-8000-000000000021';
const ownTaskReaders = ['72000000-0000-4000-8000-000000000023', '72000000-0000-4000-8000-000000000024'];
const ownTaskRelationships = ownTaskReaders.flatMap((principalId) =>
  ['siampark.work', 'demo.workforce'].flatMap((moduleId) => {
    const resourceId = toModuleAccessObjectId(demoTenantId, siampark, moduleId) ?? '';
    return [
      {
        resourceType: 'module_access',
        resourceId,
        relation: 'legal_entity',
        subjectType: 'legal_entity',
        subjectId: toLegalEntityAccessObjectId(demoTenantId, siampark) ?? '',
      },
      {
        resourceType: 'module_access',
        resourceId,
        relation: 'accessor',
        subjectType: 'principal',
        subjectId: principalId,
      },
    ];
  }),
);
// The people administrator maintains the employee-to-login bindings used for real task assignment.
const workforceAction = toSpiceDbActionObjectId('demo.workforce.apply-command');
const workforceManagementRelationships = [
  {
    resourceType: 'action',
    resourceId: workforceAction,
    relation: 'restriction',
    subjectType: 'action',
    subjectId: workforceAction,
  },
  {
    resourceType: 'action',
    resourceId: workforceAction,
    relation: 'executor',
    subjectType: 'principal',
    subjectId: management,
  },
  ...['demo.workforce.read_all', 'demo.workforce.write_all'].flatMap((permission) => {
    const resourceId =
      toContextPermissionAccessObjectId(demoTenantId, siampark, { moduleId: 'demo.workforce', permission }) ?? '';
    return [
      {
        resourceType: 'context_permission',
        resourceId,
        relation: 'tenant',
        subjectType: 'tenant',
        subjectId: demoTenantId,
      },
      {
        resourceType: 'context_permission',
        resourceId,
        relation: 'grantee',
        subjectType: 'principal',
        subjectId: management,
      },
    ];
  }),
];
const allRelationships = [...administratorRelationships, ...ownTaskRelationships, ...workforceManagementRelationships];
const relationships = [
  ...new Map(
    allRelationships.map((relationship) => [
      [
        relationship.resourceType,
        relationship.resourceId,
        relationship.relation,
        relationship.subjectType,
        relationship.subjectId,
      ].join('|'),
      relationship,
    ]),
  ).values(),
];

const envFile = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u.exec(line.trim());
      if (match?.groups === undefined) {
        return [];
      }
      const raw = match.groups['value'] ?? '';
      const value = /^".*"$/u.test(raw) ? raw.slice(1, -1).replaceAll('\\n', '\n').replaceAll('\\"', '"') : raw;
      return [[match.groups['key'] ?? '', value] as const];
    }),
);

const fixture = {
  accounts: [],
  legalEntity: {
    legalEntityId: '71000000-0000-4000-8000-000000000020',
    legalName: 'Obchodní firma',
    registrationCountry: 'CZ',
    registrationNumber: 'DEMO-SIAMPARK',
  },
  modules: [],
  relationships,
  tenant: { defaultLocale: 'cs', displayName: 'Siampark DEMO', slug: 'siampark-demo', tenantId: demoTenantId },
};

const directory = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'accounts-admin-grants-'));
try {
  const file = join(directory, 'context.json');
  writeFileSync(file, JSON.stringify(fixture));
  const result = spawnSync(
    process.execPath,
    [join(root, 'packages/core-runtime/scripts/bootstrap-development-context.mts'), '--fixture', file],
    {
      cwd: root,
      env: { ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development', ...envFile, ...process.env, MISE_ARGV0: '' },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    console.error('accounts-admin grants: Core development bootstrap port failed');
    process.exitCode = 1;
  } else {
    console.log(
      `accounts-admin grants: ${relationships.length} relationships for ${administrators.length} administrators`,
    );
  }
} finally {
  rmSync(directory, { force: true, recursive: true });
}
