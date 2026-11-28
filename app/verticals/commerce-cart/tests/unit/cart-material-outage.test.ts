import { FinalCartCandidateSchema } from '@app/commerce-cart-finalization-contracts/final-cart-candidate';
import { makeFinalCartCandidateWire } from '@app/commerce-cart-finalization-contracts/testing/final-cart-candidate';
import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { webCryptoDigestFixture } from '@app/core-runtime/testing/webcrypto-digest';
import { NodeCrypto } from '@effect/platform-node';
import { defineRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Fiber, Layer, Schema } from 'effect';
import { WebCrypto } from 'effect/crypto';
import { Reactivity } from 'effect/reactivity';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { FinalizeCartCandidatePayloadSchema } from '../../shared/actions/finalize-cart-candidate.ts';
import { carts } from '../../src/database/schema.ts';
import { closeAndRecordFinalCartCandidate } from '../../src/services/final-cart-candidate.service.ts';
import { preapprovalCartObservationService } from '../../src/services/preapproval-cart-observation.service.ts';
import { cartPopulationService } from '../../src/services/cart-population.service.ts';

const invocationId = '11111111-1111-4111-8111-111111111111';
const wire = makeFinalCartCandidateWire({
  buyerPrincipalId: invocationId,
  candidateHash: 'a'.repeat(64),
  candidateId: invocationId,
  legalEntityId: '22222222-2222-4222-8222-222222222222',
  tenantId: '33333333-3333-4333-8333-333333333333',
});
const candidate = Schema.decodeUnknownSync(FinalCartCandidateSchema)(wire);
const { buyerPrincipalId, legalEntityId, sourceCart, tenantId } = candidate;
const payload = Schema.decodeUnknownSync(FinalizeCartCandidatePayloadSchema)({
  cartRef: sourceCart.cartRef,
  expectedRevision: 1,
  requestRef: candidate.approval.requestRef,
});
const scope = trustVerifiedGatewayPrincipalContext(
  {
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: invocationId,
      authContextRef: 'cart-digest-test',
      authMethod: 'session',
      legalEntityId,
      principalId: buyerPrincipalId,
      tenantId,
    }),
    correlationId: 'cart-digest-test',
  },
  'a'.repeat(64),
);
const draft = {
  cartRef: sourceCart.cartRef,
  createdAt: wire.orderCommitmentTime,
  entries: [],
  intendedContext: { legalEntityId, verification: 'UNVERIFIED_PREPARATION' },
  legalEntityId,
  preparationPrincipalId: buyerPrincipalId,
  recordedAt: wire.orderCommitmentTime,
  revisionRef: { resourceRef: sourceCart.cartRef, revision: 1, revisionId: sourceCart.revisionId },
  status: 'OPEN',
};
const relations = defineRelations({ carts });
// Only PostgreSQL's wire responses are scripted. Drizzle builds the real close, candidate insert and transaction controls.
const fixture = (selectedCompany: string) =>
  Effect.gen(function* cartSql() {
    const statements: string[] = [];
    const connection = testSqlConnection((query, params) => {
      const sql = query.trim().replaceAll(/\s+/gu, ' ');
      statements.push(sql);
      if (sql === 'select current_user::text as role') {
        return Effect.succeed([{ role: 'ontos_runtime' }]);
      }
      if (sql.includes("current_setting('ontos.tenant_id'")) {
        return Effect.succeed([{ legal_entity_id: selectedCompany, role: 'ontos_runtime', tenant_id: tenantId }]);
      }
      if (sql.includes('left join') && sql.includes('open_cart_entries')) {
        return Effect.succeed([
          {
            cartId: null,
            createdBy: null,
            generation: '1',
            legalEntity: null,
            origin: null,
            position: null,
            principal: null,
            revision: null,
            revisionNumber: null,
            selection: null,
            selectionId: null,
            sourceActionInvocationId: null,
          },
        ]);
      }
      if (sql.includes('inner join') && sql.includes('encoded_cart')) {
        return Effect.succeed([{ buyer: buyerPrincipalId, encoded: draft }]);
      }
      if (sql.includes('from "commerce_cart"."population_roots"')) {
        return Effect.succeed([{ generation: '1', historyId: invocationId, tenantId }]);
      }
      if (sql.includes('from "commerce_cart"."carts"')) {
        return Effect.succeed([
          {
            cartId: sourceCart.cartRef.resourceId,
            creatorPrincipalId: buyerPrincipalId,
            currentRevisionId: sourceCart.revisionId,
            intendedContext: draft.intendedContext,
            legalEntityId,
            tenantId,
          },
        ]);
      }
      if (sql.includes('from "commerce_cart"."cart_revisions"')) {
        return Effect.succeed(
          params.includes(invocationId)
            ? []
            : [
                {
                  actionInvocationId: invocationId,
                  actorPrincipalId: buyerPrincipalId,
                  cartId: sourceCart.cartRef.resourceId,
                  encodedCart: draft,
                  legalEntityId,
                  populationGeneration: '1',
                  previousRevisionId: null,
                  revisionId: sourceCart.revisionId,
                  revisionNumber: '1',
                  status: 'OPEN',
                  tenantId,
                },
              ],
        );
      }
      if (sql.startsWith('update "commerce_cart"."carts"')) {
        return Effect.succeed([{ cartId: sourceCart.cartRef.resourceId }]);
      }
      if (/^(?:BEGIN|COMMIT|ROLLBACK|insert into |update |select set_config)/u.test(sql)) {
        return Effect.succeed([]);
      }
      return Effect.die(`Unexpected Cart fixture SQL: ${sql}`);
    });
    const context = yield* Layer.build(
      scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provideMerge(Reactivity.layer)),
    );
    const db = yield* makeWithDefaults({ relations }).pipe(Effect.provide(context));
    return { db, statements };
  });

it.effect('rolls back the Cart close and never inserts a candidate if its material hash rejects or stalls', () =>
  Effect.gen(function* candidateSettlement() {
    const { db, statements } = yield* fixture(legalEntityId);
    const settle = db.transaction((tx) =>
      installOperationalScope(tx, scope).pipe(
        Effect.flatMap((executor) =>
          closeAndRecordFinalCartCandidate(executor, scope, payload, invocationId, candidate),
        ),
      ),
    );
    for (const host of [
      webCryptoDigestFixture(() => Promise.reject(new Error('private digest failure'))),
      webCryptoDigestFixture(() => Promise.withResolvers<ArrayBuffer>().promise),
    ]) {
      const fiber = yield* settle.pipe(Effect.provide(WebCrypto.layer(host)), Effect.flip, Effect.forkChild);
      yield* TestClock.adjust('5 seconds');
      expect(yield* Fiber.join(fiber)).toMatchObject({ code: 'cart_population_unavailable' });
      expect(statements.some((sql) => sql.startsWith('update "commerce_cart"."carts"'))).toBe(true);
      expect(statements.some((sql) => sql.startsWith('insert into "commerce_cart"."final_cart_candidates"'))).toBe(
        false,
      );
      expect(statements.at(-1)).toBe('ROLLBACK');
      statements.length = 0;
    }
    const stored = yield* settle;
    expect(stored.candidateHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(statements.some((sql) => sql.startsWith('insert into "commerce_cart"."final_cart_candidates"'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect('returns the distinct unavailable contracts for Cart population and preapproval material', () =>
  Effect.gen(function* authoritativeReads() {
    const company = yield* fixture(legalEntityId);
    const tenant = yield* fixture('');
    const { legalEntityId: _company, ...tenantScope } = scope;
    const observe = company.db.transaction((tx) =>
      installOperationalScope(tx, scope).pipe(
        Effect.flatMap((executor) => preapprovalCartObservationService(executor, scope)),
        Effect.flatMap((service) => service.read({ cartRef: sourceCart.cartRef, revision: 1 })),
      ),
    );
    const population = tenant.db.transaction((tx) =>
      installOperationalScope(tx, tenantScope).pipe(
        Effect.flatMap((executor) => cartPopulationService(executor, tenantScope)),
        Effect.flatMap((service) => service.readPopulation(tenantId)),
      ),
    );
    expect((yield* observe).cart.status).toBe('OPEN');
    expect((yield* population).entries).toEqual([]);
    for (const host of [
      webCryptoDigestFixture(() => Promise.reject(new Error('private digest failure'))),
      webCryptoDigestFixture(() => Promise.withResolvers<ArrayBuffer>().promise),
    ]) {
      const fiber = yield* Effect.all(
        { observation: Effect.flip(observe), population: Effect.flip(population) },
        { concurrency: 2 },
      ).pipe(Effect.provide(WebCrypto.layer(host)), Effect.forkChild);
      yield* TestClock.adjust('5 seconds');
      const errors = yield* Fiber.join(fiber);
      expect(errors.observation).toMatchObject({ code: 'read_handler_unavailable' });
      expect(errors.population).toMatchObject({ code: 'cart_population_unavailable' });
    }
  }).pipe(Effect.scoped),
);
