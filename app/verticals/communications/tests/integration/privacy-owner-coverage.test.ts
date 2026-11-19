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
import { COMMUNICATIONS_TABLES, deliveryAttempts, messageIntents } from '../../src/database/schema.ts';
import { privacyOwnerCoverageForScope } from '../../src/services/privacy-owner-coverage.service.ts';
import type { PrivacyOwnerCoverageOptions } from '../../src/services/privacy-owner-coverage.service.ts';
import {
  FIXTURE_APPROVER_ROLE,
  FIXTURE_CONTACT_OWNER,
  FIXTURE_CONTACT_RESOURCE_TYPE,
  nRecipientPolicyType,
} from '../unit/support/catalog-fixtures.ts';
import { binding } from '../unit/support/recipient-fixtures.ts';
import { baseIdentity, seedLanguages } from '../support/language-fixtures.ts';
import { decideOne, ingest, minutesFromNow, step, targetOf } from '../support/history-world.ts';
import type { World } from '../support/history-world.ts';
import { communicationRequest, handoffDouble } from '../support/intake-fixtures.ts';
import { decided, intakeWorld, requestFor } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';
import { measureOf, ownerScope } from '../unit/support/privacy-owner-fixtures.ts';
import { step22Double } from '../support/step22-observation-double.ts';

/**
 * [#1410 AC-01 AC-05 AC-08 AC-10 AC-12 AC-15 AC-16] Communications' Owner Coverage, contribution, outcome evidence and
 * non-destructive retention hook on native PostgreSQL, as the runtime role, over REAL stored requests, decisions, intents,
 * attempts and provider observations. The Messaging Adapter and the step 22 observations are labelled doubles: they prove
 * how Communications reads an answer, never that a provider answers so. The backup coverage is a labelled double too,
 * because Communications cannot observe platform backups itself.
 */

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

const operationalScope = (tenantId: string): OperationalScope => ({
  authContextRef: 'job:communications-privacy-coverage-tests:run:1',
  authMethod: 'system',
  correlationId: 'communications-privacy-coverage-tests',
  principalId: '00000000-0000-4000-8000-0000000000b1',
  tenantId,
});

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
) =>
  world.database.inTenant(world.tenantId, (transaction) =>
    privacyOwnerCoverageForScope(transaction, operationalScope(world.tenantId), options).coverage(
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
      // the rendered content and attachment parts hold nothing by design and are still evidenced
      expect(coverage.coverageParts).toHaveLength(scopePartRefs.length);
      expect(ownerMutationBoundary).toBe('NO_AUTOMATIC_OR_DESTRUCTIVE_OWNER_OPERATION');
      // no Privacy input is supplied, so every persisted category is a configuration gap, never a default
      expect(configuration.filter(({ state }) => state === 'CONFIGURATION_GAP')).toHaveLength(5);
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
        const answer = yield* coverageOf(world, [subject('customer-1')], withBackup());
        const { externalCopies } = yield* Option.match(answer, {
          onNone: () => Effect.die('not found'),
          onSome: Effect.succeed,
        });
        expect(externalCopies.map(({ holderRef, relationship }) => [holderRef, relationship])).toEqual([
          ['step-22-provider:provider-a', 'KNOWN_HISTORICAL_HOLDER'],
          ['step-22-provider:provider-b', 'CURRENT_TRANSPORT'],
        ]);
        expect(
          externalCopies.every(
            ({ providerSideDispositionEvidence }) => providerSideDispositionEvidence === 'NOT_HELD_BY_COMMUNICATIONS',
          ),
        ).toBe(true);
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
            blockers: [],
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
