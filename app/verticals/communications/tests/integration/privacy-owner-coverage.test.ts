import { loadDatabaseConnectionPair } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PrivacyOwnerCoverageRequestSchema } from '../../shared/apis/privacy-owner-coverage.ts';
import type { PrivacyOwnerCoverageRequest } from '../../shared/apis/privacy-owner-coverage.ts';
import { scopePartRefs } from '../../shared/privacy-owner/inventory.ts';
import type { SuppliedPrivacyReferences } from '../../shared/privacy-owner/inventory.ts';
import { evaluateCommunicationsOwnerMeasure, handoffRecordOf } from '../../shared/privacy-owner/outcome.ts';
import { evaluateCommunicationsRetention } from '../../shared/privacy-owner/retention-evaluation.ts';
import {
  COMMUNICATIONS_TABLES,
  communicationDecisions,
  communicationRequests,
  deliveryAttempts,
  messageIntents,
  providerObservations,
} from '../../src/database/schema.ts';
import { privacyOwnerCoverageForScope } from '../../src/services/privacy-owner-coverage.service.ts';
import type { PrivacyOwnerCoverageOptions } from '../../src/services/privacy-owner-coverage.service.ts';
import {
  fixtureType,
  FIXTURE_APPROVER_ROLE,
  FIXTURE_CONTACT_OWNER,
  FIXTURE_CONTACT_RESOURCE_TYPE,
  nRecipientPolicyType,
} from '../unit/support/catalog-fixtures.ts';
import { binding } from '../unit/support/recipient-fixtures.ts';
import { baseIdentity, seedLanguages } from '../support/language-fixtures.ts';
import { decideOne, ingest, intentIdAt, minutesFromNow, step, targetOf } from '../support/history-world.ts';
import type { World } from '../support/history-world.ts';
import { communicationRequest, handoffDouble, originalRecipient } from '../support/intake-fixtures.ts';
import { assetRef } from '../support/document-owner-double.ts';
import { answers, attemptsOf, reconcileThenStep, resolutionsOf, stepWith } from '../support/recovery-world.ts';
import { step22Double } from '../support/step22-observation-double.ts';
import { decided, intakeWorld, requestFor } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';
import { measureOf, ownerScope } from '../unit/support/privacy-owner-fixtures.ts';

/**
 * [#1410 AC-01 AC-05 AC-08 AC-10 AC-12 AC-15 AC-16] Communications' Owner Coverage, contribution, outcome evidence and
 * non-destructive retention hook on native PostgreSQL, as the runtime role, over REAL stored requests, decisions, intents,
 * attempts and provider observations. The Messaging Adapter and the step 22 observations are labelled doubles: they prove
 * how Communications reads an answer, never that a provider answers so. The backup coverage is a labelled double too,
 * because Communications cannot observe platform backups itself.
 */

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

const operationalScope = (tenantId: string, legalEntityId?: string): OperationalScope => {
  const scope: OperationalScope = {
    authContextRef: 'job:communications-privacy-coverage-tests:run:1',
    authMethod: 'system',
    correlationId: 'communications-privacy-coverage-tests',
    principalId: '00000000-0000-4000-8000-0000000000b1',
    tenantId,
  };
  return legalEntityId === undefined ? scope : { ...scope, legalEntityId };
};

const PrivilegeRowsSchema = Schema.Array(
  Schema.Struct({ can_delete: Schema.Boolean, can_truncate: Schema.Boolean, name: Schema.String }),
);

const startKey = ({ contentRef, startAt }: { contentRef: string; startAt: DateTime.Utc }) =>
  `${contentRef}@${DateTime.formatIso(startAt)}`;

const evaluatedBackup: PrivacyOwnerCoverageOptions['backup'] = {
  evidenceRef: 'FICTIONAL-backup-evaluation-1',
  kind: 'EVALUATED',
  observedAt: DateTime.makeUnsafe('2026-11-19T10:00:00.000Z'),
};
const withBackup = (supplied: SuppliedPrivacyReferences = {}): PrivacyOwnerCoverageOptions => ({
  backup: evaluatedBackup,
  eligibility: {},
  supplied,
});
const withoutBackup: PrivacyOwnerCoverageOptions = { backup: { kind: 'UNAVAILABLE' }, eligibility: {}, supplied: {} };

const subject = (resourceId: string) =>
  ({
    _tag: 'SUBJECT_REFERENCE',
    lookupRef: `lookup-${resourceId}`,
    moduleId: 'fixture.party',
    resourceId,
    resourceType: 'fixture.recipient',
  }) as const;

type RawLookups = (typeof PrivacyOwnerCoverageRequestSchema.Encoded)['trustedLookups'];
const decodeRequest = Schema.decodeUnknownSync(PrivacyOwnerCoverageRequestSchema);

const requestOf = (
  tenantId: string,
  lookups: RawLookups,
  right?: NonNullable<PrivacyOwnerCoverageRequest['right']>,
): PrivacyOwnerCoverageRequest => {
  const raw = {
    scope: ownerScope({ tenantId, trustedLookupRefs: lookups.map(({ lookupRef }) => lookupRef) }),
    trustedLookups: lookups,
  };
  return decodeRequest(right === undefined ? raw : { ...raw, right });
};

const coverageOf = (
  world: World,
  lookups: RawLookups,
  options: PrivacyOwnerCoverageOptions,
  tenantId = world.tenantId,
  right?: NonNullable<PrivacyOwnerCoverageRequest['right']>,
  legalEntityId?: string,
) =>
  world.database.inTenant(world.tenantId, (transaction) =>
    privacyOwnerCoverageForScope(transaction, operationalScope(world.tenantId, legalEntityId), options).coverage(
      requestOf(tenantId, lookups, right),
    ),
  );

/** A frozen picture of every owner table of the Tenant, to prove that observing changes nothing. */
const snapshotOf = (world: World) =>
  world.database.inTenant(world.tenantId, (transaction) =>
    Effect.all(COMMUNICATIONS_TABLES.map((table) => transaction.select().from(table))).pipe(
      Effect.map((tables) => JSON.stringify(tables.map((rows) => rows.length))),
    ),
  );

const rowsHash = (world: World) =>
  world.database.inTenant(world.tenantId, (transaction) =>
    Effect.all(COMMUNICATIONS_TABLES.map((table) => transaction.select().from(table))).pipe(
      Effect.map((tables) => JSON.stringify(tables)),
    ),
  );

const found = (
  result: Option.Option<{
    readonly coverage: {
      readonly coverageParts: readonly { readonly foundContentRefs: readonly string[]; readonly scopeRef: string }[];
    };
  }>,
) =>
  Option.match(result, {
    onNone: () => [],
    onSome: ({ coverage }) => coverage.coverageParts.flatMap(({ foundContentRefs }) => foundContentRefs),
  });

describe('Communications Owner Coverage on native PostgreSQL (AC-08 AC-15)', () => {
  it.live('finds the own data of an existing subject, complete per part, and never claims NO_DATA', () =>
    Effect.gen(function* existingData() {
      const world = yield* setup();
      const { intentId, requestId } = yield* decideOne(world);
      yield* step(world, handoffDouble(), intentId);
      const answer = yield* coverageOf(world, [subject('customer-1')], withBackup());
      const { configuration, coverage, ownerMutationBoundary } = yield* Option.match(answer, {
        onNone: () => Effect.die('the owner answered not found'),
        onSome: Effect.succeed,
      });
      expect([coverage.coverageStatus, coverage.contentStatus]).toEqual(['COMPLETE', 'FOUND']);
      const refs = coverage.coverageParts.flatMap(({ foundContentRefs }) => foundContentRefs);
      expect(refs).toContain(`communications.core.request:${requestId}`);
      expect(refs).toContain(`communications.core.intent:${intentId}`);
      expect(refs.some((ref) => ref.startsWith('communications.core.attempt:'))).toBe(true);
      // the rendered content part holds nothing by design and is still evidenced
      expect(coverage.coverageParts).toHaveLength(scopePartRefs.length);
      expect(ownerMutationBoundary).toBe('NO_AUTOMATIC_OR_DESTRUCTIVE_OWNER_OPERATION');
      // no Privacy input is supplied, so every persisted category is a configuration gap, never a default
      expect(configuration.filter(({ state }) => state === 'CONFIGURATION_GAP')).toHaveLength(6);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('proves NO_DATA only for a subject with no data AND only with every part completely evidenced', () =>
    Effect.gen(function* emptyScope() {
      const world = yield* setup();
      yield* decideOne(world);
      const unknownSubject = yield* coverageOf(world, [subject('customer-404')], withBackup());
      const complete = yield* Option.match(unknownSubject, {
        onNone: () => Effect.die('not found'),
        onSome: Effect.succeed,
      });
      expect([complete.coverage.coverageStatus, complete.coverage.contentStatus]).toEqual(['COMPLETE', 'NO_DATA']);
      // the very same empty search, but the backup is not observable: it is partial, NOT a false NO_DATA (AC-08)
      const noBackup = yield* coverageOf(world, [subject('customer-404')], withoutBackup);
      const partial = yield* Option.match(noBackup, { onNone: () => Effect.die('not found'), onSome: Effect.succeed });
      expect([partial.coverage.coverageStatus, partial.coverage.contentStatus]).toEqual(['PARTIAL', 'UNKNOWN']);
      expect(
        partial.coverage.coverageParts.find(({ unresolvedReason }) => unresolvedReason !== undefined)?.unresolvedReason,
      ).toBe('BACKUP_AND_RECOVERY_COPIES_NOT_OBSERVABLE_BY_OWNER');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'does not treat a lookup that reaches no part as complete: a staff-actor lookup alone leaves the subject parts open',
    () =>
      Effect.gen(function* actorOnly() {
        const world = yield* setup();
        const answer = yield* coverageOf(
          world,
          [{ _tag: 'ACTOR_PRINCIPAL', lookupRef: 'lookup-actor', principalId: '00000000-0000-4000-8000-0000000000b1' }],
          withBackup(),
        );
        const { coverage } = yield* Option.match(answer, {
          onNone: () => Effect.die('not found'),
          onSome: Effect.succeed,
        });
        expect(coverage.coverageStatus).toBe('PARTIAL');
        expect(
          coverage.coverageParts.filter(
            ({ unresolvedReason }) => unresolvedReason === 'NO_APPLICABLE_LOOKUP_FOR_THIS_PART',
          ),
        ).not.toHaveLength(0);
        expect(coverage.contentStatus).not.toBe('NO_DATA');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('keeps Tenant isolation: another Tenant sees nothing and a scope of another Tenant is not found', () =>
    Effect.gen(function* tenants() {
      const world = yield* setup();
      yield* decideOne(world);
      const otherTenant = yield* nextId;
      expect(Option.isNone(yield* coverageOf(world, [subject('customer-1')], withBackup(), otherTenant))).toBe(true);
      const foreign = yield* setup();
      const answer = yield* coverageOf(foreign, [subject('customer-1')], withBackup());
      expect(found(answer)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    "stays partial for a shared contact: content of another recipient is withheld, never counted as the requester's",
    () =>
      Effect.gen(function* sharedContact() {
        const world = yield* setup({
          recipients: ['customer-1', 'customer-2'],
          types: [nRecipientPolicyType],
        });
        yield* world.database.withPorts(world.tenantId, (templates) =>
          seedLanguages(templates, ['cs'], { ...baseIdentity, messageType: nRecipientPolicyType.typeId }),
        );
        const submitted = yield* world.runner.submit(
          world.tenantId,
          communicationRequest({
            bindings: [
              binding(FIXTURE_APPROVER_ROLE, 'customer-1'),
              // the second approver shares the first one's contact point
              binding(FIXTURE_APPROVER_ROLE, 'customer-2', 'contact-customer-1'),
            ],
            purpose: nRecipientPolicyType.purpose,
            tenantId: world.tenantId,
          }),
        );
        expect(decided(submitted).decision.kind).toBe('MESSAGE_INTENTS');
        const lookups = [
          subject('customer-1'),
          {
            _tag: 'CONTACT_REFERENCE',
            lookupRef: 'lookup-contact',
            moduleId: FIXTURE_CONTACT_OWNER,
            resourceId: 'contact-customer-1',
            resourceType: FIXTURE_CONTACT_RESOURCE_TYPE,
          },
        ] as const;
        const answer = yield* coverageOf(world, lookups, withBackup(), world.tenantId, 'ACCESS');
        const { contribution, coverage } = yield* Option.match(answer, {
          onNone: () => Effect.die('not found'),
          onSome: Effect.succeed,
        });
        expect(coverage.coverageStatus).toBe('PARTIAL');
        expect(coverage.contentStatus).toBe('FOUND');
        // two intents were decided, but only the requester's own one is a found reference: the other recipient's
        // intent and everything of it (originals, pins, attempts) is withheld from the reference list as well
        const foundRefs = coverage.coverageParts.flatMap(({ foundContentRefs }) => foundContentRefs);
        const { decision } = decided(submitted);
        const decidedIntents = decision.kind === 'MESSAGE_INTENTS' ? decision.intents : [];
        expect(decidedIntents).toHaveLength(2);
        expect(foundRefs.filter((ref) => ref.startsWith('communications.core.intent:'))).toHaveLength(1);
        expect(foundRefs.filter((ref) => ref.startsWith('communications.core.original-recipient:'))).toHaveLength(1);
        expect(Option.getOrUndefined(contribution)?.completion).toBe('INCOMPLETE');
        // the other recipient's intent is excluded as inseparable third-party content; the request's list is redacted
        expect(Option.getOrUndefined(contribution)?.decisions.some(({ outcome }) => outcome === 'EXCLUDE')).toBe(true);
        expect(Option.getOrUndefined(contribution)?.decisions.some(({ outcome }) => outcome === 'REDACT')).toBe(true);
        expect(Option.getOrUndefined(contribution)?.decisions.some(({ outcome }) => outcome === 'INCLUDE')).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'keeps a replaced provider as a known historical holder and invents no provider-side disposition (AC-10)',
    () =>
      Effect.gen(function* providerChange() {
        const world = yield* setup();
        const unknown = handoffDouble(() => Effect.succeed({ kind: 'INDETERMINATE', reason: 'timeout' } as const));
        const observedAt = yield* minutesFromNow(0);
        // the same subject was served by provider A under one request and, after an adapter swap, by provider B under a later one
        const ingestFor = Effect.fn('ProviderChange.ingestFor')(function* ingestOne(
          occurrence: string,
          providerKey: string,
        ) {
          const { intentId } = yield* decideOne(world, 'customer-1', occurrence);
          yield* step(world, unknown, intentId);
          const [attempt] = yield* world.read((tx) =>
            tx
              .select({ id: deliveryAttempts.attemptId })
              .from(deliveryAttempts)
              .where(eq(deliveryAttempts.intentId, intentId)),
          );
          return yield* ingest(
            world,
            step22Double.acceptanceProven(targetOf(world, intentId, attempt?.id ?? ''), {
              key: `${providerKey}-1`,
              observedAt,
              providerKey,
            }),
          );
        });
        expect(yield* ingestFor('o-a', 'provider-a')).toBe('RECORDED');
        yield* Effect.sleep('20 millis');
        expect(yield* ingestFor('o-b', 'provider-b')).toBe('RECORDED');
        const named = yield* coverageOf(world, [subject('customer-1')], {
          ...withBackup(),
          currentTransportProviderKey: 'provider-b',
        });
        const { externalCopies } = yield* Option.match(named, {
          onNone: () => Effect.die('not found'),
          onSome: Effect.succeed,
        });
        expect(externalCopies.map(({ holderRef, relationship }) => [holderRef, relationship])).toEqual([
          ['step-22-provider:provider-a', 'PRIOR_PROVIDER'],
          ['step-22-provider:provider-b', 'CURRENT_TRANSPORT'],
        ]);
        // nobody told the owner which provider is current: the latest observation is not taken for it
        const unnamed = yield* coverageOf(world, [subject('customer-1')], withBackup());
        const unnamedCopies = yield* Option.match(unnamed, {
          onNone: () => Effect.die('not found'),
          onSome: ({ externalCopies: copies }) => Effect.succeed(copies),
        });
        expect(unnamedCopies.map(({ relationship }) => relationship)).toEqual([
          'HISTORICAL_TRANSPORT',
          'HISTORICAL_TRANSPORT',
        ]);
        expect(
          externalCopies.every(
            ({ providerSideDispositionEvidence }) => providerSideDispositionEvidence === 'NOT_HELD_BY_COMMUNICATIONS',
          ),
        ).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'lists a provider that was handed a message from the handoff attempt itself, with no provider observation at all',
    () =>
      Effect.gen(function* handedOver() {
        const world = yield* setup();
        const { intentId } = yield* decideOne(world);
        // the provider accepted the submission and never reported back: no row of provider_observations exists
        yield* step(world, handoffDouble(), intentId);
        const observations = yield* world.read((tx) => tx.select().from(providerObservations));
        expect(observations).toHaveLength(0);
        const answer = yield* coverageOf(world, [subject('customer-1')], {
          ...withBackup(),
          currentTransportProviderKey: 'another-provider',
        });
        const { externalCopies } = yield* Option.match(answer, {
          onNone: () => Effect.die('not found'),
          onSome: Effect.succeed,
        });
        // this provider holds a copy although nobody observed it, and it is not the current one the deployment names
        expect(externalCopies.map(({ holderRef, relationship }) => [holderRef, relationship])).toEqual([
          ['step-22-provider:fixture-provider', 'PRIOR_PROVIDER'],
        ]);
        // a rejected or unavailable provider never accepted anything, so it is not a holder
        const refused = yield* setup();
        const second = yield* decideOne(refused);
        yield* step(
          refused,
          handoffDouble(() => Effect.succeed({ kind: 'REJECTED', reason: 'provider_rejected' } as const)),
          second.intentId,
        );
        const refusedAnswer = yield* coverageOf(refused, [subject('customer-1')], withBackup());
        expect(
          yield* Option.match(refusedAnswer, {
            onNone: () => Effect.die('not found'),
            onSome: ({ externalCopies: copies }) => Effect.succeed(copies),
          }),
        ).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'never shows another Legal Entity of the same Tenant: a requester in entity A sees no record created under B',
    () =>
      Effect.gen(function* legalEntities() {
        const world = yield* setup();
        const entityA = '00000000-0000-4000-8000-0000000000e1';
        const entityB = '00000000-0000-4000-8000-0000000000e2';
        // today's intake runs without a Legal Entity, so the Tenant-level request is real and the entity ones are stored
        // copies of it (request, decision and intent) under another scope key: exactly what an entity-scoped producer writes
        const tenantLevel = yield* decideOne(world);
        const copyUnder = (legalEntityId: string) =>
          world.database.inTenant(world.tenantId, (transaction) =>
            Effect.gen(function* copy() {
              const [request] = yield* transaction.select().from(communicationRequests);
              const [decision] = yield* transaction.select().from(communicationDecisions);
              const [intent] = yield* transaction.select().from(messageIntents);
              if (request === undefined || decision === undefined || intent === undefined) {
                return yield* Effect.die('the world holds no request to copy');
              }
              const requestId = crypto.randomUUID();
              const intentId = crypto.randomUUID();
              const decisionId = crypto.randomUUID();
              yield* transaction.insert(communicationRequests).values({
                ...request,
                identityKey: `${request.identityKey}-${legalEntityId}`,
                requestId,
                scopeKey: `${world.tenantId}|${legalEntityId}|||`,
              });
              yield* transaction.insert(communicationDecisions).values({ ...decision, decisionId, requestId });
              yield* transaction.insert(messageIntents).values({
                ...intent,
                decisionId,
                intentId,
                intentKey: `${intent.intentKey}-${legalEntityId}`,
                requestId,
              });
              return { intentId, requestId };
            }),
          );
        const inA = yield* copyUnder(entityA);
        const inB = yield* copyUnder(entityB);
        const refsIn = (legalEntityId?: string) =>
          coverageOf(world, [subject('customer-1')], withBackup(), world.tenantId, undefined, legalEntityId).pipe(
            Effect.map(found),
          );
        const asA = yield* refsIn(entityA);
        expect(asA).toContain(`communications.core.request:${inA.requestId}`);
        expect(asA).toContain(`communications.core.intent:${inA.intentId}`);
        expect(asA).not.toContain(`communications.core.request:${inB.requestId}`);
        expect(asA).not.toContain(`communications.core.intent:${inB.intentId}`);
        // the Tenant-level record belongs to no entity: it stays visible, so an entity never gets a false NO_DATA
        expect(asA).toContain(`communications.core.request:${tenantLevel.requestId}`);
        const asB = yield* refsIn(entityB);
        expect(asB).toContain(`communications.core.request:${inB.requestId}`);
        expect(asB).not.toContain(`communications.core.request:${inA.requestId}`);
        expect(asB).not.toContain(`communications.core.intent:${inA.intentId}`);
        // a Tenant-wide read still sees every record of the Tenant
        const tenantWide = yield* refsIn();
        for (const requestId of [tenantLevel.requestId, inA.requestId, inB.requestId]) {
          expect(tenantWide).toContain(`communications.core.request:${requestId}`);
        }
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('cites the evaluated backup evidence in the NO_DATA answer and never looks fresher than that evidence', () =>
    Effect.gen(function* backupEvidence() {
      const world = yield* setup();
      const answer = yield* coverageOf(world, [subject('customer-404')], withBackup());
      const { coverage } = yield* Option.match(answer, {
        onNone: () => Effect.die('not found'),
        onSome: Effect.succeed,
      });
      expect(coverage.contentStatus).toBe('NO_DATA');
      const part = coverage.coverageParts.find(({ scopeRef }) => scopeRef.includes('provider-copy'));
      expect(part?.evidenceRefs).toContain('FICTIONAL-backup-evaluation-1');
      expect(part?.evidenceRefs.some((ref) => ref.endsWith('backup-observed-at/2026-11-19T10:00:00.000Z'))).toBe(true);
      expect(part?.observedAt).toBe('2026-11-19T10:00:00.000Z');
      expect(coverage.evidenceRefs).toContain('FICTIONAL-backup-evaluation-1');
      // the owner's own observation time still holds for every other part
      expect(
        coverage.coverageParts.filter(({ observedAt }) => observedAt !== '2026-11-19T10:00:00.000Z'),
      ).not.toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'finds records only by the EXACT references Privacy supplied: a lookup that names another resource finds nothing, so NO_DATA is only as complete as the trusted lookups',
    () =>
      Effect.gen(function* lookupBoundary() {
        const world = yield* setup();
        yield* decideOne(world);
        // the stored records name fixture.party / fixture.recipient / customer-1; a differing module, type or id is another resource
        const otherLookups = [
          { ...subject('customer-1'), moduleId: 'fixture.other-party' },
          { ...subject('customer-1'), resourceType: 'fixture.other-type' },
          subject('customer-10'),
        ] as const;
        for (const lookup of otherLookups) {
          const answer = yield* coverageOf(world, [lookup], withBackup());
          const { coverage } = yield* Option.match(answer, {
            onNone: () => Effect.die('not found'),
            onSome: Effect.succeed,
          });
          expect(found(answer)).toEqual([]);
          // complete and empty FOR THIS LOOKUP: the answer says nothing about the same person under another reference,
          // which is why the response lists the lookup references it was built from
          expect([coverage.coverageStatus, coverage.contentStatus]).toEqual(['COMPLETE', 'NO_DATA']);
          expect(coverage.scope.trustedLookupRefs).toEqual([lookup.lookupRef]);
        }
        expect(found(yield* coverageOf(world, [subject('customer-1')], withBackup()))).not.toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('Observing, evaluating and handing over change nothing (AC-05 AC-12 AC-16, PRIV-COM-05/16)', () => {
  it.live(
    'keeps every stored row byte-identical through coverage, contribution, retention evaluation, outcome and handoff',
    () =>
      Effect.gen(function* nothingChanges() {
        const world = yield* setup();
        const { intentId } = yield* decideOne(world);
        yield* step(world, handoffDouble(), intentId);
        const before = yield* rowsHash(world);
        const countsBefore = yield* snapshotOf(world);
        const answer = yield* coverageOf(world, [subject('customer-1')], withBackup(), world.tenantId, 'ERASURE');
        const { coverage } = yield* Option.match(answer, {
          onNone: () => Effect.die('not found'),
          onSome: Effect.succeed,
        });
        const targets = coverage.coverageParts
          .flatMap(({ foundContentRefs }) => foundContentRefs)
          .filter((ref) => ref.includes('.intent:'));
        const measure = measureOf({
          scope: { ...ownerScope({ tenantId: world.tenantId }) },
          targetContentRefs: targets,
        });
        for (let delivery = 0; delivery < 3; delivery += 1) {
          // a repeated handoff, a retention boundary and an owner restart all reach the same answer
          const outcome = evaluateCommunicationsOwnerMeasure({
            blockerAssessment: { assessedByRef: 'FICTIONAL-privacy-assessment-1', blockers: [] },
            confirmedAt: '2026-11-19T12:00:00.000Z',
            coverage: { ...coverage, scope: measure.scope },
            evidence: [],
            evidenceRefs: ['FICTIONAL-handoff'],
            measure,
            outcomeRef: 'FICTIONAL-outcome-1',
          });
          expect(outcome.status).toBe('PENDING');
          expect(handoffRecordOf(outcome).destructiveActionPerformed).toBe(false);
        }
        const starts = yield* world.database.inTenant(world.tenantId, (transaction) =>
          privacyOwnerCoverageForScope(transaction, operationalScope(world.tenantId)).businessStarts(),
        );
        const supplied = {
          REQUEST_DECISION_INTENT: {
            businessStartConfirmationRef: 'FICTIONAL-start',
            controllerRef: 'FICTIONAL-controller',
            controllerRole: 'CONTROLLER',
            dataCategoryRefs: ['FICTIONAL-category'],
            humanDispositionOwnerRef: 'FICTIONAL-human',
            legalHoldApplicabilityRef: 'FICTIONAL-hold',
            processingScopeRef: 'FICTIONAL-scope',
            purposeRef: 'FICTIONAL-purpose',
            purposeVersion: 1,
            retentionRules: [{ applicabilityDecisionRef: 'FICTIONAL-app', ruleRef: 'FICTIONAL-rule', ruleVersion: 1 }],
          },
        } as const satisfies SuppliedPrivacyReferences;
        const report = evaluateCommunicationsRetention({
          businessStarts: starts,
          evaluatedAt: DateTime.makeUnsafe('2099-01-01T00:00:00.000Z'),
          privacyEvaluatedDue: [
            {
              dueAt: DateTime.makeUnsafe('2027-01-01T00:00:00.000Z'),
              evaluationRef: 'FICTIONAL-evaluation',
              ruleRef: 'FICTIONAL-rule',
              ruleVersion: 1,
            },
          ],
          supplied,
        });
        expect(report.findings.find(({ category }) => category === 'REQUEST_DECISION_INTENT')?.kind).toBe(
          'OBLIGATION_OPEN',
        );
        expect(report.destructiveActionPerformed).toBe(false);
        expect(yield* rowsHash(world)).toBe(before);
        expect(yield* snapshotOf(world)).toBe(countsBefore);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'keeps the original business start on a technical reprocess: a replayed request and a second handoff restart no period (PRIV-COM-15)',
    () =>
      Effect.gen(function* startsAreImmutable() {
        const world = yield* setup();
        const startsOf = world.database.inTenant(world.tenantId, (transaction) =>
          privacyOwnerCoverageForScope(transaction, operationalScope(world.tenantId)).businessStarts(),
        );
        const { intentId } = yield* decideOne(world);
        yield* step(world, handoffDouble(), intentId);
        const first = yield* startsOf;
        yield* Effect.sleep('15 millis');
        const replay = yield* world.runner.submit(world.tenantId, requestFor(world.tenantId));
        expect(decided(replay).replayed).toBe(true);
        yield* step(world, handoffDouble(), intentId);
        const again = yield* startsOf;
        // nothing re-keyed or re-dated: the earlier starts are all still there, unchanged
        expect(again.map(startKey).filter((entry) => first.map(startKey).includes(entry))).toEqual(first.map(startKey));
        expect(first.map(({ category }) => category)).toEqual(
          expect.arrayContaining(['REQUEST_DECISION_INTENT', 'ORIGINAL_RECIPIENT_ENDPOINT']),
        );
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'lets the runtime role neither DELETE nor TRUNCATE any owner table that carries personal data, and refuses a real attempt',
    () =>
      Effect.gen(function* privileges() {
        const world = yield* setup();
        yield* decideOne(world);
        const { admin } = yield* loadDatabaseConnectionPair();
        const client = yield* PgClient.makeClient({ url: Redacted.make(admin.connectionString) });
        const privilegeRows = yield* client.unsafe(
          `select c.relname as name,
                has_table_privilege('ontos_runtime', c.oid, 'DELETE') as can_delete,
                has_table_privilege('ontos_runtime', c.oid, 'TRUNCATE') as can_truncate
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'communications' and c.relkind = 'r'`,
        );
        const rows = Schema.decodeUnknownSync(PrivilegeRowsSchema)(privilegeRows);
        const deletable = rows.filter(({ can_delete }) => can_delete).map(({ name }) => name);
        const truncatable = rows.filter(({ can_truncate }) => can_truncate).map(({ name }) => name);
        expect(truncatable).toEqual([]);
        // the replay ledger of gateway assertion ids carries no subject, actor or message data
        expect(deletable.filter((name) => name !== 'gateway_assertion_redemptions')).toEqual([]);
        const refused = yield* world.database
          .inTenant(world.tenantId, (transaction) => transaction.delete(messageIntents))
          .pipe(Effect.exit);
        expect(refused._tag).toBe('Failure');
        expect((yield* world.read((tx) => tx.select().from(messageIntents))).length).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

/** The tables of the recovery, reconciliation and document lanes are read by the same owner coverage (#1403, #1409). */
const documentPolicy = {
  attachment: { kind: 'NOT_ALLOWED' },
  classification: 'fixture.classification.customer',
  documentOwner: 'fixture.documents',
  link: 'ALLOWED',
  recipientScope: 'ORIGINAL_RECIPIENT',
} as const;

describe('Communications Owner Coverage finds the recovery, reconciliation and document records (#1403 #1409 #1410)', () => {
  it.live(
    'finds a document pin as an attachment-link reference, the part is evidenced and the pin is a reference only',
    () =>
      Effect.gen(function* documentPin() {
        const world = yield* setup({ types: [fixtureType({ documents: documentPolicy })] });
        world.documents.assign('doc-1', assetRef('asset-1'));
        const run = yield* world.runner.submit(
          world.tenantId,
          communicationRequest({
            bindings: [originalRecipient('customer-1')],
            documents: [{ documentId: 'doc-1' }],
            occurrenceId: 'fixture-occurrence-1',
            tenantId: world.tenantId,
          }),
        );
        const result = decided(run);
        const intents = result.decision.kind === 'MESSAGE_INTENTS' ? result.decision.intents : [];
        const intentId = yield* intentIdAt(intents);
        yield* stepWith(world, handoffDouble(), intentId);
        const answer = yield* coverageOf(world, [subject('customer-1')], withBackup());
        const pinRefs = found(answer).filter((ref) => ref.startsWith('communications.core.document-pin:'));
        expect(pinRefs).toEqual([`communications.core.document-pin:${intentId}:0`]);
        // the reference names nothing of the content: no byte, URL or file name reaches Privacy
        expect(JSON.stringify(pinRefs)).not.toMatch(/asset-1|doc-1|https?:/u);
        // and the pin starts its retention at the message it belongs to, the original business event
        const starts = yield* world.database.inTenant(world.tenantId, (transaction) =>
          privacyOwnerCoverageForScope(transaction, operationalScope(world.tenantId), withBackup()).businessStarts(),
        );
        expect(
          starts
            .filter(({ category }) => category === 'ATTACHMENT_LINK_REFERENCES')
            .map(({ contentRef }) => contentRef),
        ).toEqual([`communications.core.document-pin:${intentId}:0`]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('finds a recovery evaluation and a conflict resolution as history records of the subject', () =>
    Effect.gen(function* recoveryRecords() {
      const world = yield* setup({ types: [fixtureType()] });
      let calls = 0;
      const handoff = handoffDouble(() => {
        calls += 1;
        return calls === 1 ? answers.timeout() : answers.accepted();
      });
      const { intentId } = yield* decideOne(world);
      yield* stepWith(world, handoff, intentId);
      const [first] = yield* attemptsOf(world, intentId);
      const target = targetOf(world, intentId, first?.attemptId ?? '');
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { minutes: 5 });
      expect(yield* ingest(world, step22Double.nonAcceptanceProven(target, { key: 'r-1', observedAt: now }))).toBe(
        'RECORDED',
      );
      expect(yield* ingest(world, step22Double.nonAcceptanceProven(target, { key: 'r-1', observedAt: later }))).toBe(
        'CONFLICT',
      );
      yield* reconcileThenStep(world, handoff, intentId, [
        step22Double.nonAcceptanceProven(target, { key: 'r-2', observedAt: later }),
      ]);
      const [resolution] = yield* resolutionsOf(world, intentId);
      const answer = yield* coverageOf(world, [subject('customer-1')], withBackup());
      const refs = found(answer);
      expect(refs).toContain(
        `communications.core.provider-observation-conflict-resolution:${resolution?.resolutionId}`,
      );
      expect(refs.some((ref) => ref.startsWith('communications.core.recovery-evaluation:'))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
