import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

import { N1_RELEASE_ACCESS_FILE } from './n1-release-grants.mts';
import { RETIRED_N1_GRANT_REMEDIATION } from './n1-stage-grants.mts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf-8');
const source = read('n1-release-grants.mts');
/** Assembled so this guard file is never itself a match for the retired module name. */
const RETIRED_PROVISIONING_MODULE = ['provision-current', 'action-authorization'].join('-');

it('reads the reviewed N1 access file and never imports the retired provisioning CLI', () => {
  expect(N1_RELEASE_ACCESS_FILE).toBe('scripts/demo/n1-stage-access.json');
  expect(source).toContain('N1_RELEASE_ACCESS_FILE');
  expect(source).not.toContain(RETIRED_PROVISIONING_MODULE);
  expect(source).not.toContain('discoverCurrentActions');
});

it('writes and revokes nothing: the retired N1 plan is refused with its remediation', () => {
  expect(source).toContain('refuseRetiredN1Grants');
  expect(source).not.toContain('reconcileServiceGrants');
  expect(source).not.toContain('RelationshipUpdate_Operation');
  expect(source).not.toContain('writeRelationships');
  expect(RETIRED_N1_GRANT_REMEDIATION).toContain('canonical Roles, Assignments and workload bindings');
});

it('the release host runs no retired N1 grant child, and proves the projected access instead', () => {
  const host = read('../zerops/app-host.mts');
  // The retired N1 child refuses unconditionally, so a release that is already serving must not run it.
  expect(host).not.toContain('n1-release-grants.mts');
  expect(host).not.toContain('reconcile-stage-service-grants.mts');
  const verify = host.indexOf('verifyReleaseAccessIntent(releaseSnapshot)');
  const publish = host.indexOf('publishSnapshot(releaseSnapshot)');
  expect(verify).toBeGreaterThan(-1);
  expect(publish).toBeGreaterThan(verify);
});
