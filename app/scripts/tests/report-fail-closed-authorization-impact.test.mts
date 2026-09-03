import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceAuthorizationImpact } from '../report-fail-closed-authorization-impact.mts';

const event = (changed: Record<string, unknown> = {}) => ({
  denialReason: 'missing_policy',
  entrypointKey: 'contacts.create-contact',
  inventoryHash: 'a'.repeat(64),
  policyClass: 'action_execution',
  schemaVersion: 1,
  sourceRevision: 'revision',
  surface: 'action',
  timestamp: '2026-09-03T00:00:00.000Z',
  type: 'authorization.would_deny',
  ...changed,
});

test('impact reduction is deterministic and aggregates sanitized evidence', () => {
  const report = reduceAuthorizationImpact([
    event({ timestamp: '2026-09-04T00:00:00.000Z' }),
    event(),
  ]);
  assert.equal(report.totalWouldDeny, 2);
  assert.equal(report.aggregates[0]?.count, 2);
  assert.deepEqual(report.observation, {
    endedAt: '2026-09-04T00:00:00.000Z',
    startedAt: '2026-09-03T00:00:00.000Z',
  });
});

test('impact reduction rejects mixed build evidence and sensitive extra fields', () => {
  assert.throws(
    () => reduceAuthorizationImpact([event(), event({ sourceRevision: 'other' })]),
    /mixes/u,
  );
  assert.throws(() => reduceAuthorizationImpact([event({ principalId: 'secret' })]), /prohibited/u);
  assert.throws(() => reduceAuthorizationImpact([event({ tenantId: 'secret' })]), /prohibited/u);
});

test('a bounded empty observation produces a zero-impact report', () => {
  const report = reduceAuthorizationImpact([], {
    endedAt: '2026-09-10T00:00:00.000Z',
    inventoryHash: 'a'.repeat(64),
    sourceRevision: 'revision',
    startedAt: '2026-09-03T00:00:00.000Z',
  });
  assert.equal(report.totalWouldDeny, 0);
  assert.deepEqual(report.aggregates, []);
});

test('impact reduction rejects sensitive values smuggled into allowed evidence fields', () => {
  assert.throws(
    () => reduceAuthorizationImpact([event({ entrypointKey: 'tenant@example.com' })]),
    /malformed or contains prohibited/u,
  );
  assert.throws(
    () => reduceAuthorizationImpact([event({ denialReason: 'principal-a2000000' })]),
    /malformed or contains prohibited/u,
  );
  assert.throws(
    () => reduceAuthorizationImpact([event({ policyClass: 'raw-relation-tuple' })]),
    /malformed or contains prohibited/u,
  );
});
