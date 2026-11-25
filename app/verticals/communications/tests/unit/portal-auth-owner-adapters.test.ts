import { PortalAuthIssuanceSourceStateSchema } from '@app/commerce-customer-context/api/portal-auth-issuance-source';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Duration, Effect, Fiber, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationDecisionRequestSchema } from '../../src/domain/catalog/decision-request.ts';
import { endpointMaskIsSafe, OriginalContactBindingSchema } from '../../src/domain/recipient/original-binding.ts';
import {
  CommunicationPurposeKeySchema,
  MessageTypeIdSchema,
  RecipientRoleSchema,
  CommunicationResourceRefSchema,
} from '../../src/domain/catalog/vocabulary.ts';
import { RecipientGateVerdict } from '../../src/domain/recipient/current-gate.ts';
import type { RecipientGateQuery } from '../../src/domain/recipient/current-gate.ts';
import {
  PORTAL_AUTH_ISSUANCE_STATE_CURRENT,
  portalAuthRecipientCurrentGateOver,
  portalAuthSourceOccurrenceAuthorityOver,
} from '../../src/integrations/portal-auth-owner.ts';
import type { PortalAuthOwnerTransport } from '../../src/integrations/portal-auth-owner.ts';
import { actionOwnerCall, underOwnerCall } from '../../src/integrations/owner-call.ts';
import { FIXTURE_TENANT_ID } from './support/catalog-fixtures.ts';
import { fixtureScope } from './support/recipient-fixtures.ts';

/**
 * #1394 BR-05, #1395 BR-03, #1401 I-07: the live owner adapters of the Portal Auth types ask Auth's PUBLISHED Read, with the
 * authority of the operation in progress, and read only its published answer. The transport here is SCRIPTED (it proves how the
 * adapters ask, read and fail closed, not that Auth answers so; Auth's own answer is proven in its Read suite). Every value is
 * FICTIONAL.
 */

const AUTH = 'commerce.customer-context';
const PURPOSE = 'commerce.customer-context.portal-auth.verify-email';
const STATE = {
  consumed: `${AUTH}.portal-auth.issuance-consumed`,
  current: `${AUTH}.portal-auth.issuance-current`,
  expired: `${AUTH}.portal-auth.issuance-expired`,
  notResumable: `${AUTH}.portal-auth.issuance-not-resumable`,
  revoked: `${AUTH}.portal-auth.issuance-revoked`,
  superseded: `${AUTH}.portal-auth.issuance-superseded`,
} as const;
const SETTINGS = { checkTimeout: '5 seconds' } as const;

const decodeRequest = Schema.decodeUnknownSync(CommunicationDecisionRequestSchema);
const decodeRef = Schema.decodeUnknownSync(CommunicationResourceRefSchema);
const decodeContact = Schema.decodeUnknownSync(OriginalContactBindingSchema);

const sourceRequest = (overrides: { readonly moduleKey?: string; readonly occurrenceId?: string } = {}) =>
  decodeRequest({
    occurrence: { occurrenceId: overrides.occurrenceId ?? 'pa-1', revision: 1 },
    purpose: PURPOSE,
    source: { moduleKey: overrides.moduleKey ?? AUTH },
    tenantId: FIXTURE_TENANT_ID,
  });

const evidenceOf = (
  kind: 'AUTHORITATIVE_REFERENCE' | 'HISTORICAL_SNAPSHOT' | 'VERSIONED_SNAPSHOT',
  issuance: string,
) => {
  if (kind === 'HISTORICAL_SNAPSHOT') {
    return {
      kind,
      snapshotRef: { moduleId: AUTH, resourceId: issuance, resourceType: `${AUTH}.portal-auth-issuance` },
    };
  }
  return kind === 'VERSIONED_SNAPSHOT' ? { contactRevision: 1, kind } : { kind };
};

const gateQuery = (
  overrides: {
    readonly contactModule?: string;
    readonly evidence?: 'AUTHORITATIVE_REFERENCE' | 'HISTORICAL_SNAPSHOT' | 'VERSIONED_SNAPSHOT';
    readonly issuance?: string;
    readonly subject?: string;
  } = {},
): RecipientGateQuery => {
  const issuance = overrides.issuance ?? 'pa-1';
  const evidenceKind = overrides.evidence ?? 'HISTORICAL_SNAPSHOT';
  const evidence = evidenceOf(evidenceKind, issuance);
  return {
    contact: decodeContact({
      contactRef: {
        moduleId: overrides.contactModule ?? AUTH,
        resourceId: issuance,
        resourceType: `${AUTH}.portal-auth-endpoint`,
      },
      evidence,
    }),
    occurrence: sourceRequest({ occurrenceId: issuance }).occurrence,
    purpose: CommunicationPurposeKeySchema.make(PURPOSE),
    recipient: {
      recipientRef: decodeRef({
        moduleId: AUTH,
        resourceId: overrides.subject ?? 'subject-1',
        resourceType: `${AUTH}.portal-auth-account`,
      }),
      role: RecipientRoleSchema.make('account-holder'),
    },
    scope: fixtureScope(),
    sourceModule: sourceRequest().source.moduleKey,
    typeId: MessageTypeIdSchema.make(`${AUTH}.portal-auth.verify-email-message`),
  };
};

const call = actionOwnerCall({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '30000000-0000-4000-8000-000000000004',
    authContextRef: 'fixture:portal-auth-owner',
    authenticationNamespaceId: 'core.staff',
    authMethod: 'session',
    principalId: '30000000-0000-4000-8000-000000000003',
    tenantId: FIXTURE_TENANT_ID,
  }),
  correlationId: 'fixture:portal-auth-owner',
});

/** A scripted transport that records every question and the authority it was asked under. */
type Question = Parameters<PortalAuthOwnerTransport>[0];

const scripted = (answer: (question: Question, callNumber: number) => Effect.Effect<unknown, Error>) => {
  const asked: { readonly correlation: string; readonly question: Question }[] = [];
  const transport: PortalAuthOwnerTransport = (question, ownerCall) =>
    Effect.suspend(() => {
      asked.push({ correlation: ownerCall.correlation(), question });
      return answer(question, asked.length);
    });
  return { asked, transport };
};

const ENDPOINTS = {
  CURRENT: { kind: 'CURRENT', mask: 'h***@example.test' },
  NOT_CURRENT: { kind: 'NOT_CURRENT' },
} as const;

const facts = (state: string, endpoint?: keyof typeof ENDPOINTS, issuanceRef = 'pa-1') => {
  const stated = { issuanceRef, kind: 'FACTS', latestRevision: 1, state };
  return endpoint === undefined ? stated : { ...stated, originalEndpoint: ENDPOINTS[endpoint] };
};

const readSource = (transport: PortalAuthOwnerTransport, request = sourceRequest()) =>
  portalAuthSourceOccurrenceAuthorityOver(SETTINGS, transport).read(request).pipe(underOwnerCall(call));
const checkGate = (transport: PortalAuthOwnerTransport, query = gateQuery()) =>
  portalAuthRecipientCurrentGateOver(SETTINGS, transport).check(query).pipe(underOwnerCall(call));

describe('The names the adapters share with Auth', () => {
  it('equal the closed states Auth publishes, so a renamed state fails here and not silently in production', () => {
    expect(PortalAuthIssuanceSourceStateSchema.literals).toContain(PORTAL_AUTH_ISSUANCE_STATE_CURRENT);
    expect(PortalAuthIssuanceSourceStateSchema.literals.toSorted()).toEqual(Object.values(STATE).toSorted());
  });
});

describe('The Portal Auth source occurrence authority (#1394 BR-05, #1401 I-07)', () => {
  it.effect(
    'states the Current occurrence from the issuance state Auth published, asking only about the issuance',
    () =>
      Effect.gen(function* currentOccurrence() {
        const { asked, transport } = scripted(() => Effect.succeed(facts(STATE.current)));
        const stated = yield* readSource(transport);
        expect(stated).toEqual({
          latestRevision: 1,
          occurrenceId: 'pa-1',
          state: STATE.current,
          tenantId: FIXTURE_TENANT_ID,
        });
        // the question names the issuance only: no account, no address, no token
        expect(asked).toEqual([{ correlation: 'fixture:portal-auth-owner', question: { issuanceRef: 'pa-1' } }]);
      }),
  );

  it.effect('reports every non-Current state as the state Auth names, never as Current', () =>
    Effect.gen(function* everyState() {
      for (const state of [STATE.consumed, STATE.expired, STATE.notResumable, STATE.revoked, STATE.superseded]) {
        const { transport } = scripted(() => Effect.succeed(facts(state)));
        expect((yield* readSource(transport)).state).toBe(state);
      }
    }),
  );

  it.effect('asks Auth again on every read: nothing is remembered between two reads', () =>
    Effect.gen(function* askedAgain() {
      let state: string = STATE.current;
      const { asked, transport } = scripted(() => Effect.succeed(facts(state)));
      expect((yield* readSource(transport)).state).toBe(STATE.current);
      state = STATE.revoked;
      expect((yield* readSource(transport)).state).toBe(STATE.revoked);
      expect(asked).toHaveLength(2);
    }),
  );

  it.effect('an outage, a refusal, an invalid answer or no authority is an unavailable owner, never a state', () =>
    Effect.gen(function* failsClosed() {
      const failing = scripted(() => Effect.fail(new Error('owner down')));
      expect(yield* Effect.flip(readSource(failing.transport))).toMatchObject({ reason: 'OWNER_UNAVAILABLE' });
      const invalid = scripted(() => Effect.succeed({ kind: 'FACTS', state: 'whatever' }));
      expect(yield* Effect.flip(readSource(invalid.transport))).toMatchObject({ reason: 'OWNER_UNAVAILABLE' });
      // an answer with an extra field (an address) is refused, not read
      const widened = scripted(() => Effect.succeed({ ...facts(STATE.current), address: 'holder@example.test' }));
      expect(yield* Effect.flip(readSource(widened.transport))).toMatchObject({ reason: 'OWNER_UNAVAILABLE' });
      // no authority of an operation in progress means nothing is asked
      const unasked = scripted(() => Effect.succeed(facts(STATE.current)));
      const noCall = yield* Effect.flip(
        portalAuthSourceOccurrenceAuthorityOver(SETTINGS, unasked.transport).read(sourceRequest()),
      );
      expect(noCall).toMatchObject({ reason: 'OWNER_UNAVAILABLE' });
      expect(unasked.asked).toHaveLength(0);
    }),
  );

  it.effect(
    'an owner that answers nothing about the occurrence, or for another issuance, is an unknown occurrence',
    () =>
      Effect.gen(function* unknown() {
        const nothing = scripted(() => Effect.succeed({ kind: 'NO_FACTS' }));
        expect(yield* Effect.flip(readSource(nothing.transport))).toMatchObject({ reason: 'OCCURRENCE_UNKNOWN' });
        const other = scripted(() => Effect.succeed(facts(STATE.current, undefined, 'pa-other')));
        expect(yield* Effect.flip(readSource(other.transport))).toMatchObject({ reason: 'OCCURRENCE_UNKNOWN' });
        // an occurrence that cannot be an Auth issuance is never put to Auth
        const unaskable = scripted(() => Effect.succeed(facts(STATE.current)));
        expect(
          yield* Effect.flip(readSource(unaskable.transport, sourceRequest({ occurrenceId: 'a'.repeat(150) }))),
        ).toMatchObject({ reason: 'OCCURRENCE_UNKNOWN' });
        expect(unaskable.asked).toHaveLength(0);
      }),
  );

  it.effect('a source module other than Portal Auth has no adapter: an unavailable owner, nothing asked', () =>
    Effect.gen(function* otherSource() {
      const { asked, transport } = scripted(() => Effect.succeed(facts(STATE.current)));
      expect(yield* Effect.flip(readSource(transport, sourceRequest({ moduleKey: 'fixture.source' })))).toMatchObject({
        reason: 'OWNER_UNAVAILABLE',
      });
      expect(asked).toHaveLength(0);
    }),
  );

  it.effect('an owner past the deadline is an unavailable owner', () =>
    Effect.gen(function* slowOwner() {
      const { transport } = scripted(() => Effect.never);
      const fiber = yield* Effect.forkChild(Effect.flip(readSource(transport)));
      yield* TestClock.adjust(Duration.seconds(6));
      expect(yield* Fiber.join(fiber)).toMatchObject({ reason: 'OWNER_UNAVAILABLE' });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe('The Portal Auth recipient Current gate (#1395 BR-03)', () => {
  it.effect('a Current issuance and original endpoint is usable with only its mask, never an address', () =>
    Effect.gen(function* usableEndpoint() {
      const { asked, transport } = scripted(() => Effect.succeed(facts(STATE.current, 'CURRENT')));
      const verdict = yield* checkGate(transport);
      expect(RecipientGateVerdict.$is('Usable')(verdict)).toBe(true);
      if (RecipientGateVerdict.$is('Usable')(verdict)) {
        const { endpoint } = verdict;
        expect(endpoint.mask).toBe('h***@example.test');
        expect(endpoint.channel).toBe('email');
        // the address is never disclosed over the Read, so the protected value is empty and the mask hides nothing it names
        expect(Redacted.value(endpoint.value)).toBe('');
        expect(endpointMaskIsSafe(endpoint)).toBe(true);
        // the owner echoes the original contact and the snapshot it resolved
        expect(endpoint.contactRef.resourceId).toBe('pa-1');
        expect(endpoint.snapshotRef?.resourceId).toBe('pa-1');
      }
      // the question names the issuance and the account it is addressed to, nothing else
      expect(asked.map(({ question }) => question)).toEqual([{ issuanceRef: 'pa-1', recipientSubjectId: 'subject-1' }]);
    }),
  );

  it.effect(
    'every non-Current state, a non-Current endpoint and another account are unusable, each for its own reason',
    () =>
      Effect.gen(function* unusable() {
        for (const state of [STATE.consumed, STATE.expired, STATE.notResumable, STATE.revoked, STATE.superseded]) {
          const { transport } = scripted(() => Effect.succeed(facts(state, 'NOT_CURRENT')));
          expect(yield* checkGate(transport)).toEqual(
            RecipientGateVerdict.Unusable({ reason: 'SOURCE_NO_LONGER_VALID' }),
          );
        }
        const moved = scripted(() => Effect.succeed(facts(STATE.current, 'NOT_CURRENT')));
        expect(yield* checkGate(moved.transport)).toEqual(
          RecipientGateVerdict.Unusable({ reason: 'ORIGINAL_ENDPOINT_UNUSABLE' }),
        );
        const bare = scripted(() => Effect.succeed(facts(STATE.current)));
        expect(yield* checkGate(bare.transport)).toEqual(
          RecipientGateVerdict.Unusable({ reason: 'ORIGINAL_ENDPOINT_UNUSABLE' }),
        );
        const anotherAccount = scripted(() => Effect.succeed({ kind: 'NO_FACTS' }));
        expect(yield* checkGate(anotherAccount.transport, gateQuery({ subject: 'subject-2' }))).toEqual(
          RecipientGateVerdict.Unusable({ reason: 'SOURCE_NO_LONGER_VALID' }),
        );
      }),
  );

  it.effect('asks Auth again on every check, so a revocation after a Usable answer stops the next one', () =>
    Effect.gen(function* askedAgain() {
      const { asked, transport } = scripted((_question, callNumber) =>
        Effect.succeed(callNumber === 1 ? facts(STATE.current, 'CURRENT') : facts(STATE.revoked, 'NOT_CURRENT')),
      );
      expect(RecipientGateVerdict.$is('Usable')(yield* checkGate(transport))).toBe(true);
      expect(yield* checkGate(transport)).toEqual(RecipientGateVerdict.Unusable({ reason: 'SOURCE_NO_LONGER_VALID' }));
      expect(asked).toHaveLength(2);
    }),
  );

  it.effect(
    'an outage, an invalid answer, an answer for another issuance or no authority is an unavailable source owner',
    () =>
      Effect.gen(function* failsClosed() {
        const down = scripted(() => Effect.fail(new Error('owner down')));
        expect(yield* Effect.flip(checkGate(down.transport))).toMatchObject({ authority: 'SOURCE_OWNER' });
        const invalid = scripted(() => Effect.succeed({ kind: 'MAYBE' }));
        expect(yield* Effect.flip(checkGate(invalid.transport))).toMatchObject({ authority: 'SOURCE_OWNER' });
        const other = scripted(() => Effect.succeed(facts(STATE.current, 'CURRENT', 'pa-other')));
        expect(yield* Effect.flip(checkGate(other.transport))).toMatchObject({ authority: 'SOURCE_OWNER' });
        const unasked = scripted(() => Effect.succeed(facts(STATE.current, 'CURRENT')));
        const noCall = yield* Effect.flip(
          portalAuthRecipientCurrentGateOver(SETTINGS, unasked.transport).check(gateQuery()),
        );
        expect(noCall).toMatchObject({ authority: 'SOURCE_OWNER' });
        expect(unasked.asked).toHaveLength(0);
      }),
  );

  it.effect(
    "a contact that is not Auth's own endpoint, or is evidenced by a revision Auth never issues, is never put to Auth",
    () =>
      Effect.gen(function* notAuths() {
        const { asked, transport } = scripted(() => Effect.succeed(facts(STATE.current, 'CURRENT')));
        for (const query of [
          gateQuery({ contactModule: 'fixture.party' }),
          gateQuery({ evidence: 'VERSIONED_SNAPSHOT' }),
        ]) {
          expect(yield* Effect.flip(checkGate(transport, query))).toMatchObject({ authority: 'SOURCE_OWNER' });
        }
        expect(asked).toHaveLength(0);
      }),
  );

  it.effect('an owner past the deadline is an unavailable source owner', () =>
    Effect.gen(function* slowOwner() {
      const { transport } = scripted(() => Effect.never);
      const fiber = yield* Effect.forkChild(Effect.flip(checkGate(transport)));
      yield* TestClock.adjust(Duration.seconds(6));
      expect(yield* Fiber.join(fiber)).toMatchObject({ authority: 'SOURCE_OWNER' });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
