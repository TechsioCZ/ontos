import { expect, it } from 'effect-rstest';

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

it('impact reduction is deterministic and aggregates sanitized evidence', () => {
  const report = reduceAuthorizationImpact([event({ timestamp: observationEndedAt }), event()]);
  expect(report.totalWouldDeny).toBe(2);
  expect(report.aggregates[0]?.count).toBe(2);
  expect(report.observation).toEqual({
    endedAt: observationEndedAt,
    startedAt: observationStartedAt,
  });
});

it('impact reduction rejects mixed build evidence and sensitive extra fields', () => {
  expect(() => reduceAuthorizationImpact([event(), event({ sourceRevision: 'other' })])).toThrow(
    /mixes/u,
  );
  expect(() => reduceAuthorizationImpact([event({ principalId: 'secret' })])).toThrow(
    /prohibited/u,
  );
  expect(() => reduceAuthorizationImpact([event({ tenantId: 'secret' })])).toThrow(/prohibited/u);
});

it('a bounded empty observation produces a zero-impact report', () => {
  const report = reduceAuthorizationImpact([], {
    endedAt: '2026-09-10T00:00:00.000Z',
    inventoryHash,
    sourceRevision,
    startedAt: observationStartedAt,
  });
  expect(report.totalWouldDeny).toBe(0);
  expect(report.aggregates).toEqual([]);
});

it('impact reduction rejects sensitive values smuggled into allowed evidence fields', () => {
  expect(() => reduceAuthorizationImpact([event({ entrypointKey: 'tenant@example.com' })])).toThrow(
    prohibitedValuePattern,
  );
  expect(() => reduceAuthorizationImpact([event({ denialReason: 'principal-a2000000' })])).toThrow(
    prohibitedValuePattern,
  );
  expect(() => reduceAuthorizationImpact([event({ policyClass: 'raw-relation-tuple' })])).toThrow(
    prohibitedValuePattern,
  );
});
