import { eq, sql } from 'drizzle-orm';
import { Config, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import {
  CommercePortalAuthAccountCreationGatewayService,
  CommercePortalAuthAccountCreationProviderLive,
  CommercePortalAuthAccountCreationGatewayLive,
  CommercePortalAuthAccountLookupService,
} from '../../api/portal-auth/provider/account-create.ts';
import type { CommercePortalAuthAccountLookup } from '../../api/portal-auth/provider/account-create.ts';
import type { CommercePortalAuthAccountCreationGateway } from '../../api/portal-auth/provider/account-creation-gateway-service.ts';
import { CommercePortalAuthAccountCreationRejected } from '../../api/portal-auth/provider/account-creation-rejected.ts';
import { CommercePortalAuthAccountCreationUnavailable } from '../../api/portal-auth/provider/account-creation-unavailable.ts';
import { CommercePortalAuthInstance, makeCommercePortalAuth } from '../../api/portal-auth/provider/auth.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import {
  ClaimEnrollmentTransitionInputSchema,
  CommercePortalAccountSubjectSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentDigestSchema,
  EnrollmentKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot } from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ownerRejected, ownerUnavailable } from '../../src/enrollment/orchestration/owner-effect-codec.ts';
import {
  commerceEnrollmentOwnerTransitionDriverFor,
  CommerceEnrollmentOwnerTransitionSchema,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerReconciliationInput,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import { providerObservationFor } from '../../src/enrollment/orchestration/owner-transition-composition.ts';
import { commerceEnrollmentPortalAuthOwnerReconciliationForLookup } from '../../src/enrollment/orchestration/provider-owner-effect.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { CommercePortalAuthCommunicationOutcomeReader } from '../../src/portal-auth/communications/communication-outcome-reader.ts';
import type { PortalAuthSourceOutcome } from '../../src/portal-auth/communications/communication-outcome-reader.ts';
import { protectedHandoffLayer } from '../../src/portal-auth/communications/protected-handoff.ts';
import { verificationReplayLayer } from '../../src/portal-auth/communications/verification-replay.ts';
import { VerificationReplayUnavailable } from '../../src/portal-auth/communications/verification-replay-unavailable.ts';
import { CommercePortalAuthAccountLookupLive } from '../../src/portal-auth/persistence/portal-auth-account-lookup.ts';
import {
  CommercePortalAuthDatabase,
  makeCommercePortalAuthDatabase,
} from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { user } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import {
  expireEnrollmentAcceptanceLeases,
  makeEnrollmentAcceptanceFixture,
  readEnrollmentAcceptanceAttempt,
  readEnrollmentAcceptanceOperations,
  startEnrollmentAcceptanceAttempt,
} from '../support/enrollment-acceptance-fixture.ts';
import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';
import { ENROLLMENT_TEST_COMPOSITION_REVISION } from '../support/enrollment-composition-authority.ts';

/**
 * Better Auth can commit the account row and still lose its answer — a timed-out call, an unusable
 * payload, or a process exit before the start route journals the outcome. These cases drive the
 * installed provider against PostgreSQL and then reconcile exactly as the owner preparation does,
 * so what is proven here is the deployment's own recovery rather than a test double's.
 *
 * The correlation is a column on the account row, written by the realm's own user-creation hook in
 * the very insert that commits it. There is no second statement that could fail on its own, and no
 * second table it could fail to reach: the realm carries none.
 */

const ORIGIN = 'https://portal.example.test';
const SECRET = 'c'.repeat(64);
const PASSWORD = 'C'.repeat(24);
const DATABASE_URL = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);

const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('60000000-0000-4000-8000-0000000000c1');
const intentKey = Schema.decodeSync(EnrollmentKeySchema)('portal.enrollment.start');

interface CorrelationFixture {
  readonly attemptId: typeof EnrollmentAttemptIdSchema.Type;
  readonly database: (typeof CommercePortalAuthDatabase)['Service'];
  readonly email: string;
  readonly gateway: CommercePortalAuthAccountCreationGateway;
  readonly lookup: CommercePortalAuthAccountLookup;
  readonly ownerInvocationId: typeof EnrollmentActionInvocationIdSchema.Type;
  readonly tenantId: typeof EnrollmentTenantIdSchema.Type;
}

/**
 * One real realm over the proof database, reached through the very gateway the private
 * account-creation port installs: the correlation is therefore written by Better Auth's own
 * user-creation hook inside the provider call, never by this test.
 */
const makeCorrelationFixture = Effect.fn('CommerceEnrollmentAccountCorrelation.makeFixture')(function* makeFixture(
  caseName: string,
): Effect.fn.Return<CorrelationFixture, unknown, Scope.Scope> {
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(yield* DATABASE_URL),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  const database = yield* acquireOutlivingCleanup(makeCommercePortalAuthDatabase(configuration));
  const auth = yield* makeCommercePortalAuth({
    configuration,
    databaseAdapter: database.adapter,
    emailDelivery: {
      sendOTP: () => Promise.resolve(),
      sendResetPassword: () => Promise.resolve(),
      sendVerificationEmail: () => Promise.resolve(),
    },
  });
  const lookupLive = CommercePortalAuthAccountLookupLive.pipe(
    Layer.provide(Layer.succeed(CommercePortalAuthDatabase, database)),
  );
  const gatewayLive = CommercePortalAuthAccountCreationGatewayLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        CommercePortalAuthAccountCreationProviderLive.pipe(
          Layer.provide(Layer.succeed(CommercePortalAuthInstance, auth)),
        ),
        lookupLive,
      ),
    ),
  );
  const { gateway, lookup } = yield* Effect.all({
    gateway: CommercePortalAuthAccountCreationGatewayService,
    lookup: CommercePortalAuthAccountLookupService,
  }).pipe(Effect.provide(Layer.mergeAll(gatewayLive, lookupLive)));
  const email = `enrollment-correlation-${caseName}-${randomUUID()}@example.test`;
  const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID());
  const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)(randomUUID());
  const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(randomUUID());
  yield* Effect.addFinalizer(() => database.executor.delete(user).where(eq(user.email, email)).pipe(Effect.orDie));
  return { attemptId, database, email, gateway, lookup, ownerInvocationId, tenantId };
});

const createAccountFor = (fixture: CorrelationFixture) =>
  fixture.gateway.create({
    email: fixture.email,
    enrollmentAttemptId: fixture.attemptId,
    name: 'Correlation integration account',
    ownerInvocationId: fixture.ownerInvocationId,
    password: Redacted.make(PASSWORD),
    tenantId: fixture.tenantId,
  });

/** The Attempt as a lost provider answer leaves it: claimed, revision fenced, and no subject. */
const lostAnswerAttempt = (fixture: CorrelationFixture): EnrollmentAttemptSnapshot => ({
  compositionRevision: ENROLLMENT_TEST_COMPOSITION_REVISION,
  createdAt: DateTime.makeUnsafe('2026-09-20T10:00:00.000Z'),
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'a'.repeat(64),
  intentKey,
  journey: 'RETAIL_SELF_ENROLLMENT',
  portalEnrollmentAttemptId: fixture.attemptId,
  revision: 2,
  state: 'RECONCILIATION_REQUIRED',
  tenantId: fixture.tenantId,
  updatedAt: DateTime.makeUnsafe('2026-09-20T10:00:00.000Z'),
});

const reconciliationInputFor = (
  fixture: CorrelationFixture,
  ownerInvocationId: typeof EnrollmentActionInvocationIdSchema.Type,
): CommerceEnrollmentOwnerReconciliationInput => ({
  ...Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId,
    compositionRevision: ENROLLMENT_TEST_COMPOSITION_REVISION,
    correlationId: `commerce-enrollment-owner:${ownerInvocationId}`,
    expectedRevision: 1,
    ownerInvocationId,
    ownerModuleKey: 'commerce.portal-auth',
    portalEnrollmentAttemptId: fixture.attemptId,
    requestDigest: 'b'.repeat(64),
    tenantId: fixture.tenantId,
    transitionKey: 'provider.account.create',
  }),
  observedRevision: 2,
  ownerOperationRevision: 1,
});

/** Exactly the owner reconciliation the preparation port and the sweeper both install. */
const reconcileFor = (fixture: CorrelationFixture, ownerInvocationId: typeof EnrollmentActionInvocationIdSchema.Type) =>
  commerceEnrollmentPortalAuthOwnerReconciliationForLookup((input) =>
    providerObservationFor(lostAnswerAttempt(fixture), fixture.lookup, input.ownerInvocationId),
  ).reconcile(reconciliationInputFor(fixture, ownerInvocationId));

const usersWithEmail = (fixture: CorrelationFixture) =>
  fixture.database.executor.select({ id: user.id }).from(user).where(eq(user.email, fixture.email));

const correlationRows = (fixture: CorrelationFixture) =>
  fixture.database.executor
    .select({ providerSubjectId: user.id })
    .from(user)
    .where(eq(user.enrollmentOwnerInvocationId, String(fixture.ownerInvocationId)));

/**
 * Whether the realm still carries a table an account creation could correlate itself in separately.
 * It must not: a correlation the realm could write after its user transaction committed is exactly
 * the write that can fail on its own and leave a committed account no Attempt can ever name.
 */
const separateCorrelationTables = (fixture: CorrelationFixture) =>
  fixture.database.executor
    .execute(
      sql<{ readonly table_name: string }>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'commerce_auth'
          AND table_name = 'account_creation_correlation'
      `,
      'objects',
    )
    .pipe(Effect.map((rows) => rows.length));

/**
 * Without the provider-side correlation this reconciliation can only fail
 * `provider_account_reconciliation_indeterminate`: the Attempt journalled no subject, and the
 * account directory can only be probed by one.
 */
it.live('recovers a lost creation answer from the provider-side correlation', () =>
  Effect.scoped(
    Effect.gen(function* recoversALostAnswer() {
      const fixture = yield* makeCorrelationFixture('lost-answer');
      const created = yield* createAccountFor(fixture);

      const [correlation] = yield* correlationRows(fixture);
      expect(correlation).toStrictEqual({ providerSubjectId: created.providerSubjectId });

      // The recorded outcome is dropped: the Attempt below carries no account subject at all.
      const resolution = yield* reconcileFor(fixture, fixture.ownerInvocationId);
      expect(resolution.status).toBe('SUCCEEDED');
      expect(resolution.accountSubject?.providerSubjectId).toBe(created.providerSubjectId);
      expect(resolution.outcomeCode).toBe('provider_account_reconciled');
    }),
  ),
);

/**
 * The same start, retried after its answer was lost. The address is already taken, so without the
 * correlation replay the duplicate guard refuses it and the Attempt can never be completed.
 */
it.live('replays a retried start to the same subject and creates no second account', () =>
  Effect.scoped(
    Effect.gen(function* replaysTheRetriedStart() {
      const fixture = yield* makeCorrelationFixture('retried-start');
      const created = yield* createAccountFor(fixture);
      const replayed = yield* createAccountFor(fixture);

      expect(replayed.providerSubjectId).toBe(created.providerSubjectId);
      expect(yield* usersWithEmail(fixture)).toStrictEqual([{ id: created.providerSubjectId }]);
    }),
  ),
);

/**
 * The governed invocation reaches PostgreSQL in the account's own INSERT. Nothing else could have
 * carried it: the realm has no separate correlation table for a second write to land in, so a row
 * that answers to this invocation is proof the account insert itself carried it.
 */
it.live('writes the governed invocation in the very insert that commits the account', () =>
  Effect.scoped(
    Effect.gen(function* writesTheInvocationInTheAccountInsert() {
      const fixture = yield* makeCorrelationFixture('same-insert');
      expect(yield* separateCorrelationTables(fixture)).toBe(0);

      const created = yield* createAccountFor(fixture);

      const rows = yield* fixture.database.executor
        .select({ enrollmentOwnerInvocationId: user.enrollmentOwnerInvocationId, id: user.id })
        .from(user)
        .where(eq(user.email, fixture.email));
      expect(rows).toStrictEqual([
        { enrollmentOwnerInvocationId: String(fixture.ownerInvocationId), id: created.providerSubjectId },
      ]);
    }),
  ),
);

/** What the previous issuance of the enrollment operation is known to have become, scripted per replay by a test. */
type ScriptedOutcome = PortalAuthSourceOutcome | 'OUTCOME_UNAVAILABLE';
interface ScriptedOutcomeCell {
  current: ScriptedOutcome;
}

/**
 * One real realm whose verification callback counts and can fail its first send, reached through the very gateway the private
 * account-creation port installs. `replay` installs the rule of a deployment that moved the verification e-mail onto
 * Communications (#1406); without it the gateway is the direct one every deployment had before.
 */
const makeVerificationSendFixture = Effect.fn('CommerceEnrollmentAccountCorrelation.makeVerificationSendFixture')(
  function* makeSendFixture(options: { readonly failFirstSend: boolean; readonly replay: boolean }) {
    const configuration = yield* parseCommercePortalAuthConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(yield* DATABASE_URL),
      COMMERCE_PORTAL_AUTH_SECRET: SECRET,
      COMMERCE_PORTAL_AUTH_URL: ORIGIN,
    });
    const database = yield* acquireOutlivingCleanup(makeCommercePortalAuthDatabase(configuration));
    const sends = { count: 0 };
    const deliveredTokens: string[] = [];
    const auth = yield* makeCommercePortalAuth({
      configuration,
      databaseAdapter: database.adapter,
      emailDelivery: {
        sendOTP: () => Promise.resolve(),
        sendResetPassword: () => Promise.resolve(),
        sendVerificationEmail: ({ token }) => {
          sends.count += 1;
          // The first send fails after Better Auth has already committed the user row. Creation awaits this call directly
          // (`sendOnSignUp` is off), so this failure must surface as the creation's own outcome rather than being swallowed.
          if (options.failFirstSend && sends.count === 1) {
            return Promise.reject(new Error('simulated transactional email outage'));
          }
          deliveredTokens.push(token);
          return Promise.resolve();
        },
      },
    });
    const outcome: ScriptedOutcomeCell = { current: 'NOT_SUBMITTED' };
    const outcomeReader = Layer.succeed(CommercePortalAuthCommunicationOutcomeReader, {
      outcomeOf: () =>
        outcome.current === 'OUTCOME_UNAVAILABLE'
          ? Effect.fail(new VerificationReplayUnavailable({ reason: 'OUTCOME_UNAVAILABLE' }))
          : Effect.succeed(outcome.current),
    });
    const replayLive = verificationReplayLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          protectedHandoffLayer(() => Effect.succeed('CURRENT')),
          outcomeReader,
          commercePortalAuthPlatformCryptoLive,
        ),
      ),
    );
    // the replay rule needs the same handoff the callback would use; this fixture never routes through Communications
    const lookupLive = CommercePortalAuthAccountLookupLive.pipe(
      Layer.provide(Layer.succeed(CommercePortalAuthDatabase, database)),
    );
    const gatewayLive = CommercePortalAuthAccountCreationGatewayLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          CommercePortalAuthAccountCreationProviderLive.pipe(
            Layer.provide(Layer.succeed(CommercePortalAuthInstance, auth)),
          ),
          lookupLive,
          options.replay ? replayLive : Layer.empty,
        ),
      ),
    );
    const gateway = yield* CommercePortalAuthAccountCreationGatewayService.pipe(Effect.provide(gatewayLive));
    const email = `enrollment-verification-send-${randomUUID()}@example.test`;
    const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID());
    const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)(randomUUID());
    const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(randomUUID());
    yield* Effect.addFinalizer(() => database.executor.delete(user).where(eq(user.email, email)).pipe(Effect.orDie));
    const attemptOnce = () =>
      gateway.create({
        email,
        enrollmentAttemptId: attemptId,
        name: 'Verification send account',
        ownerInvocationId,
        password: Redacted.make(PASSWORD),
        tenantId,
      });
    return { attemptOnce, auth, database, deliveredTokens, email, outcome, sends };
  },
);

/** Spends a delivered token through Better Auth's own verify + sign-in path: proof that the link was usable. */
const spendVerificationLink = Effect.fn('CommerceEnrollmentAccountCorrelation.spendVerificationLink')(
  function* spendLink(fixture: Effect.Success<ReturnType<typeof makeVerificationSendFixture>>, token: string) {
    const headers = new Headers({ origin: ORIGIN });
    yield* Effect.promise(
      async () => await fixture.auth.api.verifyEmail({ headers, query: { token }, returnHeaders: true }),
    );
    return yield* Effect.promise(
      async () =>
        await fixture.auth.api.signInEmail({
          body: { email: fixture.email, password: PASSWORD },
          headers,
          returnHeaders: true,
        }),
    );
  },
);

/**
 * LEGACY DIRECT DELIVERY (a deployment that has NOT moved the verification e-mail onto Communications). The first send is simulated
 * as failing after the user row committed. Creation awaits that send, so the outcome is unavailable rather than CREATED, and the
 * retry converges on the already-committed account and reissues it: nothing else records what the earlier send did, so a reissue
 * is the only way such a deployment can complete. The reissued token is proven usable by spending it through Better Auth's own
 * `/verify-email`. A deployment that adopts Communications changes exactly this behaviour: see the replay tests below (#1406).
 */
it.live(
  'legacy direct delivery: reports unavailable when the first send fails, then converges and reissues on retry',
  () =>
    Effect.scoped(
      Effect.gen(function* reportsUnavailableThenReissuesOnRetry() {
        const fixture = yield* makeVerificationSendFixture({ failFirstSend: true, replay: false });

        const firstFailure = yield* Effect.flip(fixture.attemptOnce());
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(firstFailure)).toBe(true);
        expect(fixture.sends.count).toBe(1);
        expect(fixture.deliveredTokens).toStrictEqual([]);

        const [committedRow] = yield* fixture.database.executor
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, fixture.email));
        const committedSubjectId =
          committedRow?.id ?? (yield* Effect.die('The user row did not commit before the send failed'));

        const retried = yield* fixture.attemptOnce();
        expect(retried.providerSubjectId).toBe(committedSubjectId);
        expect(fixture.sends.count).toBe(2);
        expect(fixture.deliveredTokens).toHaveLength(1);
        const token =
          fixture.deliveredTokens.at(0) ?? (yield* Effect.die('The retry reissue delivered no verification token'));
        const signedIn = yield* spendVerificationLink(fixture, token);
        expect(signedIn.response.user.id).toBe(retried.providerSubjectId);
      }),
    ),
);

/**
 * THE NEW TRUTH once the verification e-mail runs through Communications (#1406, AUTH-COM-09). A replay of the SAME owner invocation
 * correlates the previous issuance and its last outcome instead of issuing a fresh link:
 * - nothing was ever submitted for the issuance: the replay is the continuation and issues the link (the only usable one);
 * - the previous message is on its way, accepted, uncertain or continuing under the recovery rule of the SAME intent: the replay
 *   sends nothing and issues nothing, and still reports the committed subject;
 * - the previous message was stopped, or the outcome cannot be established: the replay sends nothing and the creation stays
 *   retryable, because only Auth itself ever issues a new link.
 */
it.live(
  'with Communications: a replay of the same invocation correlates the previous issuance and sends nothing on uncertainty',
  () =>
    Effect.scoped(
      Effect.gen(function* replayCorrelatesThePreviousIssuance() {
        const fixture = yield* makeVerificationSendFixture({ failFirstSend: true, replay: true });

        // the first send fails after the account committed, and Communications never received a request
        const firstFailure = yield* Effect.flip(fixture.attemptOnce());
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(firstFailure)).toBe(true);
        expect(fixture.sends.count).toBe(1);

        // NOT_SUBMITTED: no message can exist, so the replay continues the same operation and the link is usable
        fixture.outcome.current = 'NOT_SUBMITTED';
        const continued = yield* fixture.attemptOnce();
        expect(fixture.sends.count).toBe(2);
        const token =
          fixture.deliveredTokens.at(0) ?? (yield* Effect.die('The continuation delivered no verification token'));
        expect((yield* spendVerificationLink(fixture, token)).response.user.id).toBe(continued.providerSubjectId);

        // an uncertain, accepted, in-progress or continuing previous message: nothing new is sent or issued, the subject is reported
        for (const outcome of ['UNCERTAIN', 'ACCEPTED', 'IN_PROGRESS', 'NON_ACCEPTANCE_PROVEN'] as const) {
          fixture.outcome.current = outcome;
          const replayed = yield* fixture.attemptOnce();
          expect(replayed.providerSubjectId).toBe(continued.providerSubjectId);
          expect(fixture.sends.count).toBe(2);
        }

        // a stopped previous message and an unreadable outcome both send nothing and leave the creation retryable
        for (const outcome of ['STOPPED', 'OUTCOME_UNAVAILABLE'] as const) {
          fixture.outcome.current = outcome;
          const refused = yield* Effect.flip(fixture.attemptOnce());
          expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(refused)).toBe(true);
          expect(fixture.sends.count).toBe(2);
        }
        expect(fixture.deliveredTokens).toHaveLength(1);
      }),
    ),
);

/**
 * A creation that never committed leaves no correlation. The unique correlation index is
 * authoritative for that absence, so this must resolve FAILED/reclaimable rather than stay
 * indeterminate: an Attempt with no subject and no correlation row proves no account exists yet.
 */
it.live('resolves an invocation the provider never correlated to a reclaimable failure', () =>
  Effect.scoped(
    Effect.gen(function* resolvesToReclaimableFailure() {
      const fixture = yield* makeCorrelationFixture('never-committed');
      const uncorrelated = Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID());

      expect(yield* correlationRows(fixture)).toStrictEqual([]);
      const resolution = yield* reconcileFor(fixture, uncorrelated);
      expect(resolution.status).toBe('FAILED');
      expect(resolution.failureCode).toBe('provider_account_not_found');
      expect(resolution.outcomeCode).toBe('provider_account_absent');
    }),
  ),
);

/**
 * A process that commits the durable claim and exits before ever calling `signUpEmail` leaves an
 * `IN_PROGRESS` operation with no subject and no correlation. Once its lease expires, the fix must
 * let the very same owner invocation be reclaimed and dispatched again — never a second account.
 */
it.live('re-dispatches the account-creation transition after a claim-only crash and creates the account once', () =>
  Effect.scoped(
    Effect.gen(function* redispatchesAfterClaimOnlyCrash() {
      const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(randomUUID());
      const owningActorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)(randomUUID());
      const acceptance = yield* makeEnrollmentAcceptanceFixture({ tenantId }, ENROLLMENT_TEST_COMPOSITION_REVISION);
      const attempt = yield* startEnrollmentAcceptanceAttempt(acceptance, {
        actionInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID()),
        actorPrincipalId: owningActorPrincipalId,
        compositionRevision: ENROLLMENT_TEST_COMPOSITION_REVISION,
        intentDigest: Schema.decodeSync(EnrollmentDigestSchema)('a'.repeat(64)),
        intentKey,
        journey: 'RETAIL_SELF_ENROLLMENT',
        tenantId,
      });

      const provider = yield* makeCorrelationFixture('redispatch');
      const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID());
      const requestDigest = 'c'.repeat(64);
      const transition = Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
        actorPrincipalId: owningActorPrincipalId,
        compositionRevision: attempt.compositionRevision,
        correlationId: `commerce-enrollment-owner:${ownerInvocationId}`,
        expectedRevision: attempt.revision,
        ownerInvocationId,
        ownerModuleKey: 'commerce.portal-auth',
        portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
        requestDigest,
        tenantId,
        transitionKey: 'provider.account.create',
      });

      // The crash: the durable claim commits, but the provider is never called and nothing records.
      yield* acceptance.ownerStore.claimTransition(
        Schema.decodeSync(ClaimEnrollmentTransitionInputSchema)({
          actorPrincipalId: owningActorPrincipalId,
          expectedRevision: transition.expectedRevision,
          leaseDurationMs: 1000,
          ownerInvocationId,
          ownerModuleKey: 'commerce.portal-auth',
          portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
          requestDigest,
          required: true,
          tenantId,
          transitionKey: 'provider.account.create',
          workerId: 'crashed-worker',
        }),
      );
      yield* expireEnrollmentAcceptanceLeases(acceptance, attempt.portalEnrollmentAttemptId);

      const owner: CommerceEnrollmentOwnerEffect = {
        dispatch: (input) =>
          provider.gateway
            .create({
              email: provider.email,
              enrollmentAttemptId: input.portalEnrollmentAttemptId,
              name: 'Redispatch integration account',
              ownerInvocationId: input.ownerInvocationId,
              password: Redacted.make(PASSWORD),
              tenantId: input.tenantId,
            })
            .pipe(
              Effect.map((result) => ({
                accountSubject: Schema.decodeSync(CommercePortalAccountSubjectSchema)({
                  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
                  providerSubjectId: result.providerSubjectId,
                  subjectType: 'user' as const,
                }),
                outcomeCode: Schema.decodeSync(EnrollmentKeySchema)('provider_account_created'),
                // The raw gateway carries no evidence receipt; the created subject id is itself
                // a valid, distinct reference for this outcome's schema.
                resultReference: Schema.decodeSync(EnrollmentResourceIdSchema)(result.providerSubjectId),
                status: 'SUCCEEDED' as const,
              })),
              Effect.mapError((failure) =>
                Schema.is(CommercePortalAuthAccountCreationRejected)(failure)
                  ? ownerRejected('provider_account_rejected', failure.reason, failure)
                  : ownerUnavailable('provider_account_unavailable', failure.reason, failure),
              ),
            ),
        // Exactly the composition's own reconciliation, driven by the fixed `providerObservationFor`.
        reconcile: commerceEnrollmentPortalAuthOwnerReconciliationForLookup((input) =>
          providerObservationFor(attempt, provider.lookup, input.ownerInvocationId),
        ).reconcile,
      };
      const driver = commerceEnrollmentOwnerTransitionDriverFor({ attempt: acceptance.ownerStore, owner });

      // The claim above advanced the Attempt's revision past the one captured before it.
      const beforeReconcile = yield* readEnrollmentAcceptanceAttempt(acceptance, attempt.portalEnrollmentAttemptId);

      // Without the fix this fails outright (Indeterminate) instead of recording a reclaimable FAILED.
      const reconciled = yield* driver.reconcile({ ...transition, expectedRevision: beforeReconcile.revision });
      expect(reconciled.outcome).toBe('RECORDED');
      if (reconciled.outcome === 'RECORDED') {
        expect(reconciled.resolution.status).toBe('FAILED');
        expect(reconciled.resolution.failureCode).toBe('provider_account_not_found');
      }

      const afterReconcile = yield* readEnrollmentAcceptanceAttempt(acceptance, attempt.portalEnrollmentAttemptId);
      const redispatched = yield* driver.execute({ ...transition, expectedRevision: afterReconcile.revision });
      expect(redispatched.outcome).toBe('RECORDED');
      if (redispatched.outcome === 'RECORDED') {
        expect(redispatched.ownerOutcome.status).toBe('SUCCEEDED');
      }

      const operations = yield* readEnrollmentAcceptanceOperations(acceptance, attempt.portalEnrollmentAttemptId);
      expect(operations.at(-1)?.status).toBe('SUCCEEDED');

      // The same owner invocation created exactly one account: the crash-then-retry never doubled it.
      expect(yield* usersWithEmail(provider)).toHaveLength(1);
    }),
  ),
);
