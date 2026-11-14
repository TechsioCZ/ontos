// @effect-diagnostics nodeBuiltinImport:off -- Synchronous static scan of the workspace sources, like the transaction guard's own boundary tests.
import { readFileSync, readdirSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

/**
 * Declared in-transaction evidence calls (DEPLOYMENT.md, demo divergence): main's source-evidence proofs that the
 * trunk's transaction I/O guard admits at their call sites. The number may only go down. Removing a proof means
 * deleting its registry entry and its line here; adding one fails this test.
 */
const PINNED_DECLARATIONS = [
  'commerce.customer-context commerce.counterparty-migration-correlation',
  'commerce.customer-context commerce.counterparty-organization-ico-facts',
  'commerce.customer-context commerce.legacy-ico-inventory',
  'commerce.customer-context commerce.organization-business-eligibility',
  'commerce.customer-context commerce.organization-profile-ico-eligibility',
  'commerce.customer-context commerce.source-counterparty-admission',
  'commerce.customer-context commerce.source-person-admission',
  'commerce.customer-context commerce.source-processing-eligibility',
  'integration.symmy symmy.customer-intake-privacy',
  'integration.symmy symmy.retention-privacy-current',
  'party.registry party.client-source-organization-privacy',
  'party.registry party.client-source-privacy',
  'party.registry party.legacy-ico-privacy',
  'privacy.core privacy.customer-intake-owner-context',
  'privacy.core privacy.organization-business-owner-context',
  'privacy.core privacy.organization-business-owner-facts',
  'privacy.core privacy.organization-ico-owner-facts',
  'privacy.core privacy.organization-party-record-facts',
  'privacy.core privacy.organization-profile-ico-owner-facts',
  'privacy.core privacy.organization-profile-owner-facts',
  'privacy.core privacy.organization-source-owner-facts',
  'privacy.core privacy.source-person-party-owner',
];

const REGISTRIES = [
  'verticals/commerce-customer-context/src/declared-evidence-calls.ts',
  'verticals/party-registry/src/declared-evidence-calls.ts',
  'verticals/privacy/src/declared-evidence-calls.ts',
  'verticals/symmy-integration/src/declared-evidence-calls.ts',
];
const COMBINATOR_HOMES = [
  'packages/core-runtime/src/db/transaction-io-guard.ts',
  'packages/core-runtime/src/index.ts',
  ...REGISTRIES,
];

const appRoot = new URL('../../', import.meta.url).pathname;
const skippedDirectories = new Set(['.git', 'dist', 'node_modules', 'tests', 'test', 'fixtures', '.modern', 'build']);
const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name) || entry.name.startsWith('.')
        ? []
        : sourceFiles(nodePath.join(directory, entry.name));
    }
    return /\.(?:c|m)?tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts')
      ? [nodePath.join(directory, entry.name)]
      : [];
  });
const read = (file: string) => readFileSync(nodePath.join(appRoot, file), 'utf-8');

it('pins every declared in-transaction evidence call', () => {
  const declared = REGISTRIES.flatMap((file) =>
    [...read(file).matchAll(/evidence: '([^']+)',\s*owner: '([^']+)'/gu)].map(
      ([, evidence, owner]) => `${owner} ${evidence}`,
    ),
  ).toSorted();
  expect(declared).toEqual(PINNED_DECLARATIONS);
});

it('declares evidence calls only through the owner registries', () => {
  const users = ['packages', 'verticals', 'apps']
    .flatMap((root) => sourceFiles(nodePath.join(appRoot, root)))
    .map((file) => nodePath.relative(appRoot, file))
    .filter((file) => read(file).includes('declaredEvidenceCallInsideTransaction'))
    .toSorted();
  expect(users).toEqual(COMBINATOR_HOMES.toSorted());
});
