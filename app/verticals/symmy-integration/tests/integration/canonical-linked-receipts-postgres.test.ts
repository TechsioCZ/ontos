import { TrustedPrincipalContextSchema, defineScopedRoutine, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { SymmyFixtureExecutionPlanSchema, SymmyOwnerReceiptSchema } from '../../shared/domain/symmy-job-execution.ts';
import { symmyImportJobs, symmyIntegrationRelations, symmyJobEffects, symmyJobRoutes } from '../../src/db/schema.ts';
import { symmyJobExecutionStore } from '../../src/persistence/symmy-job-execution-store.ts';
import { symmyJobStoreFactory } from '../../src/persistence/symmy-job-store.ts';

const openDatabase = (connectionString: string) =>
  PgClient.makeClient({ url: Redacted.make(connectionString) }).pipe(
    Effect.flatMap((client) =>
      makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(Effect.provideService(PgClient.PgClient, client)),
    ),
  );
const rawReceipt = defineScopedRoutine({
  name: 'record_symmy_owner_receipt',
  ownerModuleKey: 'integration.symmy',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ applied: Schema.Boolean }),
  routineKey: 'symmy-job.test-linked-receipt-scope',
  schema: 'symmy_integration',
});

type ReceiptValue = Readonly<Record<string, string | Readonly<Record<string, string>> | undefined>>;
const receiptSubmitter =
  (
    runtime: Effect.Success<ReturnType<typeof openDatabase>>,
    scope: OperationalScope,
    claim: { readonly effectId: string; readonly jobId: string; readonly token: string; readonly version: number },
  ) =>
  (value: ReceiptValue) =>
    runtime.transaction((transaction) =>
      installOperationalScope(transaction, scope).pipe(
        Effect.flatMap((scopedTransaction) =>
          scopedTransaction.invoke(rawReceipt, [claim.jobId, claim.effectId, claim.token, claim.version, value]),
        ),
      ),
    );

const verifyMatchedPartyReceipt = Effect.fn('LinkedReceiptFixture.verifyMatchedParty')(function* verifyMatched(
  submit: ReturnType<typeof receiptSubmitter>,
  tenantId: string,
  allowed: boolean,
) {
  const receipt = {
    _tag: 'PartyMatched',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: crypto.randomUUID(),
      resourceType: 'party.registry.party',
      tenantId,
    },
  };
  if (!allowed) {
    yield* Effect.flip(submit(receipt));
    return yield* Effect.void;
  }
  expect((yield* submit(receipt))[0]?.applied).toBe(true);
  yield* Effect.flip(submit({ ...receipt, partyRef: { ...receipt.partyRef, tenantId: crypto.randomUUID() } }));
  expect(
    (yield* submit({ ...receipt, partyRef: { ...receipt.partyRef, resourceId: crypto.randomUUID() } }))[0]?.applied,
  ).toBe(false);
  return yield* Effect.void;
});

it.effect(
  'stores exact linked Party and Counterparty references while refusing foreign tenant, module, type, kind and rebinding',
  () =>
    Effect.gen(function* canonicalLinks() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const runtime = yield* openDatabase(connections.runtime.connectionString);
      const tenantId = crypto.randomUUID();
      const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: crypto.randomUUID(),
        authContextRef: 'better-auth-api-key:linked-receipt-storage-fixture',
        authMethod: 'api_key',
        principalId: crypto.randomUUID(),
        tenantId,
      });
      const scope: OperationalScope = {
        ...principal,
        audience: 'symmy-integration',
        correlationId: 'canonical-linked-receipt-storage',
      };
      const scoped = <A, E>(run: (transaction: ScopedTransactionExecutor) => Effect.Effect<A, E>) =>
        runtime.transaction((transaction) => installOperationalScope(transaction, scope).pipe(Effect.flatMap(run)));
      yield* Effect.addFinalizer(() =>
        admin
          .delete(symmyJobEffects)
          .where(eq(symmyJobEffects.tenantId, tenantId))
          .pipe(
            Effect.andThen(admin.delete(symmyImportJobs).where(eq(symmyImportJobs.tenantId, tenantId))),
            Effect.andThen(admin.delete(symmyJobRoutes).where(eq(symmyJobRoutes.tenantId, tenantId))),
            Effect.orDie,
          ),
      );
      const plan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
        items: [
          {
            effects: [
              {
                effectKey: 'party-match-from-create',
                operation: {
                  entrypointKey: 'party.registry.create-party',
                  moduleId: 'party.registry',
                  schemaVersion: '1',
                },
              },
              {
                effectKey: 'party-match-from-update',
                operation: {
                  entrypointKey: 'party.registry.update-party',
                  moduleId: 'party.registry',
                  schemaVersion: '1',
                },
              },
              {
                effectKey: 'retail',
                operation: {
                  entrypointKey: 'commerce.customer-context.ensure-retail-customer-profile',
                  moduleId: 'commerce.customer-context',
                  schemaVersion: '1',
                },
              },
              {
                effectKey: 'counterparty',
                operation: {
                  entrypointKey: 'commerce.customer-context.create-counterparty-purchasing-profile',
                  moduleId: 'commerce.customer-context',
                  schemaVersion: '1',
                },
              },
            ],
            itemKey: 'profiles',
            source: {
              entityKind: 'Customer',
              issuerId: 'internal-storage',
              sourceNamespace: 'typed-links',
              sourceRecordId: 'profiles',
            },
          },
        ],
      });
      yield* admin.insert(symmyJobRoutes).values({
        active: true,
        fixtureIds: ['linked-receipts'],
        fixturePlan: plan,
        mappingVersion: '1',
        principalId: scope.principalId,
        routeId: crypto.randomUUID(),
        routeKey: 'customersBatch',
        routeRevision: '1',
        tenantId,
      });
      const admitted = yield* scoped((transaction) =>
        symmyJobStoreFactory(transaction, scope).pipe(
          Effect.flatMap((store) =>
            store.admit({
              fixtureId: 'linked-receipts',
              idempotencyKey: 'linked-receipts',
              routeKey: 'customersBatch',
            }),
          ),
        ),
      );
      const maybeJob = yield* scoped((transaction) => symmyJobExecutionStore(transaction).load(admitted.jobId));
      if (Option.isNone(maybeJob)) {
        return yield* Effect.die('Missing storage fixture admission');
      }
      const job = maybeJob.value;
      expect(job.routeKey).toBe('customersBatch');
      yield* Effect.forEach(
        job.effects,
        Effect.fn('LinkedReceiptFixture.verify')(function* verify({ effect }) {
          const token = crypto.randomUUID();
          const claim = yield* scoped((transaction) =>
            symmyJobExecutionStore(transaction).claim(job.jobId, effect.ref.effectId, token),
          );
          expect(claim.mode).toBe('execute');
          expect(
            yield* scoped((transaction) =>
              symmyJobExecutionStore(transaction).recordExecutor(
                job.jobId,
                effect.ref.effectId,
                token,
                claim.version,
                crypto.randomUUID(),
              ),
            ),
          ).toBe(true);
          if (effect.effectKey === 'party-match-from-create' || effect.effectKey === 'party-match-from-update') {
            yield* verifyMatchedPartyReceipt(
              receiptSubmitter(runtime, scope, {
                effectId: effect.ref.effectId,
                jobId: job.jobId,
                token,
                version: claim.version,
              }),
              tenantId,
              effect.effectKey === 'party-match-from-create',
            );
            return yield* Effect.void;
          }
          const retail = effect.effectKey === 'retail';
          const linked = {
            moduleId: 'party.registry',
            resourceId: crypto.randomUUID(),
            resourceType: retail ? 'party.registry.party' : 'party.registry.counterparty',
            tenantId,
          };
          const profile = {
            moduleId: 'commerce.customer-context',
            resourceId: crypto.randomUUID(),
            resourceType: retail
              ? 'commerce.customer-context.retail-customer-profile'
              : 'commerce.customer-context.counterparty-purchasing-profile',
            tenantId,
          };
          const receipt = retail
            ? { _tag: 'RetailProfileEnsured', partyRef: linked, profileRef: profile }
            : { _tag: 'CounterpartyProfileCreated', counterpartyRef: linked, profileRef: profile };
          const parsed = Schema.decodeUnknownSync(SymmyOwnerReceiptSchema)(receipt);
          expect(
            yield* scoped((transaction) =>
              symmyJobExecutionStore(transaction).recordOwnerReceipt(
                job.jobId,
                effect.ref.effectId,
                token,
                claim.version,
                parsed,
              ),
            ),
          ).toBe(true);
          const submit = receiptSubmitter(runtime, scope, {
            effectId: effect.ref.effectId,
            jobId: job.jobId,
            token,
            version: claim.version,
          });
          const foreign = retail
            ? { ...receipt, partyRef: { ...linked, tenantId: crypto.randomUUID() } }
            : { ...receipt, counterpartyRef: { ...linked, tenantId: crypto.randomUUID() } };
          yield* Effect.flip(submit(foreign));
          yield* Effect.flip(submit({ ...receipt, profileRef: { ...profile, moduleId: 'party.registry' } }));
          yield* Effect.flip(submit({ ...receipt, profileRef: { ...profile, resourceType: 'party.registry.party' } }));
          yield* Effect.flip(submit({ ...receipt, _tag: 'PartyCreated' }));
          yield* Effect.flip(submit({ ...receipt, unapprovedRef: linked }));
          yield* Effect.flip(
            submit({
              ...receipt,
              rolePeriodRef: { ...linked, resourceType: 'party.registry.counterparty-role-period' },
            }),
          );
          const changed = Schema.decodeUnknownSync(SymmyOwnerReceiptSchema)({
            ...receipt,
            profileRef: { ...profile, resourceId: crypto.randomUUID() },
          });
          expect(
            yield* scoped((transaction) =>
              symmyJobExecutionStore(transaction).recordOwnerReceipt(
                job.jobId,
                effect.ref.effectId,
                token,
                claim.version,
                changed,
              ),
            ),
          ).toBe(false);
          const current = yield* scoped((transaction) => symmyJobExecutionStore(transaction).load(job.jobId));
          expect(
            Option.getOrUndefined(
              Option.getOrUndefined(current)?.effects.find((saved) => saved.effect.ref.effectId === effect.ref.effectId)
                ?.ownerReceipt ?? Option.none(),
            ),
          ).toEqual(parsed);
          return yield* Effect.void;
        }),
        { concurrency: 1 },
      );
      yield* admin
        .update(symmyJobRoutes)
        .set({ routeKey: 'productsBatch' })
        .where(eq(symmyJobRoutes.tenantId, tenantId));
      const retained = yield* scoped((transaction) => symmyJobExecutionStore(transaction).load(job.jobId));
      expect(Option.getOrUndefined(retained)?.routeKey).toBe('customersBatch');
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
  30_000,
);

it.effect(
  'pins Onboard scope and role receipts to the admitted company without rewriting legacy canonical receipts',
  () =>
    Effect.gen(function* onboardScopePins() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const runtime = yield* openDatabase(connections.runtime.connectionString);
      const tenantId = crypto.randomUUID();
      const legalEntityId = crypto.randomUUID();
      const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: crypto.randomUUID(),
        authContextRef: 'better-auth-api-key:onboard-receipt-storage-fixture',
        authMethod: 'api_key',
        legalEntityId,
        principalId: crypto.randomUUID(),
        tenantId,
      });
      const scope: OperationalScope = {
        ...principal,
        audience: 'symmy-integration',
        correlationId: 'canonical-onboard-receipt-storage',
      };
      const scoped = <A, E>(run: (transaction: ScopedTransactionExecutor) => Effect.Effect<A, E>) =>
        runtime.transaction((transaction) => installOperationalScope(transaction, scope).pipe(Effect.flatMap(run)));
      yield* Effect.addFinalizer(() =>
        admin
          .delete(symmyJobEffects)
          .where(eq(symmyJobEffects.tenantId, tenantId))
          .pipe(
            Effect.andThen(admin.delete(symmyImportJobs).where(eq(symmyImportJobs.tenantId, tenantId))),
            Effect.andThen(admin.delete(symmyJobRoutes).where(eq(symmyJobRoutes.tenantId, tenantId))),
            Effect.orDie,
          ),
      );
      const plan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
        items: [
          {
            effects: ['onboard-current', 'onboard-legacy'].map((effectKey) => ({
              effectKey,
              operation: {
                entrypointKey: 'party.registry.counterparty-customer-onboard',
                moduleId: 'party.registry',
                schemaVersion: '1',
              },
            })),
            itemKey: 'onboard',
            source: {
              entityKind: 'Customer',
              issuerId: 'internal-storage',
              sourceNamespace: 'onboard-links',
              sourceRecordId: 'onboard',
            },
          },
        ],
      });
      yield* admin.insert(symmyJobRoutes).values({
        active: true,
        fixtureIds: ['onboard-receipts'],
        fixturePlan: plan,
        legalEntityId,
        mappingVersion: '1',
        principalId: scope.principalId,
        routeId: crypto.randomUUID(),
        routeKey: 'customersBatch',
        routeRevision: '1',
        tenantId,
      });
      const admitted = yield* scoped((transaction) =>
        symmyJobStoreFactory(transaction, scope).pipe(
          Effect.flatMap((store) =>
            store.admit({
              fixtureId: 'onboard-receipts',
              idempotencyKey: 'onboard-receipts',
              routeKey: 'customersBatch',
            }),
          ),
        ),
      );
      const maybeJob = yield* scoped((transaction) => symmyJobExecutionStore(transaction).load(admitted.jobId));
      if (Option.isNone(maybeJob)) {
        return yield* Effect.die('Missing Onboard storage fixture admission');
      }
      const job = maybeJob.value;
      yield* Effect.forEach(
        job.effects,
        Effect.fn('OnboardReceiptFixture.verify')(function* verify({ effect }) {
          const token = crypto.randomUUID();
          const claim = yield* scoped((transaction) =>
            symmyJobExecutionStore(transaction).claim(job.jobId, effect.ref.effectId, token),
          );
          expect(claim.mode).toBe('execute');
          expect(
            yield* scoped((transaction) =>
              symmyJobExecutionStore(transaction).recordExecutor(
                job.jobId,
                effect.ref.effectId,
                token,
                claim.version,
                crypto.randomUUID(),
              ),
            ),
          ).toBe(true);
          const base = {
            _tag: 'CounterpartyCustomerOnboarded',
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: crypto.randomUUID(),
              resourceType: 'party.registry.counterparty',
              tenantId,
            },
            partyRef: {
              moduleId: 'party.registry',
              resourceId: crypto.randomUUID(),
              resourceType: 'party.registry.party',
              tenantId,
            },
          };
          const scopeRefs = {
            legalEntityRef: {
              moduleId: 'core.identity',
              resourceId: legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId,
            },
            rolePeriodRef: {
              moduleId: 'party.registry',
              resourceId: crypto.randomUUID(),
              resourceType: 'party.registry.counterparty-role-period',
              tenantId,
            },
          };
          const submit = receiptSubmitter(runtime, scope, {
            effectId: effect.ref.effectId,
            jobId: job.jobId,
            token,
            version: claim.version,
          });
          yield* Effect.flip(
            submit({
              ...base,
              ...scopeRefs,
              legalEntityRef: { ...scopeRefs.legalEntityRef, resourceId: crypto.randomUUID() },
            }),
          );
          yield* Effect.flip(
            submit({
              ...base,
              ...scopeRefs,
              rolePeriodRef: { ...scopeRefs.rolePeriodRef, tenantId: crypto.randomUUID() },
            }),
          );
          yield* Effect.flip(
            submit({
              ...base,
              ...scopeRefs,
              legalEntityRef: { ...scopeRefs.legalEntityRef, moduleId: 'party.registry' },
            }),
          );
          yield* Effect.flip(
            submit({
              ...base,
              ...scopeRefs,
              rolePeriodRef: { ...scopeRefs.rolePeriodRef, resourceType: 'party.registry.party' },
            }),
          );
          const receipt = effect.effectKey === 'onboard-current' ? { ...base, ...scopeRefs } : base;
          expect((yield* submit(receipt))[0]?.applied).toBe(true);
          const replacement =
            effect.effectKey === 'onboard-current'
              ? {
                  ...base,
                  ...scopeRefs,
                  rolePeriodRef: { ...scopeRefs.rolePeriodRef, resourceId: crypto.randomUUID() },
                }
              : { ...base, ...scopeRefs };
          expect((yield* submit(replacement))[0]?.applied).toBe(false);
          const current = yield* scoped((transaction) => symmyJobExecutionStore(transaction).load(job.jobId));
          expect(
            Option.getOrUndefined(
              Option.getOrUndefined(current)?.effects.find((saved) => saved.effect.ref.effectId === effect.ref.effectId)
                ?.ownerReceipt ?? Option.none(),
            ),
          ).toEqual(Schema.decodeUnknownSync(SymmyOwnerReceiptSchema)(receipt));
          return yield* Effect.void;
        }),
        { concurrency: 1 },
      );
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
  30_000,
);
