import { DateTime, Option, Result } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
import { decideCommunication } from '../../src/domain/catalog/decision.ts';
import { buildMessageTypeRegistry } from '../../src/domain/catalog/registry.ts';
import { sourceCurrentnessOf } from '../../src/handoff/process-intent-handoff.ts';
import { fixtureContext, fixtureRequest, recipient } from './support/catalog-fixtures.ts';
import { outcomeSummary } from './support/summaries.ts';

/**
 * #1406 against the PRODUCTION registry: only Portal Auth may request a Portal Auth purpose, and each Auth lifecycle state that
 * ends an issuance is its OWN closed reason in the history (not one generic "ineligible").
 */

const NOW = DateTime.makeUnsafe('2026-11-19T10:00:00.000Z');
const registry = Result.getOrThrow(buildMessageTypeRegistry(approvedMessageTypes));
const AUTH = 'commerce.customer-context';
const STATE = 'commerce.customer-context.portal-auth.issuance';
const PURPOSES = approvedMessageTypes.filter(({ sourceOwner }) => sourceOwner === AUTH).map(({ purpose }) => purpose);
const STOPS = [
  ['consumed', 'SOURCE_CONSUMED'],
  ['expired', 'SOURCE_EXPIRED'],
  ['not-resumable', 'SOURCE_NOT_RESUMABLE'],
  ['revoked', 'SOURCE_REVOKED'],
  ['superseded', 'SOURCE_SUPERSEDED'],
] as const;

describe('The three Portal Auth types in the production registry (#1406)', () => {
  it('are exactly three', () => {
    expect(PURPOSES).toHaveLength(3);
  });

  for (const purpose of PURPOSES) {
    it(`[${purpose}] a FOREIGN source module is refused with SOURCE_NOT_AUTHORIZED_FOR_TYPE`, () => {
      const decision = Result.getOrThrow(
        decideCommunication(
          registry,
          fixtureRequest({ moduleKey: 'fixture.foreign-source', purpose }),
          fixtureContext([recipient('account-holder', 'contact-1')], { state: `${STATE}-current` }),
        ),
      );
      expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason: 'SOURCE_NOT_AUTHORIZED_FOR_TYPE' });
    });

    for (const [name, reason] of STOPS) {
      it(`[${purpose}] the ${name} state stops with its own closed reason ${reason}, at the decision and at the handoff`, () => {
        const decision = Result.getOrThrow(
          decideCommunication(
            registry,
            fixtureRequest({ moduleKey: AUTH, purpose }),
            fixtureContext([recipient('account-holder', 'contact-1')], { state: `${STATE}-${name}` }),
          ),
        );
        expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason });
        const type = Option.getOrThrow(Option.fromNullishOr(registry.byPurpose.get(purpose as never)));
        expect(
          sourceCurrentnessOf(type, 1, { latestRevision: 1, state: `${STATE}-${name}` }, Option.none(), NOW),
        ).toMatchObject({ reason });
      });
    }

    it(`[${purpose}] an unknown Auth state stays the generic SOURCE_STATE_INELIGIBLE`, () => {
      const decision = Result.getOrThrow(
        decideCommunication(
          registry,
          fixtureRequest({ moduleKey: AUTH, purpose }),
          fixtureContext([recipient('account-holder', 'contact-1')], { state: `${STATE}-something-else` }),
        ),
      );
      expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason: 'SOURCE_STATE_INELIGIBLE' });
    });
  }
});
