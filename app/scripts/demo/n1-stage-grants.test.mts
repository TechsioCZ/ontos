import { readFileSync } from 'node:fs';

import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  N1_LEGAL_ENTITY_ID,
  N1_TENANT_ID,
  RETIRED_N1_GRANT_REMEDIATION,
  N1StageGrantError,
  decodeN1Access,
  n1ManifestSources,
  refuseRetiredN1Grants,
} from './n1-stage-grants.mts';

const accessFile = 'n1-stage-access.json';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf-8');

it.effect('the committed N1 identities decode to the stage tenant and both N1 accounts', () =>
  Effect.gen(function* committedAccess() {
    const access = yield* decodeN1Access(read(accessFile));
    expect(access.tenantId).toBe(N1_TENANT_ID);
    expect(access.legalEntityId).toBe(N1_LEGAL_ENTITY_ID);
    expect(access.accounts.map(({ email }) => email)).toEqual(['admin@n1.ontos.demo', 'catalog@n1.ontos.demo']);
  }),
);

it.effect('refuses an access file that reuses the tenant, company or the portal principal', () =>
  Effect.gen(function* refusesReservedIdentity() {
    const committed = yield* decodeN1Access(read(accessFile));
    const tampered = JSON.stringify({
      ...committed,
      accounts: committed.accounts.map((account, index) =>
        index === 0 ? { ...account, principalId: N1_TENANT_ID } : account,
      ),
    });
    const error = yield* decodeN1Access(tampered).pipe(Effect.flip);
    expect(error.reason).toContain('distinct, new');
  }),
);

it.effect('refuses the retired legacy N1 plan with the canonical remediation', () =>
  Effect.gen(function* refusesRetiredPlan() {
    const error = yield* refuseRetiredN1Grants('apply').pipe(Effect.flip);
    expect(Schema.is(N1StageGrantError)(error)).toBe(true);
    expect(error.reason).toContain(RETIRED_N1_GRANT_REMEDIATION);
    expect(error.reason).toContain('canonical Roles, Assignments and workload bindings');
  }),
);

it('keeps exactly the reviewed six owner modules as the N1 slice', () => {
  expect(n1ManifestSources.map(({ moduleId }) => moduleId)).toEqual([
    'demo.merchandise',
    'commerce.market-catalog',
    'commerce.storefront-registry',
    'work.tasks',
    'commerce.customer-context',
    'party.registry',
  ]);
});

it('has no legacy relationship write or revoke path left', () => {
  const source = read('n1-stage-grants.mts');
  expect(source).not.toContain('RelationshipUpdate_Operation');
  expect(source).not.toContain('writeRelationships');
  expect(source).not.toContain('revokeRetiredN1Relationships');
  // Assembled so this guard file is never itself a match for the retired core installer's name.
  expect(source).not.toContain(['reconcileStage', 'ServicePrincipals'].join(''));
});

it('the release host runs no legacy grant child, and proves the projected access instead', () => {
  const host = read('../zerops/app-host.mts');
  // Both retired children refuse unconditionally, so a release that is already serving must not run them.
  expect(host).not.toContain('reconcile-stage-service-grants.mts');
  expect(host).not.toContain('n1-release-grants.mts');
  // The release proves every active Tenant's canonical access read-only before it publishes.
  const verify = host.indexOf('verifyReleaseAccessIntent(releaseSnapshot)');
  const publish = host.indexOf('publishSnapshot(releaseSnapshot)');
  expect(verify).toBeGreaterThan(-1);
  expect(publish).toBeGreaterThan(verify);
});
