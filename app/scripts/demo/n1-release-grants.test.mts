import { readFileSync } from 'node:fs';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { decodeN1Access, N1_LEGAL_ENTITY_ID, N1_TENANT_ID } from './n1-stage-grants.mts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

it.effect('the committed N1 identities decode to the stage tenant and both N1 accounts', () =>
  Effect.gen(function* committedAccess() {
    const access = yield* decodeN1Access(read('n1-stage-access.json'));
    expect(access.tenantId).toBe(N1_TENANT_ID);
    expect(access.legalEntityId).toBe(N1_LEGAL_ENTITY_ID);
    expect(access.accounts.map(({ email }) => email)).toEqual(['admin@n1.ontos.demo', 'catalog@n1.ontos.demo']);
  }),
);

it('the release reconcile only adds the reviewed N1 set and has no revoke path', () => {
  const source = read('n1-release-grants.mts');
  expect(source).toContain("reconcileServiceGrants(rpc, relationships, 'apply')");
  expect(source).not.toContain('loadN1Contracts');
  expect(source).not.toContain('RelationshipUpdate_Operation.DELETE');
  expect(source).not.toContain('revokeRetiredN1Relationships');
});

it('app-host runs the N1 release grants right after the demo service grants', () => {
  const host = read('../zerops/app-host.mts');
  const demo = host.indexOf("'service-grants'");
  const n1 = host.indexOf("'n1-service-grants'");
  expect(demo).toBeGreaterThan(-1);
  expect(n1).toBeGreaterThan(demo);
  expect(host).toContain("['scripts/demo/n1-release-grants.mts']");
});
