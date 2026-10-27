import { createHash } from 'node:crypto';

import {
  ActiveApplicationCompositionUnavailableError,
  OntosModuleDeploymentContractSchema,
  canonicalizeApplicationComposition,
} from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Layer, Option, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import type { EnrollmentAttemptScopedRoutineInvoker } from '../../src/enrollment/attempts/attempt-persistence.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../../src/enrollment/attempts/errors.ts';
import {
  CommerceEnrollmentContinuation,
  CommerceEnrollmentContinuationLive,
} from '../../src/enrollment/continuation/enrollment-continuation.ts';
import { CommerceEnrollmentOwnerEffectRegistry } from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import type { CommerceEnrollmentOwnerTransactionRunnerService } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { CommerceEnrollmentPreparationSubjectResolver } from '../../src/enrollment/orchestration/preparation-subject.ts';
import {
  EnrollmentAttemptIdSchema,
  EnrollmentTenantIdSchema,
  ReconcileEnrollmentResolutionSchema,
} from '../../shared/enrollment-contracts.ts';
import type {
  EnrollmentAttemptState,
  EnrollmentOwnerOperationStatusSchema,
} from '../../shared/enrollment-contracts.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

const appId = 'commerce-customer-context';
const buildMarker = 'continuation-release-a';
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('20000000-0000-4000-8000-000000000001');
const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const attemptInput = { portalEnrollmentAttemptId: attemptId, tenantId };
const dueInput = { after: Option.none(), limit: 10, maxSweeps: 8, staleAfterMillis: 1000 };
const sweepInput = (compositionRevision: string) => ({
  ...attemptInput,
  claimTtlMillis: 30_000,
  compositionRevision,
  maxSweeps: 8,
  revision: 1,
});

const attemptRow = (compositionRevision: string, state: EnrollmentAttemptState) => ({
  attempt_outcome: 'FOUND',
  authentication_namespace_id: null,
  completed_at: null,
  composition_revision: compositionRevision,
  created_at: '2026-09-17T10:00:00.000Z',
  created_by_principal_id: '40000000-0000-4000-8000-000000000001',
  failure_code: null,
  failure_reason: null,
  intent_digest: 'a'.repeat(64),
  intent_key: 'continuation-release-test',
  invitation_id: null,
  journey: 'RETAIL_SELF_ENROLLMENT',
  last_failure_code: null,
  last_failure_reason: null,
  last_owner_invocation_id: null,
  lease_expires_at: null,
  lease_owner: null,
  lease_token: null,
  operation_actor_principal_id: null,
  operation_id: null,
  operation_lease_expires_at: null,
  operation_lease_owner: null,
  operation_lease_token: null,
  operation_revision: null,
  operation_status: null,
  outcome_code: null,
  owner_invocation_id: null,
  owner_module_key: null,
  portal_enrollment_attempt_id: attemptId,
  provider_subject_id: null,
  reconciliation_ref: null,
  request_digest: null,
  required: null,
  result_digest: null,
  result_reference: null,
  revision: 1,
  state,
  subject_type: null,
  target_legal_entity_id: null,
  target_resource_id: null,
  tenant_id: tenantId,
  terminated_at: null,
  transition_key: null,
  updated_at: '2026-09-17T10:00:00.000Z',
});

const harness = Effect.fnUntraced(function* makeReleaseAdmissionHarness(
  initial: Option.Option<ActiveApplicationCompositionSnapshot>,
  compiled: Readonly<{ appId: string; buildMarker: string }>,
  persistedRevision: string,
  persistedState: 'COMPLETE' | 'IN_PROGRESS' | 'VERIFICATION_REQUIRED' = 'IN_PROGRESS',
  afterClaim?: Effect.Effect<void>,
  readmissionRevision?: string,
) {
  const source = yield* Ref.make(initial);
  let admittedRevision = persistedRevision;
  const dueRows = yield* Ref.make<readonly object[]>([]);
  const routines: string[] = [];
  const worker: string[] = [];
  const claimRevisions: unknown[] = [];
  const durableClaims: object[] = [];
  const calls = { claimRevisions, durableClaims, loads: 0, owner: 0, registry: 0, routines, subject: 0, worker };
  const invoke: EnrollmentAttemptScopedRoutineInvoker['invoke'] = (routine, values) =>
    Effect.gen(function* invokeOwnerRoutine() {
      calls.routines.push(routine.name);
      if (routine.name === 'admit_portal_enrollment_attempt') {
        const admitted = values.at(1) === readmissionRevision;
        if (admitted && readmissionRevision !== undefined) {
          admittedRevision = readmissionRevision;
        }
        return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([{ admitted }]);
      }
      if (routine.name === 'claim_portal_enrollment_transition' && afterClaim !== undefined) {
        const leaseToken = '60000000-0000-4000-8000-000000000001';
        const claim = {
          ...attemptRow(admittedRevision, persistedState),
          attempt_outcome: 'CLAIMED',
          lease_expires_at: '2099-09-17T10:00:00.000Z',
          lease_owner: values.at(2),
          lease_token: leaseToken,
          operation_actor_principal_id: values.at(7),
          operation_id: '50000000-0000-4000-8000-000000000001',
          operation_lease_expires_at: '2099-09-17T10:00:00.000Z',
          operation_lease_owner: values.at(2),
          operation_lease_token: leaseToken,
          operation_revision: 1,
          operation_status: 'IN_PROGRESS',
          owner_invocation_id: values.at(5),
          owner_module_key: values.at(3),
          request_digest: values.at(6),
          required: true,
          revision: 2,
          transition_key: values.at(4),
        };
        calls.durableClaims.push(claim);
        yield* afterClaim;
        return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([claim]);
      }
      if (
        persistedState === 'VERIFICATION_REQUIRED' &&
        routine.name === 'read_portal_enrollment_owner_operation' &&
        values.at(2) === 'provider.account.create'
      ) {
        const row = attemptRow(admittedRevision, persistedState);
        return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
          {
            ...row,
            actor_principal_id: row.created_by_principal_id,
            operation_outcome: 'FOUND',
            owner_invocation_id: '50000000-0000-4000-8000-000000000002',
            owner_module_key: 'commerce.portal-auth',
            portal_enrollment_owner_operation_id: '50000000-0000-4000-8000-000000000001',
            request_digest: 'a'.repeat(64),
            required: true,
            revision: 2,
            status: 'SUCCEEDED',
            transition_key: 'provider.account.create',
          },
        ]);
      }
      const rows =
        routine.name === 'read_portal_enrollment_attempt' ? [attemptRow(admittedRevision, persistedState)] : [];
      return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(rows);
    });
  const dialect = new PgDialect();
  const runner: CommerceEnrollmentOwnerTransactionRunnerService = {
    run: (_scope, operation) => operation({ invoke }),
    runWorker: (operation) =>
      operation((statement) =>
        Effect.gen(function* executeWorkerStatement() {
          const query = dialect.sqlToQuery(statement);
          calls.worker.push(query.sql);
          if (query.sql.includes('claim_portal_enrollment_sweep')) {
            calls.claimRevisions.push(query.params.at(-1));
            return [{ sweep_count: 1 }];
          }
          return yield* Ref.get(dueRows);
        }),
      ),
  };
  const registeredOwner = {
    dispatch: Option.some({
      effect: () =>
        Effect.sync(() => {
          calls.owner += 1;
          return { status: 'SUCCEEDED' as const };
        }),
      requestDigest: 'a'.repeat(64),
    }),
    reconcile: () => Effect.die('No reconciliation should run in the release admission tests'),
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(ActiveApplicationCompositionService, {
      load: Effect.sync(() => {
        calls.loads += 1;
      }).pipe(
        Effect.andThen(Ref.get(source)),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ActiveApplicationCompositionUnavailableError({
                  cause: 'No approved release has been published',
                  reason: 'The release source is missing',
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ),
    }),
    Layer.succeed(CommerceEnrollmentOwnerTransactionRunner, runner),
    Layer.succeed(CommerceEnrollmentOwnerEffectRegistry, {
      resolve: () =>
        Effect.sync(() => {
          calls.registry += 1;
          return Option.some(registeredOwner);
        }),
      verificationRequired: () => Effect.succeed(persistedState === 'VERIFICATION_REQUIRED'),
    }),
    Layer.succeed(CommerceEnrollmentPreparationSubjectResolver, {
      resolve: () =>
        Effect.suspend(() => {
          calls.subject += 1;
          return Effect.die('No subject should resolve before release admission');
        }),
    }),
  );
  return {
    calls,
    layer: CommerceEnrollmentContinuationLive(compiled).pipe(Layer.provide(dependencies)),
    setDueRevision: (compositionRevision: string) =>
      Ref.set(dueRows, [
        {
          composition_revision: compositionRevision,
          portal_enrollment_attempt_id: '20000000-0000-4000-8000-000000000002',
          revision: 1,
          state: 'IN_PROGRESS',
          tenant_id: tenantId,
          updated_at: '2026-09-17T10:00:00.000Z',
        },
      ]),
    setSource: (snapshot: ActiveApplicationCompositionSnapshot) => Ref.set(source, Option.some(snapshot)),
  };
});

const renew = (snapshot: ActiveApplicationCompositionSnapshot) =>
  DateTime.now.pipe(
    Effect.flatMap((now) =>
      validateActiveApplicationCompositionSnapshot({
        ...snapshot,
        observedAt: now,
        validUntil: DateTime.add(now, { hours: 2 }),
      }),
    ),
  );

const changeOwnerContract = Effect.fnUntraced(function* changeOwnerContract(
  snapshot: ActiveApplicationCompositionSnapshot,
) {
  const owner = snapshot.composition.modules.find((module) => module.moduleId === 'commerce.customer-context');
  if (owner === undefined) {
    return yield* Effect.die('The test release has no Commerce owner contract');
  }
  const codec = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
  const contract = yield* Schema.decodeEffect(codec)(owner.contractDocument);
  const contractDocument = yield* Schema.encodeEffect(codec)({
    ...contract,
    manifest: {
      ...contract.manifest,
      module: { ...contract.manifest.module, displayName: 'A different public contract under the same build marker' },
    },
  });
  const sha256 = createHash('sha256').update(contractDocument, 'utf-8').digest('hex');
  const composition = {
    ...snapshot.composition,
    modules: snapshot.composition.modules.map((module) =>
      module.moduleId === owner.moduleId
        ? {
            ...module,
            contract: { ...module.contract, sha256 },
            contractDocument,
            publicContract: { ...module.publicContract, sha256 },
          }
        : module,
    ),
    revision: '0'.repeat(64),
  };
  return yield* validateActiveApplicationCompositionSnapshot({
    ...snapshot,
    composition: {
      ...composition,
      revision: createHash('sha256').update(canonicalizeApplicationComposition(composition), 'utf-8').digest('hex'),
    },
  });
});

it.effect('rejects the wrong compiled owner before work and recovers when its own release is approved', () =>
  Effect.gen(function* rejectsUnapprovedCompiledOwner() {
    const releaseA = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
    const releaseB = yield* makeEnrollmentApplicationCompositionSnapshot('continuation-release-b', []);
    const scripted = yield* harness(
      Option.some(releaseA),
      { appId, buildMarker: 'continuation-release-b' },
      releaseA.composition.revision,
    );
    yield* Effect.gen(function* verifiesCompiledReleaseAdmission() {
      const continuation = yield* CommerceEnrollmentContinuation;
      expect(scripted.calls.loads).toBe(0);
      expect(yield* Effect.flip(continuation.advance(attemptInput))).toBeInstanceOf(
        CommerceEnrollmentAttemptUnavailable,
      );
      expect(yield* Effect.flip(continuation.openSweepPass)).toBeInstanceOf(CommerceEnrollmentAttemptUnavailable);
      expect(scripted.calls.routines).toStrictEqual([]);
      expect(scripted.calls.worker).toStrictEqual([]);
      expect(scripted.calls.subject).toBe(0);
      expect(scripted.calls.registry).toBe(0);
      expect(scripted.calls.owner).toBe(0);
      yield* scripted.setSource(releaseB);
      const pass = yield* continuation.openSweepPass;
      expect(pass.compositionRevision).toBe(releaseB.composition.revision);
      expect(yield* pass.listDue(dueInput)).toStrictEqual([]);
      expect(scripted.calls.worker).toHaveLength(1);
    }).pipe(Effect.provide(scripted.layer));
  }),
);

it.effect('boots lazily and recovers from missing and invalid observations', () =>
  Effect.gen(function* recoversBeforeFirstApprovedRelease() {
    const release = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
    const scripted = yield* harness(Option.none(), { appId, buildMarker }, release.composition.revision);
    yield* Effect.gen(function* verifiesLazySourceRecovery() {
      const continuation = yield* CommerceEnrollmentContinuation;
      expect(scripted.calls.loads).toBe(0);
      expect(yield* Effect.flip(continuation.openSweepPass)).toBeInstanceOf(CommerceEnrollmentAttemptUnavailable);
      yield* scripted.setSource({ ...release, composition: { ...release.composition, revision: '0'.repeat(64) } });
      expect(yield* Effect.flip(continuation.openSweepPass)).toBeInstanceOf(CommerceEnrollmentAttemptUnavailable);
      expect(scripted.calls.worker).toStrictEqual([]);
      yield* scripted.setSource(release);
      const pass = yield* continuation.openSweepPass;
      expect(yield* pass.listDue(dueInput)).toStrictEqual([]);
      expect(scripted.calls.loads).toBe(3);
      expect(scripted.calls.worker).toHaveLength(1);
    }).pipe(Effect.provide(scripted.layer));
  }),
);

it.effect('opens a new composition for the same owner while each existing pass retains its captured revision', () =>
  Effect.gen(function* capturesOneCompositionPerSweepPass() {
    const releaseA = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
    const releaseB = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, ['pricing']);
    expect(releaseA.composition.revision).not.toBe(releaseB.composition.revision);
    const scripted = yield* harness(
      Option.some(releaseA),
      { appId, buildMarker },
      releaseA.composition.revision,
      'COMPLETE',
    );
    yield* Effect.gen(function* verifiesPassRevisionIsolation() {
      const continuation = yield* CommerceEnrollmentContinuation;
      const passA = yield* continuation.openSweepPass;
      expect(scripted.calls.loads).toBe(1);
      yield* scripted.setSource(releaseB);
      const passB = yield* continuation.openSweepPass;
      expect(passA.compositionRevision).toBe(releaseA.composition.revision);
      expect(passB.compositionRevision).toBe(releaseB.composition.revision);
      expect(scripted.calls.loads).toBe(2);
      yield* scripted.setDueRevision(releaseB.composition.revision);
      const listedB = yield* passB.listDue(dueInput);
      expect(listedB.map((row) => row.compositionRevision)).toStrictEqual([releaseB.composition.revision]);
      const claimsB = yield* Effect.all(
        listedB.map((dueAttempt) =>
          passB.claimSweep({
            ...sweepInput(dueAttempt.compositionRevision),
            portalEnrollmentAttemptId: dueAttempt.portalEnrollmentAttemptId,
          }),
        ),
      );
      expect(claimsB).toStrictEqual([Option.some(1)]);
      expect(yield* Effect.flip(passB.advance(attemptInput))).toBeInstanceOf(CommerceEnrollmentAttemptUnavailable);
      expect(scripted.calls.routines).toStrictEqual(['read_portal_enrollment_attempt']);
      expect(scripted.calls.registry).toBe(0);
      expect(scripted.calls.subject).toBe(0);
      expect(scripted.calls.owner).toBe(0);
      yield* scripted.setDueRevision(releaseA.composition.revision);
      expect((yield* passA.listDue(dueInput)).map((row) => row.compositionRevision)).toStrictEqual([
        releaseA.composition.revision,
      ]);
      expect(yield* passA.claimSweep(sweepInput(releaseA.composition.revision))).toStrictEqual(Option.some(1));
      expect(yield* passA.advance(attemptInput)).toStrictEqual({ outcome: 'COMPLETE' });
      expect(scripted.calls.claimRevisions).toStrictEqual([
        releaseB.composition.revision,
        releaseA.composition.revision,
      ]);
      expect(scripted.calls.loads).toBe(2);
    }).pipe(Effect.provide(scripted.layer));
  }),
);

it.effect('expires captured callbacks even when the source renews that same release', () =>
  Effect.gen(function* preservesCapturedLeaseExpiry() {
    const release = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
    const scripted = yield* harness(Option.some(release), { appId, buildMarker }, release.composition.revision);
    yield* Effect.gen(function* verifiesSweepPassLease() {
      const continuation = yield* CommerceEnrollmentContinuation;
      const oldPass = yield* continuation.openSweepPass;
      yield* TestClock.adjust('61 minutes');
      yield* scripted.setSource(yield* renew(release));
      expect(yield* Effect.flip(oldPass.listDue(dueInput))).toBeInstanceOf(CommerceEnrollmentAttemptUnavailable);
      expect(yield* Effect.flip(oldPass.claimSweep(sweepInput(release.composition.revision)))).toBeInstanceOf(
        CommerceEnrollmentAttemptUnavailable,
      );
      expect(yield* Effect.flip(oldPass.advance(attemptInput))).toBeInstanceOf(CommerceEnrollmentAttemptUnavailable);
      expect(scripted.calls.loads).toBe(1);
      expect(scripted.calls.routines).toStrictEqual([]);
      expect(scripted.calls.worker).toStrictEqual([]);
      expect(scripted.calls.registry).toBe(0);
      expect(scripted.calls.subject).toBe(0);
      expect(scripted.calls.owner).toBe(0);
      const renewedPass = yield* continuation.openSweepPass;
      expect(renewedPass.compositionRevision).toBe(oldPass.compositionRevision);
      expect(yield* renewedPass.listDue(dueInput)).toStrictEqual([]);
      expect(yield* renewedPass.claimSweep(sweepInput(release.composition.revision))).toStrictEqual(Option.some(1));
      expect(scripted.calls.loads).toBe(2);
      expect(scripted.calls.worker).toHaveLength(2);
    }).pipe(Effect.provide(scripted.layer));
  }),
);

it.effect('rejects public contract drift under the same compiled build marker', () =>
  Effect.gen(function* refusesDifferentOwnerContract() {
    const release = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
    const changed = yield* changeOwnerContract(release);
    const scripted = yield* harness(Option.some(release), { appId, buildMarker }, release.composition.revision);
    yield* Effect.gen(function* verifiesCompiledOwnerContractIdentity() {
      const continuation = yield* CommerceEnrollmentContinuation;
      const originalPass = yield* continuation.openSweepPass;
      yield* scripted.setSource(changed);
      expect(yield* Effect.flip(continuation.openSweepPass)).toBeInstanceOf(CommerceEnrollmentAttemptUnavailable);
      expect(scripted.calls.worker).toStrictEqual([]);
      expect(scripted.calls.routines).toStrictEqual([]);
      expect(yield* originalPass.listDue(dueInput)).toStrictEqual([]);
      expect(scripted.calls.loads).toBe(2);
    }).pipe(Effect.provide(scripted.layer));
  }),
);

it.effect('preserves a durable pending claim without owner effects when the captured lease expires during SQL', () =>
  Effect.gen(function* refusesOwnerDispatchAfterClaimLeaseExpires() {
    const release = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
    const immediate = yield* harness(
      Option.some(release),
      { appId, buildMarker },
      release.composition.revision,
      'IN_PROGRESS',
      Effect.void,
    );
    yield* CommerceEnrollmentContinuation.pipe(
      Effect.flatMap((continuation) => continuation.advance(attemptInput)),
      Effect.provide(immediate.layer),
    );
    expect(immediate.calls.owner).toBe(1);
    const scripted = yield* harness(
      Option.some(release),
      { appId, buildMarker },
      release.composition.revision,
      'IN_PROGRESS',
      TestClock.adjust('61 minutes'),
    );
    yield* Effect.gen(function* verifiesPostClaimAuthorityLease() {
      const continuation = yield* CommerceEnrollmentContinuation;
      const pass = yield* continuation.openSweepPass;
      const result = yield* pass.advance(attemptInput);
      expect(result).toMatchObject({ halt: { reason: 'RECONCILIATION_REQUIRED' }, outcome: 'HALTED' });
      expect(scripted.calls.durableClaims).toHaveLength(1);
      expect(scripted.calls.durableClaims[0]).toMatchObject({
        attempt_outcome: 'CLAIMED',
        composition_revision: release.composition.revision,
        operation_status: 'IN_PROGRESS',
        revision: 2,
      });
      expect(scripted.calls.routines.filter((name) => name === 'claim_portal_enrollment_transition')).toHaveLength(1);
      expect(scripted.calls.routines).not.toContain('record_portal_enrollment_outcome');
      expect(scripted.calls.owner).toBe(0);
      expect(scripted.calls.loads).toBe(1);
    }).pipe(Effect.provide(scripted.layer));
  }),
);

it.effect('requires native readmission before resolving a parked Attempt from an earlier release', () =>
  Effect.gen(function* rejectsAttemptFromAnotherRelease() {
    const release = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
    const originalRevision = 'b'.repeat(64);
    const scripted = yield* harness(Option.some(release), { appId, buildMarker }, originalRevision);
    yield* Effect.gen(function* verifiesDurableAttemptRevision() {
      const continuation = yield* CommerceEnrollmentContinuation;
      const pass = yield* continuation.openSweepPass;
      expect(yield* Effect.flip(pass.advance(attemptInput))).toBeInstanceOf(CommerceEnrollmentAttemptUnavailable);
      expect(scripted.calls.routines).toStrictEqual([
        'read_portal_enrollment_attempt',
        'admit_portal_enrollment_attempt',
      ]);
      expect(scripted.calls.registry).toBe(0);
      expect(scripted.calls.subject).toBe(0);
      expect(scripted.calls.owner).toBe(0);
      expect(yield* Effect.flip(pass.claimSweep(sweepInput(originalRevision)))).toBeInstanceOf(
        CommerceEnrollmentAttemptUnavailable,
      );
      expect(scripted.calls.worker).toStrictEqual([]);
      yield* scripted.setDueRevision(originalRevision);
      expect((yield* pass.listDue(dueInput)).map((row) => row.compositionRevision)).toStrictEqual([originalRevision]);
      expect(scripted.calls.worker).toHaveLength(1);
      expect(yield* pass.claimSweep(sweepInput(release.composition.revision))).toStrictEqual(Option.some(1));
      expect(scripted.calls.claimRevisions).toStrictEqual([release.composition.revision]);
      expect(scripted.calls.loads).toBe(1);
    }).pipe(Effect.provide(scripted.layer));
  }),
);

it.effect('re-reads native admitted authority before any owner preparation under the new release', () =>
  Effect.gen(function* readmitsParkedAttemptBeforeOwnerResolution() {
    const release = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
    const scripted = yield* harness(
      Option.some(release),
      { appId, buildMarker },
      'b'.repeat(64),
      'IN_PROGRESS',
      Effect.void,
      release.composition.revision,
    );
    yield* CommerceEnrollmentContinuation.pipe(
      Effect.flatMap((continuation) => continuation.advance(attemptInput)),
      Effect.provide(scripted.layer),
    );
    expect(scripted.calls.routines.slice(0, 3)).toStrictEqual([
      'read_portal_enrollment_attempt',
      'admit_portal_enrollment_attempt',
      'read_portal_enrollment_attempt',
    ]);
    expect(scripted.calls.durableClaims[0]).toMatchObject({ composition_revision: release.composition.revision });
    expect(scripted.calls.owner).toBe(1);
  }),
);

it.effect('an unverified signup halts before subject resolution, Party claim or any owner lease', () =>
  Effect.gen(function* noPreVerificationOwnerClaim() {
    const release = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
    const scripted = yield* harness(
      Option.some(release),
      { appId, buildMarker },
      release.composition.revision,
      'VERIFICATION_REQUIRED',
    );
    const result = yield* CommerceEnrollmentContinuation.pipe(
      Effect.flatMap((continuation) => continuation.advance(attemptInput)),
      Effect.provide(scripted.layer),
    );
    expect(result).toMatchObject({ halt: { reason: 'VERIFICATION_REQUIRED' }, outcome: 'HALTED' });
    expect(scripted.calls.subject).toBe(0);
    expect(scripted.calls.registry).toBe(0);
    expect(scripted.calls.owner).toBe(0);
    expect(scripted.calls.routines).not.toContain('claim_portal_enrollment_transition');
    expect(scripted.calls.routines).not.toContain('set_portal_enrollment_verification_state');
  }),
);

it.effect('reconciles admitted owner work without treating current verification as a new claim gate', () =>
  Effect.gen(function* settlesAlreadyAdmittedOwnerWork() {
    const release = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
    for (const initial of [
      'INDETERMINATE',
      'RECONCILIATION_REQUIRED',
      'FAILED',
      'EXPIRED',
      'LEASED',
      'RECOVERED',
    ] as const) {
      let status: typeof EnrollmentOwnerOperationStatusSchema.Type = 'INDETERMINATE';
      if (initial === 'EXPIRED' || initial === 'LEASED') {
        status = 'IN_PROGRESS';
      } else if (initial !== 'RECOVERED') {
        status = initial;
      }
      let state: EnrollmentAttemptState = 'RECONCILIATION_REQUIRED';
      let revision = 1;
      const calls = { claims: 0, dispatches: 0, ownerReads: 0, records: 0, verification: 0 };
      const pendingCode = 'owner_reconciliation_required';
      const ownerInvocationId = '50000000-0000-4000-8000-000000000002';
      const row = () => attemptRow(release.composition.revision, state);
      const ownerRow = (provider: boolean) => {
        let leaseExpiresAt: string | null = null;
        if (!provider && status === 'IN_PROGRESS') {
          leaseExpiresAt = initial === 'LEASED' ? '2099-09-17T10:00:00.000Z' : '1960-09-17T10:00:00.000Z';
        }
        return {
          ...row(),
          actor_principal_id: row().created_by_principal_id,
          failure_code: !provider && status === 'FAILED' ? pendingCode : null,
          lease_expires_at: leaseExpiresAt,
          lease_owner: !provider && status === 'IN_PROGRESS' ? 'abandoned-worker' : null,
          lease_token: !provider && status === 'IN_PROGRESS' ? '60000000-0000-4000-8000-000000000001' : null,
          operation_outcome: 'FOUND',
          owner_invocation_id: provider ? '50000000-0000-4000-8000-000000000005' : ownerInvocationId,
          owner_module_key: provider ? 'commerce.portal-auth' : 'party.registry',
          portal_enrollment_owner_operation_id: provider
            ? '50000000-0000-4000-8000-000000000003'
            : '50000000-0000-4000-8000-000000000004',
          request_digest: 'a'.repeat(64),
          required: true,
          revision,
          status: provider ? 'SUCCEEDED' : status,
          transition_key: provider ? 'provider.account.create' : 'party.candidate.submit',
        };
      };
      const projection = () => {
        const operation = ownerRow(false);
        return {
          ...row(),
          attempt_outcome: 'RECORDED',
          failure_code: operation.failure_code,
          operation_actor_principal_id: operation.actor_principal_id,
          operation_id: operation.portal_enrollment_owner_operation_id,
          operation_revision: operation.revision,
          operation_status: operation.status,
          owner_invocation_id: ownerInvocationId,
          owner_module_key: operation.owner_module_key,
          request_digest: operation.request_digest,
          required: true,
          revision,
          transition_key: operation.transition_key,
        };
      };
      const invoke: EnrollmentAttemptScopedRoutineInvoker['invoke'] = (routine, values) =>
        Effect.sync(() => {
          let rows: readonly object[] = [];
          if (routine.name === 'read_portal_enrollment_attempt') {
            rows = [{ ...row(), revision }];
          } else if (routine.name === 'read_portal_enrollment_owner_operation') {
            if (values.at(2) === 'provider.account.create') {
              rows = [ownerRow(true)];
            } else if (values.at(2) === 'party.candidate.submit') {
              rows = [ownerRow(false)];
            }
          } else if (routine.name === 'claim_portal_enrollment_transition') {
            calls.claims += 1;
            status = 'INDETERMINATE';
            revision += 1;
            rows = [{ ...projection(), attempt_outcome: 'INDETERMINATE' }];
          } else if (routine.name === 'reconcile_portal_enrollment_outcome') {
            calls.records += 1;
            status = initial === 'RECOVERED' ? 'SUCCEEDED' : 'FAILED';
            state = initial === 'RECOVERED' ? 'IN_PROGRESS' : 'RECONCILIATION_REQUIRED';
            revision += 1;
            rows = [projection()];
          } else if (routine.name === 'set_portal_enrollment_verification_state') {
            state = 'VERIFICATION_REQUIRED';
            revision += 1;
            rows = [{ updated: true }];
          }
          return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(rows);
        });
      const dependencies = Layer.mergeAll(
        Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(release) }),
        Layer.succeed(CommerceEnrollmentOwnerTransactionRunner, {
          run: (_scope, operation) => operation({ invoke }),
          runWorker: () => Effect.die('This owner-local test does not list due work'),
        }),
        Layer.succeed(CommerceEnrollmentOwnerEffectRegistry, {
          resolve: () =>
            Effect.succeedSome({
              dispatch: Option.some({
                effect: () =>
                  Effect.sync(() => {
                    calls.dispatches += 1;
                    return { status: 'SUCCEEDED' as const };
                  }),
                requestDigest: 'a'.repeat(64),
              }),
              reconcile: (input) =>
                Effect.sync(() => {
                  calls.ownerReads += 1;
                  expect(input.ownerInvocationId).toBe(ownerInvocationId);
                  return Schema.decodeSync(ReconcileEnrollmentResolutionSchema)({
                    actorPrincipalId: input.actorPrincipalId,
                    failureCode: pendingCode,
                    reconciliationRef: '70000000-0000-4000-8000-000000000001',
                    status: initial === 'RECOVERED' ? 'SUCCEEDED' : 'FAILED',
                  });
                }),
            }),
          verificationRequired: () =>
            Effect.sync(() => {
              calls.verification += 1;
              return true;
            }),
        }),
        Layer.succeed(CommerceEnrollmentPreparationSubjectResolver, {
          resolve: () =>
            Effect.succeed({
              partyCandidateDigest: 'a'.repeat(64),
              partyRef: Option.none(),
              portalEnrollmentAttemptId: attemptId,
              principalRef: {
                moduleId: 'core.identity',
                resourceId: row().created_by_principal_id,
                resourceType: 'core.identity.principal',
                tenantId,
              },
              sellingLegalEntityRef: {
                moduleId: 'core.identity',
                resourceId: '80000000-0000-4000-8000-000000000001',
                resourceType: 'core.identity.legal-entity',
                tenantId,
              },
            }),
        }),
      );
      let haltReason = 'RECONCILIATION_REQUIRED';
      let expectedOwnerReads = 2;
      if (initial === 'LEASED') {
        haltReason = 'IN_FLIGHT';
        expectedOwnerReads = 0;
      } else if (initial === 'RECOVERED') {
        haltReason = 'VERIFICATION_REQUIRED';
        expectedOwnerReads = 1;
      }
      yield* Effect.gen(function* repeatRecovery() {
        const continuation = yield* CommerceEnrollmentContinuation;
        for (let pass = 0; pass < 2; pass += 1) {
          expect(yield* continuation.advance(attemptInput)).toMatchObject({
            halt: { reason: haltReason },
            outcome: 'HALTED',
          });
        }
      }).pipe(
        Effect.provide(CommerceEnrollmentContinuationLive({ appId, buildMarker }).pipe(Layer.provide(dependencies))),
      );
      expect(calls.verification).toBe(initial === 'RECOVERED' ? 2 : 0);
      expect(calls.dispatches).toBe(0);
      expect(calls.claims).toBe(initial === 'EXPIRED' ? 1 : 0);
      expect(calls.ownerReads).toBe(expectedOwnerReads);
      expect(calls.records).toBe(initial === 'FAILED' || initial === 'LEASED' ? 0 : 1);
    }
  }),
);
