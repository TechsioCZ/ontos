import { readFileSync } from 'node:fs';

import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  RETIRED_STAGE_SERVICE_GRANT_REMEDIATION,
  ServiceGrantError,
  refuseRetiredStageServiceGrants,
} from '../demo/reconcile-stage-service-grants.mts';

const source = readFileSync(new URL('../demo/reconcile-stage-service-grants.mts', import.meta.url), 'utf-8');

it.effect('refuses the retired legacy stage role policy with the canonical remediation', () =>
  Effect.gen(function* refusesRetiredPolicy() {
    const error = yield* refuseRetiredStageServiceGrants('apply').pipe(Effect.flip);
    expect(Schema.is(ServiceGrantError)(error)).toBe(true);
    expect(error.reason).toContain('cannot be reconciled');
    expect(error.reason).toContain(RETIRED_STAGE_SERVICE_GRANT_REMEDIATION);
    expect(error.reason).toContain('canonical Roles and Assignments');
  }),
);

it('has no legacy relationship write path left', () => {
  // The canonical schema reconcile writes a schema, never relationships; the grant reconcile is read-only.
  expect(source).not.toContain('RelationshipUpdate_Operation');
  expect(source).not.toContain('writeRelationships(');
  expect(source).toContain('reconcileStagePermissionSchema');
});

it('keeps the release host free of a guaranteed-to-fail legacy grant child', () => {
  const host = readFileSync(new URL('../zerops/app-host.mts', import.meta.url), 'utf-8');
  // The retired reconciliation always refuses, so the deploy host must not run it: a release that is already
  // serving must never depend on a step that can only fail. The live seed is operator-gated instead.
  expect(host).not.toContain('reconcile-stage-service-grants.mts');
  expect(host).not.toContain('n1-release-grants.mts');
  // The release proves the projected access read-only before it publishes.
  expect(host).toContain('verifyReleaseAccessIntent');
});

it('reads only the reviewed service policy, never a broad all-actions grant', () => {
  // No legacy scope/grant fallback survives: the retired desired sets are gone with the policy.
  expect(source).not.toContain('read_all');
  expect(source).not.toContain('write_all');
  expect(source).not.toContain('principalRelationships');
});
