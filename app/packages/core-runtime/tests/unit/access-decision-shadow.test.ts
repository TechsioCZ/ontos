import { Effect, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { DECISION_REASON_CODES, decisionHttpStatus, decisionReason } from '../../src/access/decision/contract.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { witnessPurposeMode } from '../../src/access/model.ts';
import { explainAccess } from '../../src/access/decision/explain.ts';
import { compareShadowDecision, makeShadowComparator } from '../../src/access/decision/shadow.ts';
import type { ShadowObservation } from '../../src/access/decision/shadow.ts';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  GrantIncarnationIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
} from '../../src/access/ids.ts';
import { at, capability, otherPerson, person } from './access-decision-support.ts';

const now = at('2026-11-03T12:00:00Z');

/** JSON text of a value, so a mutation check compares the whole record. */
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decision = (
  outcome: AccessDecision['outcome'],
  reasons: AccessDecision['reasons'] = [decisionReason('allow.granted')],
): AccessDecision => ({ evidence: [], outcome, reasons, selectors: [] });

const observation = (overrides: Partial<ShadowObservation> = {}): ShadowObservation => ({
  actorId: person,
  candidate: decision('ALLOWED'),
  entrypointKey: 'finance.invoice.void',
  legacy: 'allowed',
  now,
  observationId: 'observation-1',
  ...overrides,
});

it('keeps the reason vocabulary lowercase and stable', () => {
  for (const code of DECISION_REASON_CODES) {
    expect(code).toMatch(/^[a-z][a-z0-9_.]*$/u);
  }
  expect(new Set(DECISION_REASON_CODES).size).toBe(DECISION_REASON_CODES.length);
  expect(decisionHttpStatus('ALLOWED')).toBe(200);
  expect(decisionHttpStatus('NEEDS_APPROVAL')).toBe(403);
  expect(decisionHttpStatus('DENIED')).toBe(403);
  expect(decisionHttpStatus('UNAVAILABLE')).toBe(503);
});

it('records agreement without inventing a direction', () => {
  const agreed = compareShadowDecision(observation());
  expect(agreed.status).toBe('agree');
  expect(agreed.direction).toBeUndefined();
  expect(agreed.reasonCodes).toEqual(['allow.granted']);

  const bothDenied = compareShadowDecision(observation({ candidate: decision('DENIED'), legacy: 'denied' }));
  expect(bothDenied.status).toBe('agree');
  const needsApproval = compareShadowDecision(
    observation({ candidate: decision('NEEDS_APPROVAL', [decisionReason('approval.required')]), legacy: 'denied' }),
  );
  expect(needsApproval.status).toBe('agree');
});

it('treats an unavailable v2 answer as inconclusive, never as a mismatch or a deny', () => {
  const comparison = compareShadowDecision(
    observation({ candidate: decision('UNAVAILABLE', [decisionReason('unavailable.engine')]), legacy: 'allowed' }),
  );
  expect(comparison.status).toBe('inconclusive');
  expect(comparison.direction).toBeUndefined();
  expect(comparison.reasonCodes).toEqual(['unavailable.engine']);
});

it('records both mismatch directions and attributes known legacy quirks', () => {
  const narrower = compareShadowDecision(
    observation({ candidate: decision('DENIED'), capabilityKey: capability('finance.invoice.void') }),
  );
  expect(narrower.status).toBe('mismatch');
  expect(narrower.direction).toBe('v2_narrower');
  expect(narrower.capabilityKey).toBe(capability('finance.invoice.void'));

  const wider = compareShadowDecision(
    observation({ candidate: decision('ALLOWED'), legacy: 'denied', legacyReason: 'missing_policy' }),
  );
  expect(wider.status).toBe('mismatch');
  expect(wider.direction).toBe('v2_wider');
  expect(wider.legacyReason).toBe('missing_policy');

  const quirk = compareShadowDecision(
    observation({
      candidate: decision('DENIED'),
      recordedQuirks: ['action_restriction_subject_type_mismatch'],
    }),
  );
  expect(quirk.status).toBe('legacy_quirk');
  expect(quirk.quirks).toEqual(['action_restriction_subject_type_mismatch']);
  expect(quirk.direction).toBe('v2_narrower');
});

it.effect('records at most one comparison per observation and never mutates the candidate', () =>
  Effect.gen(function* recordsShadowComparisons() {
    const recorded = yield* Ref.make<readonly string[]>([]);
    const comparator = makeShadowComparator({
      record: (comparison) => Ref.update(recorded, (current) => [...current, comparison.status]).pipe(Effect.asVoid),
    });
    const candidate = decision('DENIED');
    const before = jsonText(candidate);
    const comparison = yield* comparator.compareAndRecord(observation({ candidate }));
    expect(comparison.status).toBe('mismatch');
    expect(yield* Ref.get(recorded)).toEqual(['mismatch']);
    expect(jsonText(candidate)).toBe(before);
  }),
);

it('explains allowed and denied authority as structured codes for Proč?', () => {
  const allowed: AccessDecision = {
    admissionDeadline: at('2026-12-01T00:00:00Z'),
    evidence: [
      {
        assignedAt: at('2026-10-01T00:00:00Z'),
        assignedBy: otherPerson,
        deadline: at('2026-12-01T00:00:00Z'),
        mode: 'run',
        roleId: RoleIdSchema.make('00000000-0000-4000-8000-000000000050'),
        roleRevisionId: RoleRevisionIdSchema.make('00000000-0000-4000-8000-000000000051'),
        selector: 'all',
        side: 'principal',
        witness: {
          assignmentIncarnationId: AssignmentIncarnationIdSchema.make('00000000-0000-4000-8000-000000000052'),
          capabilityKey: capability('finance.invoice.void'),
          grantIncarnationId: GrantIncarnationIdSchema.make('00000000-0000-4000-8000-000000000053'),
          holderId: { _tag: 'Principal', principalId: otherPerson },
          mode: witnessPurposeMode('requester'),
          purpose: 'requester',
          scopeId: AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000054'),
        },
      },
    ],
    outcome: 'ALLOWED',
    reasons: [decisionReason('allow.granted')],
    selectors: [{ selector: 'all', side: 'principal' }],
  };
  const explanation = explainAccess({
    decision: allowed,
    grantableBy: [otherPerson],
    policy: {
      capabilityKey: capability('finance.invoice.void'),
      kind: 'action',
      modes: ['run'],
      risk: 'routine',
      selectors: [],
    },
  });
  expect(explanation.outcome).toBe('ALLOWED');
  expect(explanation.requestable).toBe(false);
  expect(explanation.reasonCodes).toEqual(['allow.granted']);
  expect(explanation.admissionDeadline).toEqual(at('2026-12-01T00:00:00Z'));
  expect(explanation.authority.length).toBe(1);

  const denied = explainAccess({
    decision: decision('DENIED', [decisionReason('deny.insufficient_grant')]),
    policy: {
      capabilityKey: capability('finance.invoice.void'),
      fieldClass: 'margins',
      kind: 'field_read',
      modes: ['run'],
      risk: 'sensitive',
      selectors: [],
    },
  });
  expect(denied.requestable).toBe(true);
  expect(denied.reasonCodes).toEqual(['deny.insufficient_grant']);
  expect(denied.fieldClass).toBe('margins');
  expect(denied.authority).toEqual([]);
});
