import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceAuthorizationImpact } from '../report-fail-closed-authorization-impact.mts';

const inventoryHash = 'a'.repeat(64);
const sourceRevision = 'revision';
const observationStartedAt = '2026-09-03T00:00:00.000Z';
const observationEndedAt = '2026-09-04T00:00:00.000Z';
const prohibitedValuePattern = /malformed or contains prohibited/u;

interface EvidenceFixtureOverride {
  denialReason?: string;
  entrypointKey?: string;
  policyClass?: string;
  principalId?: string;
  sourceRevision?: string;
  tenantId?: string;
  timestamp?: string;
}

const event = (changed: EvidenceFixtureOverride = {}) => ({
  denialReason: 'missing_policy',
  entrypointKey: 'contacts.create-contact',
  inventoryHash,
  policyClass: 'action_execution',
  schemaVersion: 1,
  sourceRevision,
  surface: 'action',
  timestamp: observationStartedAt,
  type: 'authorization.would_deny',
  ...changed,
});

await test('impact reduction is deterministic and aggregates sanitized evidence', () => {
  const report = reduceAuthorizationImpact([
    event({ timestamp: observationEndedAt }),
    event(),
  ]);
  assert.equal(report.totalWouldDeny, 2);
  assert.equal(report.aggregates[0]?.count, 2);
  assert.deepEqual(report.observation, {
    endedAt: observationEndedAt,
    startedAt: observationStartedAt,
  });
});

await test('impact reduction rejects mixed build evidence and sensitive extra fields', () => {
  assert.throws(
    () =>
      reduceAuthorizationImpact([event(), event({ sourceRevision: 'other' })]),
    /mixes/u
  );
  assert.throws(
    () => reduceAuthorizationImpact([event({ principalId: 'secret' })]),
    /prohibited/u
  );
  assert.throws(
    () => reduceAuthorizationImpact([event({ tenantId: 'secret' })]),
    /prohibited/u
  );
});

await test('a bounded empty observation produces a zero-impact report', () => {
  const report = reduceAuthorizationImpact([], {
    endedAt: '2026-09-10T00:00:00.000Z',
    inventoryHash,
    sourceRevision,
    startedAt: observationStartedAt,
  });
  assert.equal(report.totalWouldDeny, 0);
  assert.deepEqual(report.aggregates, []);
});

await test('impact reduction rejects sensitive values smuggled into allowed evidence fields', () => {
  assert.throws(
    () =>
      reduceAuthorizationImpact([
        event({ entrypointKey: 'tenant@example.com' }),
      ]),
    prohibitedValuePattern
  );
  assert.throws(
    () =>
      reduceAuthorizationImpact([
        event({ denialReason: 'principal-a2000000' }),
      ]),
    prohibitedValuePattern
  );
  assert.throws(
    () =>
      reduceAuthorizationImpact([event({ policyClass: 'raw-relation-tuple' })]),
    prohibitedValuePattern
  );
});
