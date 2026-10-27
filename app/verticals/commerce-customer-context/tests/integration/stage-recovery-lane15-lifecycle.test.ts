import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { NodeServices } from '@effect/platform-node';
import { and, eq, sql } from 'drizzle-orm';
import { Config, Effect, Exit, Layer, Option, Redacted, Ref, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import {
  CommercePortalAuthAccountCreationGatewayLive,
  CommercePortalAuthAccountCreationGatewayService,
  CommercePortalAuthAccountCreationProviderLive,
  CommercePortalAuthAccountLookupService,
} from '../../api/portal-auth/provider/account-create.ts';
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
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../../src/enrollment/attempts/errors.ts';
import {
  commerceEnrollmentOwnerTransitionDriverFor,
  CommerceEnrollmentOwnerTransitionSchema,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerAttemptStore,
  CommerceEnrollmentOwnerEffect,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import { CommerceEnrollmentOwnerEffectIndeterminate } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import { ownerUnavailable } from '../../src/enrollment/orchestration/owner-effect-codec.ts';
import { providerObservationFor } from '../../src/enrollment/orchestration/owner-transition-composition.ts';
import { commerceEnrollmentPortalAuthOwnerReconciliationForLookup } from '../../src/enrollment/orchestration/provider-owner-effect.ts';
import {
  commerceEnrollmentDueAttemptStoreForRun,
  commerceEnrollmentOwnerAttemptStoreForRun,
} from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { CommercePortalAuthAccountLookupLive } from '../../src/portal-auth/persistence/portal-auth-account-lookup.ts';
import {
  CommercePortalAuthDatabase,
  makeCommercePortalAuthDatabase,
} from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { user } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { portalEnrollmentAttempts, portalEnrollmentOwnerOperations } from '../../src/database/schema.ts';
import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  backdateEnrollmentAcceptanceAttempt,
  expireEnrollmentAcceptanceLeases,
  makeEnrollmentAcceptanceFixture,
  readEnrollmentAcceptanceAttempt,
  readEnrollmentAcceptanceOperations,
  startEnrollmentAcceptanceAttempt,
} from '../support/enrollment-acceptance-fixture.ts';
import { enrollmentApplicationCompositionRevision } from '../support/enrollment-application-composition.ts';

// Existing native integration entrypoint and fixture pool ownership. Nothing is added to product.
// "Reassembly" below discards services but is NOT a production host/process restart claim.
const key = (value: string) => Schema.decodeSync(EnrollmentKeySchema)(value);
const fault = () =>
  new CommerceEnrollmentOwnerEffectIndeterminate({
    code: 'lane15_lost_reply',
    reason: 'Lane 15 discarded the provider reply after its committed account insert',
  });
const ChildInputSchema = Schema.Struct({
  mode: Schema.Literals(['claim', 'discover']),
  transition: CommerceEnrollmentOwnerTransitionSchema,
});
const ChildReceiptSchema = Schema.Struct({
  attemptIds: Schema.Array(EnrollmentAttemptIdSchema),
  phase: Schema.Literals(['claimed', 'discovered']),
  pid: Schema.Number,
});

const makeScenario = Effect.fn('Lane15.makeScenario')(function* makeScenario() {
  // The existing fixture loader falls back to its configured file. Never let this proof read .env.
  expect(APP_ENV_PATH).toBe('/dev/null');
  const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(randomUUID());
  const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)(randomUUID());
  const compositionRevision = yield* enrollmentApplicationCompositionRevision;
  const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId }, compositionRevision);
  const startInput = {
    actionInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID()),
    actorPrincipalId,
    compositionRevision,
    intentDigest: Schema.decodeSync(EnrollmentDigestSchema)('a'.repeat(64)),
    intentKey: key(`lane15-${randomUUID()}`),
    journey: 'RETAIL_SELF_ENROLLMENT' as const,
    tenantId,
  };
  const attempt = yield* startEnrollmentAcceptanceAttempt(fixture, startInput);
  const transition = Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId,
    compositionRevision,
    correlationId: `lane15-${randomUUID()}`,
    expectedRevision: attempt.revision,
    ownerInvocationId: randomUUID(),
    ownerModuleKey: 'commerce.portal-auth',
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    requestDigest: 'b'.repeat(64),
    tenantId,
    transitionKey: 'provider.account.create',
  });
  const url = yield* Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
    Config.orElse(() => Config.Redacted('DATABASE_URL')),
  );
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(url),
    COMMERCE_PORTAL_AUTH_SECRET: 'c'.repeat(64),
    COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test',
  });
  const database = yield* acquireOutlivingCleanup(makeCommercePortalAuthDatabase(configuration));
  const auth = yield* makeCommercePortalAuth({
    configuration,
    databaseAdapter: database.adapter,
    // Existing realm transport seam only. Account creation/correlation/readback are native.
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
        lookupLive,
        CommercePortalAuthAccountCreationProviderLive.pipe(
          Layer.provide(Layer.succeed(CommercePortalAuthInstance, auth)),
        ),
      ),
    ),
  );
  const { gateway, lookup } = yield* Effect.all({
    gateway: CommercePortalAuthAccountCreationGatewayService,
    lookup: CommercePortalAuthAccountLookupService,
  }).pipe(Effect.provide(Layer.mergeAll(gatewayLive, lookupLive)));
  const email = `lane15-${randomUUID()}@example.test`;
  const removeAccount = database.executor.delete(user).where(eq(user.email, email));
  yield* Effect.addFinalizer(() => removeAccount.pipe(Effect.orDie));
  const dispatches = yield* Ref.make(0);
  const dispatch: CommerceEnrollmentOwnerEffect['dispatch'] = (input) =>
    Ref.update(dispatches, (calls) => calls + 1).pipe(
      Effect.andThen(
        gateway.create({
          email,
          enrollmentAttemptId: input.portalEnrollmentAttemptId,
          name: 'Lane 15 lifecycle account',
          ownerInvocationId: input.ownerInvocationId,
          password: Redacted.make('Lane15-fixture-password-only-9'),
          tenantId: input.tenantId,
        }),
      ),
      Effect.map((created) => ({
        accountSubject: Schema.decodeSync(CommercePortalAccountSubjectSchema)({
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          providerSubjectId: created.providerSubjectId,
          subjectType: 'user',
        }),
        outcomeCode: key('provider_account_created'),
        resultReference: Schema.decodeSync(EnrollmentResourceIdSchema)(created.providerSubjectId),
        status: 'SUCCEEDED' as const,
      })),
      Effect.mapError((cause) => ownerUnavailable('lane15_provider_unavailable', cause.reason, cause)),
    );
  const owner: CommerceEnrollmentOwnerEffect = {
    dispatch,
    reconcile: commerceEnrollmentPortalAuthOwnerReconciliationForLookup((input) =>
      providerObservationFor(attempt, lookup, input.ownerInvocationId),
    ).reconcile,
  };
  const accounts = database.executor
    .select({ id: user.id, invocation: user.enrollmentOwnerInvocationId })
    .from(user)
    .where(eq(user.email, email));
  const refreshed = readEnrollmentAcceptanceAttempt(fixture, attempt.portalEnrollmentAttemptId).pipe(
    Effect.map((row) => ({ ...transition, expectedRevision: row.revision })),
  );
  const reassemble = (effect: CommerceEnrollmentOwnerEffect = owner) =>
    commerceEnrollmentOwnerTransitionDriverFor({
      attempt: commerceEnrollmentOwnerAttemptStoreForRun(fixture.scope, fixture.run),
      leaseDurationMs: 60_000,
      owner: effect,
    });
  return {
    accounts,
    attempt,
    dispatches,
    fixture,
    owner,
    reassemble,
    refreshed,
    removeAccount,
    startInput,
    transition,
  };
});

it.live('lane15 positive control journals a native owner result and replays without another dispatch', () =>
  Effect.scoped(
    Effect.gen(function* positiveControl() {
      const scenario = yield* makeScenario();
      const recorded = yield* scenario.reassemble().execute(scenario.transition);
      expect(recorded.outcome).toBe('RECORDED');
      const accounts = yield* scenario.accounts;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.invocation).toBe(scenario.transition.ownerInvocationId);
      expect((yield* scenario.reassemble().execute(yield* scenario.refreshed)).outcome).toBe('REPLAYED');
      expect(yield* Ref.get(scenario.dispatches)).toBe(1);
      expect(yield* scenario.accounts).toEqual(accounts);
    }).pipe(Effect.timeout('20 seconds')),
  ),
);

for (const boundary of ['lost-response', 'record-failure'] as const) {
  it.live(`lane15 ${boundary} retains one native effect, excludes a live lease and settles after closure`, () =>
    Effect.scoped(
      Effect.gen(function* committedOwnerCrash() {
        const scenario = yield* makeScenario();
        const { fixture, transition } = scenario;
        const brokenRecord: CommerceEnrollmentOwnerAttemptStore = {
          ...fixture.ownerStore,
          recordOutcome: () =>
            Effect.fail(
              new CommerceEnrollmentAttemptUnavailable({
                code: 'attempt_unavailable',
                reason: 'Lane 15 failed the record phase before its transaction',
                retryable: true,
              }),
            ),
        };
        const driver = commerceEnrollmentOwnerTransitionDriverFor({
          attempt: boundary === 'record-failure' ? brokenRecord : fixture.ownerStore,
          leaseDurationMs: 60_000,
          owner:
            boundary === 'lost-response'
              ? {
                  ...scenario.owner,
                  dispatch: (input) => scenario.owner.dispatch(input).pipe(Effect.andThen(Effect.fail(fault()))),
                }
              : scenario.owner,
        });
        expect(Exit.isFailure(yield* driver.execute(transition).pipe(Effect.exit))).toBe(true);
        const committed = yield* scenario.accounts;
        expect(committed).toHaveLength(1);
        expect(yield* readEnrollmentAcceptanceOperations(fixture, transition.portalEnrollmentAttemptId)).toMatchObject([
          { result_reference: null, status: 'IN_PROGRESS' },
        ]);
        // Both controls must refuse owner work while the original lease is live.
        expect((yield* scenario.reassemble().execute(yield* scenario.refreshed)).outcome).toBe('LEASE_HELD');
        expect(
          Exit.isFailure(
            yield* scenario
              .reassemble()
              .reconcile(yield* scenario.refreshed)
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(yield* Ref.get(scenario.dispatches)).toBe(1);

        // Test-owned expiry, never a production lease repair. Owner readback still decides success.
        yield* expireEnrollmentAcceptanceLeases(fixture, transition.portalEnrollmentAttemptId);
        yield* backdateEnrollmentAcceptanceAttempt(
          fixture,
          transition.portalEnrollmentAttemptId,
          '2001-01-01T00:00:00Z',
        );
        yield* fixture.admin.execute(
          sql`update core.application_composition_authority set durable_work_admission = 'closed'
              where authority_key = 'active' and revision = ${fixture.compositionRevision}`,
          'objects',
        );
        const denied = yield* startEnrollmentAcceptanceAttempt(fixture, {
          ...scenario.startInput,
          actionInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID()),
          intentKey: key(`lane15-denied-${randomUUID()}`),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(denied)).toBe(true);
        expect(
          yield* fixture.admin
            .select()
            .from(portalEnrollmentAttempts)
            .where(eq(portalEnrollmentAttempts.tenantId, fixture.scope.tenantId)),
        ).toHaveLength(1);
        // Fresh durable discovery has no request or cached attempt list. This is not a host restart.
        const due = commerceEnrollmentDueAttemptStoreForRun(fixture.runWorker);
        const query = { after: Option.none(), limit: 500, maxSweeps: 3, staleAfterMillis: 0 };
        expect(
          (yield* due.listDue(query))
            .filter((row) => row.tenantId === fixture.scope.tenantId)
            .map((row) => row.portalEnrollmentAttemptId),
        ).toEqual([transition.portalEnrollmentAttemptId]);
        expect(
          Exit.isFailure(
            yield* commerceEnrollmentDueAttemptStoreForRun(fixture.runRequestScoped).listDue(query).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect((yield* scenario.reassemble().reconcile(yield* scenario.refreshed)).outcome).toBe('RECORDED');
        expect(yield* readEnrollmentAcceptanceOperations(fixture, transition.portalEnrollmentAttemptId)).toMatchObject([
          { result_reference: transition.portalEnrollmentAttemptId, status: 'SUCCEEDED' },
        ]);
        const reconciledAttempt = yield* fixture.ownerStore.read({
          portalEnrollmentAttemptId: transition.portalEnrollmentAttemptId,
          tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(fixture.scope.tenantId),
        });
        expect(reconciledAttempt.accountSubject?.providerSubjectId).toBe(committed[0]?.id);
        expect((yield* scenario.reassemble().execute(yield* scenario.refreshed)).outcome).toBe('REPLAYED');
        expect(yield* Ref.get(scenario.dispatches)).toBe(1);
        expect(yield* scenario.accounts).toEqual(committed);
      }).pipe(Effect.timeout('20 seconds')),
    ),
  );
}

it.live('lane15 claim-only crash does not create an account until authoritative absence permits dispatch', () =>
  Effect.scoped(
    Effect.gen(function* claimOnlyCrash() {
      const scenario = yield* makeScenario();
      const { fixture, transition } = scenario;
      yield* fixture.ownerStore.claimTransition(
        Schema.decodeSync(ClaimEnrollmentTransitionInputSchema)({
          actorPrincipalId: transition.actorPrincipalId,
          expectedRevision: transition.expectedRevision,
          leaseDurationMs: 60_000,
          ownerInvocationId: transition.ownerInvocationId,
          ownerModuleKey: transition.ownerModuleKey,
          portalEnrollmentAttemptId: transition.portalEnrollmentAttemptId,
          requestDigest: transition.requestDigest,
          required: true,
          tenantId: transition.tenantId,
          transitionKey: transition.transitionKey,
          workerId: key('lane15-crashed-before-dispatch'),
        }),
      );
      expect(yield* scenario.accounts).toEqual([]);
      expect(yield* Ref.get(scenario.dispatches)).toBe(0);
      yield* expireEnrollmentAcceptanceLeases(fixture, transition.portalEnrollmentAttemptId);
      const reconciled = yield* scenario.reassemble().reconcile(yield* scenario.refreshed);
      expect(reconciled.outcome).toBe('RECORDED');
      if (reconciled.outcome === 'RECORDED') {
        expect(reconciled.resolution).toMatchObject({ failureCode: 'provider_account_not_found', status: 'FAILED' });
      }
      expect(yield* scenario.accounts).toEqual([]);
      expect((yield* scenario.reassemble().execute(yield* scenario.refreshed)).outcome).toBe('RECORDED');
      expect(yield* scenario.accounts).toHaveLength(1);
      expect(yield* Ref.get(scenario.dispatches)).toBe(1);
    }).pipe(Effect.timeout('20 seconds')),
  ),
);

it.live('lane15 kills a post-commit claimant and discovers its journal in a second native process', () =>
  Effect.scoped(
    Effect.gen(function* actualProcessRestart() {
      const scenario = yield* makeScenario();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const childPath = fileURLToPath(new URL('../support/stage-recovery-lane15-discovery.mts', import.meta.url));
      const claimInput = yield* Schema.encodeEffect(Schema.fromJsonString(ChildInputSchema))({
        mode: 'claim',
        transition: scenario.transition,
      });
      const command = (input: string) =>
        ChildProcess.make(process.execPath, [childPath, input], {
          env: { APP_ENV_PATH: '/dev/null' },
          extendEnv: true,
          forceKillAfter: '2 seconds',
          stderr: 'inherit',
          stdin: 'ignore',
          stdout: 'pipe',
        });
      const claimant = yield* spawner.spawn(command(claimInput));
      const firstLine = yield* Effect.gen(function* readCommittedClaimReceipt() {
        return yield* claimant.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
      }).pipe(Effect.timeout('8 seconds'));
      const receipt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ChildReceiptSchema))(
        Option.getOrNull(firstLine),
      );
      expect(receipt).toMatchObject({
        attemptIds: [scenario.transition.portalEnrollmentAttemptId],
        phase: 'claimed',
        pid: Number(claimant.pid),
      });
      // Receipt is emitted only after claimTransition's native transaction returns.
      expect(
        yield* readEnrollmentAcceptanceOperations(scenario.fixture, scenario.transition.portalEnrollmentAttemptId),
      ).toMatchObject([{ status: 'IN_PROGRESS' }]);
      yield* claimant.kill({ killSignal: 'SIGKILL' });
      // The native spawner represents signal termination as a typed failure, not an exit code.
      expect(Exit.isFailure(yield* claimant.exitCode.pipe(Effect.exit))).toBe(true);
      expect(yield* claimant.isRunning).toBe(false);
      expect(yield* scenario.accounts).toEqual([]);
      expect(yield* Ref.get(scenario.dispatches)).toBe(0);
      yield* expireEnrollmentAcceptanceLeases(scenario.fixture, scenario.transition.portalEnrollmentAttemptId);
      yield* backdateEnrollmentAcceptanceAttempt(
        scenario.fixture,
        scenario.transition.portalEnrollmentAttemptId,
        '2001-01-01T00:00:00Z',
      );
      const discoveryInput = yield* Schema.encodeEffect(Schema.fromJsonString(ChildInputSchema))({
        mode: 'discover',
        transition: scenario.transition,
      });
      const replacement = yield* spawner.spawn(command(discoveryInput));
      const [status, output] = yield* Effect.all(
        [replacement.exitCode, replacement.stdout.pipe(Stream.decodeText(), Stream.mkString)],
        { concurrency: 'unbounded' },
      ).pipe(Effect.timeout('8 seconds'));
      expect(Number(status)).toBe(0);
      const discovery = yield* Schema.decodeEffect(Schema.fromJsonString(ChildReceiptSchema))(output.trim());
      expect(discovery.pid).not.toBe(receipt.pid);
      expect(discovery).toMatchObject({
        attemptIds: [scenario.transition.portalEnrollmentAttemptId],
        phase: 'discovered',
      });
      expect(yield* replacement.isRunning).toBe(false);
      // Discovery alone cannot settle an unknown owner result or manufacture an account.
      expect(yield* scenario.accounts).toEqual([]);
      expect(yield* Ref.get(scenario.dispatches)).toBe(0);
      expect((yield* scenario.reassemble().reconcile(yield* scenario.refreshed)).outcome).toBe('RECORDED');
      expect((yield* scenario.reassemble().execute(yield* scenario.refreshed)).outcome).toBe('RECORDED');
      expect(yield* scenario.accounts).toHaveLength(1);
      expect(yield* Ref.get(scenario.dispatches)).toBe(1);
    }).pipe(Effect.timeout('25 seconds')),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live('lane15 unknown readback fails closed, isolates tenants and cleans only owned rows twice', () =>
  Effect.scoped(
    Effect.gen(function* unknownControlAndCleanup() {
      const scenario = yield* makeScenario();
      const { fixture, transition } = scenario;
      const lostReply: CommerceEnrollmentOwnerEffect = {
        ...scenario.owner,
        dispatch: (input) => scenario.owner.dispatch(input).pipe(Effect.andThen(Effect.fail(fault()))),
      };
      expect(Exit.isFailure(yield* scenario.reassemble(lostReply).execute(transition).pipe(Effect.exit))).toBe(true);
      yield* expireEnrollmentAcceptanceLeases(fixture, transition.portalEnrollmentAttemptId);
      const unknown: CommerceEnrollmentOwnerEffect = {
        ...scenario.owner,
        reconcile: () => Effect.fail(fault()),
      };
      expect(
        Exit.isFailure(
          yield* scenario
            .reassemble(unknown)
            .reconcile(yield* scenario.refreshed)
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      const rows = yield* readEnrollmentAcceptanceOperations(fixture, transition.portalEnrollmentAttemptId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).not.toBe('SUCCEEDED');
      expect(rows[0]?.result_reference).toBeNull();
      expect(
        Exit.isFailure(
          yield* scenario
            .reassemble()
            .execute(yield* scenario.refreshed)
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(yield* Ref.get(scenario.dispatches)).toBe(1);
      expect(yield* scenario.accounts).toHaveLength(1);
      const otherTenant = Schema.decodeSync(EnrollmentTenantIdSchema)(randomUUID());
      const foreign = yield* makeEnrollmentAcceptanceFixture({ tenantId: otherTenant }, fixture.compositionRevision);
      const foreignAttempt = yield* startEnrollmentAcceptanceAttempt(foreign, {
        ...scenario.startInput,
        actionInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID()),
        tenantId: otherTenant,
      });
      expect(
        Exit.isFailure(
          yield* foreign.ownerStore
            .read({
              portalEnrollmentAttemptId: transition.portalEnrollmentAttemptId,
              tenantId: transition.tenantId,
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      // Recover the original invocation from native provider readback, then prove bounded cleanup.
      expect((yield* scenario.reassemble().reconcile(yield* scenario.refreshed)).outcome).toBe('RECORDED');
      yield* Effect.suspend(fixture.cleanup).pipe(Effect.timeout('5 seconds'));
      yield* Effect.suspend(fixture.cleanup).pipe(Effect.timeout('5 seconds'));
      yield* scenario.removeAccount;
      yield* scenario.removeAccount;
      expect(yield* scenario.accounts).toEqual([]);
      expect(
        yield* fixture.admin
          .select()
          .from(portalEnrollmentOwnerOperations)
          .where(eq(portalEnrollmentOwnerOperations.tenantId, fixture.scope.tenantId)),
      ).toEqual([]);
      expect(
        yield* fixture.admin
          .select()
          .from(portalEnrollmentAttempts)
          .where(eq(portalEnrollmentAttempts.tenantId, fixture.scope.tenantId)),
      ).toEqual([]);
      expect(
        yield* foreign.admin
          .select()
          .from(portalEnrollmentAttempts)
          .where(
            and(
              eq(portalEnrollmentAttempts.tenantId, otherTenant),
              eq(portalEnrollmentAttempts.portalEnrollmentAttemptId, foreignAttempt.portalEnrollmentAttemptId),
            ),
          ),
      ).toHaveLength(1);
      const attemptPattern = `enrollment-attempt:${fixture.scope.tenantId}:%`;
      const operationPattern = `enrollment-operation:${fixture.scope.tenantId}:%`;
      expect(
        yield* fixture.admin.execute(
          sql`select work_id from core.application_composition_durable_work
            where owner_module_key = 'commerce.customer-context'
              and (work_id like ${attemptPattern} or work_id like ${operationPattern})`,
          'objects',
        ),
      ).toEqual([]);
    }).pipe(Effect.timeout('25 seconds')),
  ),
);
