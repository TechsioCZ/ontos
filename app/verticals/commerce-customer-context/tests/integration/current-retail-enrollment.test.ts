import { readFileSync } from 'node:fs';

import { loadDatabaseConnectionPair, scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Crypto, Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { CommercePortalAccountSubjectSchema } from '../../shared/enrollment-contracts.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { readCurrentRetailEnrollment } from '../../src/enrollment/attempts/registration-persistence.ts';
import { enrollmentApplicationCompositionRevision } from '../support/enrollment-application-composition.ts';
import { installEnrollmentTestAuthority } from '../support/enrollment-composition-authority.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';

const randomId = Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4()));

it.live('recovers only the live subject’s exact durable Attempt, refusing cross-customer scope and ambiguity', () =>
  Effect.scoped(
    Effect.gen(function* currentEnrollmentAcceptance() {
      const compositionRevision = yield* enrollmentApplicationCompositionRevision;
      yield* installEnrollmentTestAuthority(compositionRevision);
      const connections = yield* loadDatabaseConnectionPair();
      const client = yield* makeTestPgClient(connections.admin.connectionString);
      const admin = yield* makeTestDatabaseFromClient(client, commerceCustomerContextRelations);
      const tenant = yield* randomId;
      const legalEntity = yield* randomId;
      const creator = yield* randomId;
      const id = yield* randomId;
      const subject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
        authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
        providerSubjectId: `verified-provider-${yield* randomId}`,
        subjectType: 'user',
      });
      const rollback = new Error('current enrollment acceptance rollback');
      yield* admin
        .transaction((transaction) =>
          Effect.gen(function* scopedLookup() {
            const execute = (statement: Parameters<typeof transaction.execute>[0]) =>
              transaction.execute(statement, 'objects');
            const migration = readFileSync(
              new URL('../../drizzle/20261024003000_current-retail-enrollment/migration.sql', import.meta.url),
              'utf-8',
            );
            for (const statement of migration.split('--> statement-breakpoint')) {
              yield* execute(sql.raw(statement));
            }
            yield* execute(
              sql`select set_config('ontos.tenant_id', ${tenant}, true), set_config('ontos.legal_entity_id', ${legalEntity}, true)`,
            );
            const insert = (attempt: string, provider: string, actor = creator, le = legalEntity) =>
              execute(sql`
        insert into commerce_customer_context.portal_enrollment_attempts
          (portal_enrollment_attempt_id, tenant_id, journey, intent_key, intent_digest, composition_revision,
           created_by_principal_id, target_legal_entity_id, authentication_namespace_id, subject_type, provider_subject_id)
        values (${attempt}::uuid, ${tenant}::uuid, 'RETAIL_SELF_ENROLLMENT', ${attempt}, ${'a'.repeat(64)}, ${compositionRevision},
          ${actor}::uuid, ${le}::uuid, ${subject.authenticationNamespaceId}, 'user', ${provider})`);
            yield* insert(id, subject.providerSubjectId);
            yield* insert(yield* randomId, 'another-customer');
            yield* insert(yield* randomId, subject.providerSubjectId, yield* randomId);
            yield* insert(yield* randomId, subject.providerSubjectId, creator, yield* randomId);
            yield* execute(sql`set local role ontos_runtime`);
            // Reconstructed invokers carry no browser Attempt handle or process-local registration state.
            const read = (actor = creator, current = subject, le = legalEntity) =>
              readCurrentRetailEnrollment(
                scopedRoutineInvokerFromTransaction(execute, { legalEntityId: le, tenantId: tenant }),
                actor,
                current,
              );
            expect(Option.getOrNull(yield* read())).toBe(id);
            expect(Option.getOrNull(yield* read())).toBe(id);
            expect(Option.isNone(yield* read(yield* randomId))).toBe(true);
            expect(
              Option.isNone(
                yield* read(
                  creator,
                  Schema.decodeSync(CommercePortalAccountSubjectSchema)({
                    ...subject,
                    providerSubjectId: 'unknown-provider',
                  }),
                ),
              ),
            ).toBe(true);
            expect(
              yield* execute(
                sql`select * from commerce_customer_context.read_current_retail_enrollment(${tenant}::uuid, ${legalEntity}::uuid, ${creator}::uuid, 'another.namespace', 'user', ${subject.providerSubjectId})`,
              ),
            ).toEqual([]);
            const anotherEntity = yield* randomId;
            yield* execute(sql`select set_config('ontos.legal_entity_id', ${anotherEntity}, true)`);
            expect(Option.isNone(yield* read(creator, subject, anotherEntity))).toBe(true);
            yield* execute(sql`select set_config('ontos.legal_entity_id', ${legalEntity}, true)`);
            yield* execute(sql`savepoint wrong_scope`);
            const forgedScope = yield* execute(
              sql`select * from commerce_customer_context.read_current_retail_enrollment(${yield* randomId}::uuid, ${legalEntity}::uuid, ${creator}::uuid, ${subject.authenticationNamespaceId}, 'user', ${subject.providerSubjectId})`,
            ).pipe(Effect.result);
            yield* execute(sql`rollback to savepoint wrong_scope`);
            expect(Result.isFailure(forgedScope)).toBe(true);
            yield* execute(sql`reset role`);
            yield* insert(yield* randomId, subject.providerSubjectId);
            yield* execute(sql`set local role ontos_runtime`);
            expect(Result.isFailure(yield* read().pipe(Effect.result))).toBe(true);
            return yield* Effect.fail(rollback);
          }),
        )
        .pipe(Effect.catch((error) => (error === rollback ? Effect.void : Effect.fail(error))));
    }),
  ).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);
