import { CommunicationRequestScopeSchema } from '@app/communications-contracts/communication-request';
import { ReadHandlerUnavailable, ReadPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CommunicationOutcomeFeedRequestSchema,
  CommunicationOutcomeFeedResponseSchema,
} from '@app/communications-contracts/communication-outcome-feed';
import {
  communicationOutcomeFeedRead,
  readCommunicationOutcomeFeed,
} from '../../src/api/communication-outcome-feed.read.ts';
import { sourceOutcomeService } from '../../src/services/communication-outcome-feed.service.ts';
import type { FindSourceRequest } from '../../src/services/communication-outcome-feed.service.ts';
import { SourceOutcomeUnavailable } from '../../src/services/source-outcome-unavailable.ts';
import type { RequestHistoryRecord } from '../../src/services/message-history.service.ts';
import { asSourceAdmission, asSourceWorker } from '../support/source-worker-principal.ts';
import { TENANT_ID, intentRecord, requestRecord } from './support/access-fixtures.ts';
import { factsOf } from './support/history-fixtures.ts';

/**
 * [#1402 H-13 AC-07; #1394 PO 2A; #1396 AC-09] The outcome of a request reaches the SOURCE workflow that made it, and only it: a
 * required message that failed after the request was accepted is reported to the source, a request of another source is the same
 * answer as an absent one, and a store that cannot be read is a typed failure and never an empty success.
 */
const SOURCE = 'fixture.source';
const OTHER_SOURCE = 'fixture.other-source';
const REVISION = 'c'.repeat(64);
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authContextRef: 'job:fixture.source.submit:run:1',
  authMethod: 'system',
  principalId: '77777777-7777-4777-8777-0000000000d1',
  tenantId: TENANT_ID,
});
const workerOf = (module: string): OperationalScope =>
  asSourceWorker({ ...principal, correlationId: 'outcome-feed-test' }, module, REVISION);
const foreignScope = Schema.decodeUnknownSync(CommunicationRequestScopeSchema)({
  tenantId: '99999999-9999-4999-8999-999999999999',
});
const asked = Schema.decodeUnknownSync(CommunicationOutcomeFeedRequestSchema)({
  occurrence: { occurrenceId: 'fixture-occurrence-1', revision: 1 },
  purpose: 'fixture.purpose',
});

/** A required message that was suppressed after the request was accepted: the failure the source must learn. */
const failedRecord = (sourceModule = SOURCE): RequestHistoryRecord => {
  const base = requestRecord([
    intentRecord({
      decisionReason: 'PRIVACY_NOT_ALLOWED',
      facts: factsOf({ intentStatus: 'SUPPRESSED', reason: 'PRIVACY_NOT_ALLOWED' }),
    }),
  ]);
  return { ...base, request: { ...base.request, sourceModule } };
};

/** An in-memory owner lookup: it answers only the exact identity asked, as the PostgreSQL form does, or fails as a whole. */
const lookupOf =
  (records: readonly RequestHistoryRecord[], unreachable = false): FindSourceRequest =>
  (identity) =>
    unreachable
      ? Effect.fail(new SourceOutcomeUnavailable({ reason: 'the store is down' }))
      : Effect.succeed(
          Option.fromNullishOr(
            records.find(
              ({ request }) =>
                request.sourceModule === identity.sourceModule &&
                request.occurrenceId === identity.occurrenceId &&
                request.occurrenceRevision === identity.occurrenceRevision &&
                request.purpose === identity.purpose,
            ),
          ),
        );

const servicesOf = (findRequest: FindSourceRequest) => ({
  outcomes: sourceOutcomeService(findRequest, { tenantId: TENANT_ID }),
});

describe('The source outcome Read answers a source about its own requests (#1402 H-13, AC-07)', () => {
  it.effect(
    '[H-13] reports a required message that failed after the request was accepted, as a result and an order of nothing',
    () =>
      Effect.gen(function* failure() {
        const outcome = yield* readCommunicationOutcomeFeed(asked, {
          scope: workerOf(SOURCE),
          services: servicesOf(lookupOf([failedRecord()])),
        });
        expect(Option.isSome(outcome.result)).toBe(true);
        expect(Option.getOrThrow(outcome.result)).toMatchObject({
          messages: [{ attention: 'FAILURE', reason: 'PRIVACY_NOT_ALLOWED', status: 'SUPPRESSED' }],
          requiredOutcome: 'FAILED',
          sourceImpact: 'SOURCE_OWNER_DECIDES',
        });
        expect(outcome.evidence).toEqual({ resultCount: 1 });
        // the result is published, schema-only and round-trips as plain JSON of references and closed codes
        const encoded = Schema.encodeSync(CommunicationOutcomeFeedResponseSchema)(outcome.result);
        expect(JSON.stringify(encoded)).not.toMatch(/@|https?:|token|password|secret|otp/iu);
      }),
  );

  it.effect(
    '[AC-07] a source sees only its OWN requests: another source asking gets none, whatever the store holds',
    () =>
      Effect.gen(function* ownOnly() {
        const lookup = lookupOf([failedRecord(SOURCE)]);
        const other = yield* readCommunicationOutcomeFeed(asked, {
          scope: workerOf(OTHER_SOURCE),
          services: servicesOf(lookup),
        });
        expect(Option.isNone(other.result)).toBe(true);
        expect(other.evidence).toEqual({ resultCount: 0 });
        // even a store that matched too much cannot show a source the request of another one
        const sloppy: FindSourceRequest = () => Effect.succeed(Option.some(failedRecord(SOURCE)));
        const leaked = yield* readCommunicationOutcomeFeed(asked, {
          scope: workerOf(OTHER_SOURCE),
          services: servicesOf(sloppy),
        });
        expect(Option.isNone(leaked.result)).toBe(true);
      }),
  );

  it.effect(
    '[AC-07] a request of another scope or occurrence is none, and a request that was never admitted is none',
    () =>
      Effect.gen(function* absent() {
        const services = servicesOf(lookupOf([failedRecord()]));
        const otherOccurrence = Schema.decodeUnknownSync(CommunicationOutcomeFeedRequestSchema)({
          occurrence: { occurrenceId: 'fixture-occurrence-2', revision: 1 },
          purpose: 'fixture.purpose',
        });
        expect(
          Option.isNone(
            (yield* readCommunicationOutcomeFeed(otherOccurrence, { scope: workerOf(SOURCE), services })).result,
          ),
        ).toBe(true);
        // the same occurrence in the scope of another Tenant: the store matched it, the exact scope did not
        const foreign = servicesOf(() =>
          Effect.succeed(
            Option.some({ ...failedRecord(), request: { ...failedRecord().request, scope: foreignScope } }),
          ),
        );
        expect(
          Option.isNone(
            (yield* readCommunicationOutcomeFeed(asked, { scope: workerOf(SOURCE), services: foreign })).result,
          ),
        ).toBe(true);
      }),
  );

  it.effect('[H-13] a store that cannot be read is a typed retryable failure, never an empty success', () =>
    Effect.gen(function* unreachable() {
      const failure = yield* readCommunicationOutcomeFeed(asked, {
        scope: workerOf(SOURCE),
        services: servicesOf(lookupOf([failedRecord()], true)),
      }).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
    }),
  );

  it.effect('refuses a call that names no verified source module before anything is read', () =>
    Effect.gen(function* refused() {
      const services = servicesOf(() => Effect.die('the store must not be asked without a verified source module'));
      // a person holding the declaration, and a registered admission that is not a source worker's own delivery
      for (const scope of [
        { ...principal, correlationId: 'outcome-feed-test' },
        { ...asSourceAdmission(principal, REVISION), correlationId: 'outcome-feed-test' },
      ]) {
        const failure = yield* readCommunicationOutcomeFeed(asked, { scope, services }).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(ReadPermissionDenied);
      }
    }),
  );

  it('names no source, Tenant or Legal Entity in its request: only the verified caller and the trusted scope choose them', () => {
    const decode = Schema.decodeUnknownSync(CommunicationOutcomeFeedRequestSchema, { onExcessProperty: 'error' });
    expect(() => decode(asked)).not.toThrow();
    for (const extra of ['sourceModule', 'source', 'tenantId', 'legalEntityId', 'requestId']) {
      expect(() => decode({ ...asked, [extra]: 'fixture.other-source' })).toThrow();
    }
  });

  it('is a protected workload Read of this owner with ONE declaration and no field group, scoped to the exact Legal Entity', () => {
    const { descriptor } = communicationOutcomeFeedRead;
    expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    expect(descriptor.accessDeclaration).toMatchObject({
      key: 'communications.core.communication-outcome-feed.read',
      kind: 'read',
      modes: ['run'],
      selectors: [],
    });
    expect(descriptor.accessWorkload?.workloads).toEqual(['communications.core.request-source']);
    expect(descriptor.accessFieldGroups).toBeUndefined();
    expect(descriptor.legalEntityScope).toBe('optional');
    expect(descriptor.owningModuleKey).toBe('communications.core');
  });
});
