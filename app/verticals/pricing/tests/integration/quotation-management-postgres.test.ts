import { sql } from 'drizzle-orm';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';

const tenantId = 'e7970000-0000-4000-8000-000000000901';
const legalEntityId = 'e7970000-0000-4000-8000-000000000902';
const principalId = 'e7970000-0000-4000-8000-000000000903';
const otherPrincipalId = 'e7970000-0000-4000-8000-000000000904';
const actionInvocationId = 'e7970000-0000-4000-8000-000000000905';
const quotationRef = 'pricing:quotation:postgres:797';
const commandFingerprint = 'a'.repeat(64);

const quotation = {
  binding: {
    commercialScope: { sellingLegalEntityId: legalEntityId },
    currencyCode: 'CZK',
    monetaryBoundary: 'PRE_TAX',
    tenantId,
  },
  issuedAt: '2026-09-28T10:00:00.000Z',
  kind: 'PRICING_QUOTATION',
  materialEvidence: { evidenceRef: 'material-evidence:original' },
  quotationRef,
  quotedResult: { exactPreTaxAmount: '100.000000000', sourceRef: 'price-revision:original' },
  validity: {
    policyEvidence: {
      maximumValidityDurationMilliseconds: 3_600_000,
      policyRef: 'pricing-quotation-validity',
      policyVersion: '1',
    },
    validFrom: '2026-09-28T10:00:00.000Z',
    validUntil: '2026-09-28T10:30:00.000Z',
  },
};

interface QuotationSqlPayload {
  readonly actionInvocationId?: string;
  readonly commandFingerprint?: string;
  readonly outcome: string;
  readonly quotation?: typeof quotation;
  readonly quotationRef?: string;
}

interface PrincipalColumnMigrationMetadata extends Record<string, unknown> {
  readonly column_is_not_null: boolean;
  readonly constraint_is_validated: boolean;
  readonly constraint_name: string;
  readonly table_name: string;
}

it.live('keeps unattributable historical receipts nullable while requiring principals on every new receipt', () =>
  Effect.scoped(
    Effect.gen(function* receiptPrincipalMigrationContract() {
      const { admin: adminClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);

      const metadata = yield* admin.execute<PrincipalColumnMigrationMetadata>(
        sql`select
          attribute.attnotnull as column_is_not_null,
          constraint_record.convalidated as constraint_is_validated,
          constraint_record.conname as constraint_name,
          relation.relname as table_name
        from pg_catalog.pg_attribute as attribute
        join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
        join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        join pg_catalog.pg_constraint as constraint_record
          on constraint_record.conrelid = relation.oid
         and constraint_record.contype = 'c'
         and pg_catalog.pg_get_constraintdef(constraint_record.oid) like '%acting_principal_id IS NOT NULL%'
        where namespace.nspname = 'pricing'
          and relation.relname in (
            'contractual_discount_action_invocation_receipts',
            'zero_floor_action_invocation_receipts'
          )
          and attribute.attname = 'acting_principal_id'
        order by relation.relname`,
        'objects',
      );
      expect(metadata).toEqual([
        {
          column_is_not_null: false,
          constraint_is_validated: false,
          constraint_name: 'pricing_contractual_discount_receipts_principal_ck',
          table_name: 'contractual_discount_action_invocation_receipts',
        },
        {
          column_is_not_null: false,
          constraint_is_validated: false,
          constraint_name: 'pricing_zero_floor_action_receipts_principal_ck',
          table_name: 'zero_floor_action_invocation_receipts',
        },
      ]);

      yield* admin.execute(sql`
        do $migration_contract$
        begin
          begin
            insert into pricing.contractual_discount_action_invocation_receipts (
              tenant_id, legal_entity_id, action_invocation_id, command_fingerprint, outcome
            ) values (
              'e7970000-0000-4000-8000-000000000911'::uuid,
              'e7970000-0000-4000-8000-000000000912'::uuid,
              'e7970000-0000-4000-8000-000000000913'::uuid,
              repeat('a', 64),
              '{}'::jsonb
            );
            raise exception 'contractual discount receipt accepted a missing principal';
          exception when check_violation then
            null;
          end;

          begin
            insert into pricing.zero_floor_action_invocation_receipts (
              tenant_id, legal_entity_id, action_invocation_id, command_fingerprint, outcome
            ) values (
              'e7970000-0000-4000-8000-000000000911'::uuid,
              'e7970000-0000-4000-8000-000000000912'::uuid,
              'migration-contract:missing-principal',
              repeat('b', 64),
              '{}'::jsonb
            );
            raise exception 'ZERO_FLOOR receipt accepted a missing principal';
          exception when check_violation then
            null;
          end;
        end
        $migration_contract$;
      `);
    }),
  ),
);

it.live('keeps exact pre-Tax Quotation terms immutable and scopes result lookup to the original principal', () =>
  Effect.scoped(
    Effect.gen(function* quotationPostgresContract() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const cleanup = admin.execute(sql`delete from pricing.pricing_quotations where tenant_id = ${tenantId}::uuid`);
      yield* cleanup;
      yield* Effect.addFinalizer(() => cleanup.pipe(Effect.orDie));

      const persist = (
        input: {
          readonly actionId?: string;
          readonly fingerprint?: string;
          readonly principal?: string;
          readonly quote?: object;
        } = {},
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* persistQuotation() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true),
              set_config('ontos.legal_entity_id', ${legalEntityId}, true)`);
            const encodedQuotation = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              input.quote ?? quotation,
            );
            const rows = yield* transaction.execute<{ readonly payload: QuotationSqlPayload }>(
              sql`select payload from pricing.persist_pricing_quotation_v1(
                ${tenantId}::uuid, ${legalEntityId}::uuid,
                ${input.principal ?? principalId}::uuid,
                ${input.actionId ?? actionInvocationId}::uuid,
                ${input.fingerprint ?? commandFingerprint},
                ${encodedQuotation}::jsonb)`,
              'objects',
            );
            const [first] = rows;
            if (rows.length !== 1 || first === undefined) {
              return yield* Effect.die('Quotation persistence returned an ambiguous result');
            }
            return first.payload;
          }),
        );
      const read = (input: { readonly by: 'invocation' | 'reference'; readonly principal?: string }) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* readQuotation() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true),
              set_config('ontos.legal_entity_id', ${legalEntityId}, true)`);
            const principal = input.principal ?? principalId;
            const rows =
              input.by === 'invocation'
                ? yield* transaction.execute<{ readonly payload: QuotationSqlPayload }>(
                    sql`select payload from pricing.lookup_pricing_quotation_invocation_v1(
                    ${tenantId}::uuid, ${legalEntityId}::uuid, ${principal}::uuid, ${actionInvocationId}::uuid)`,
                    'objects',
                  )
                : yield* transaction.execute<{ readonly payload: QuotationSqlPayload }>(
                    sql`select payload from pricing.read_pricing_quotation_v1(
                    ${tenantId}::uuid, ${legalEntityId}::uuid, ${principal}::uuid, ${quotationRef})`,
                    'objects',
                  );
            const [first] = rows;
            if (rows.length !== 1 || first === undefined) {
              return yield* Effect.die('Quotation lookup returned an ambiguous result');
            }
            return first.payload;
          }),
        );

      expect(yield* persist()).toMatchObject({ outcome: 'STORED', quotation });
      expect(yield* persist()).toMatchObject({ outcome: 'REUSED', quotation });
      expect(yield* read({ by: 'invocation' })).toMatchObject({
        actionInvocationId,
        commandFingerprint,
        outcome: 'FOUND',
        quotation,
      });
      expect(yield* read({ by: 'reference' })).toMatchObject({ outcome: 'FOUND', quotation });
      expect(yield* read({ by: 'invocation', principal: otherPrincipalId })).toMatchObject({
        outcome: 'NOT_FOUND',
      });
      expect(yield* read({ by: 'reference', principal: otherPrincipalId })).toMatchObject({
        outcome: 'NOT_FOUND',
      });
      const history = (principal: string) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* readQuotationHistory() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true),
              set_config('ontos.legal_entity_id', ${legalEntityId}, true)`);
            return yield* transaction.execute<{ readonly payload: QuotationSqlPayload }>(
              sql`select payload from pricing.read_pricing_quotation_history_v1(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${principal}::uuid, 100)`,
              'objects',
            );
          }),
        );
      expect((yield* history(principalId)).map(({ payload }) => payload)).toMatchObject([
        { outcome: 'FOUND', quotation, quotationRef },
      ]);
      expect(yield* history(otherPrincipalId)).toEqual([]);

      const changedTerms = {
        ...quotation,
        quotedResult: { ...quotation.quotedResult, exactPreTaxAmount: '101.000000000' },
      };
      expect(yield* persist({ quote: changedTerms })).toMatchObject({ outcome: 'IDENTITY_CONFLICT' });
      expect(yield* persist({ fingerprint: 'b'.repeat(64) })).toMatchObject({ outcome: 'IDENTITY_CONFLICT' });
      expect(yield* persist({ principal: otherPrincipalId })).toMatchObject({ outcome: 'IDENTITY_CONFLICT' });
      expect(yield* persist({ actionId: otherPrincipalId })).toMatchObject({ outcome: 'IDENTITY_CONFLICT' });
      expect(yield* read({ by: 'reference' })).toMatchObject({ outcome: 'FOUND', quotation });

      const invalidValidity = yield* persist({
        actionId: 'e7970000-0000-4000-8000-000000000906',
        quote: {
          ...quotation,
          quotationRef: 'pricing:quotation:postgres:797:invalid-validity',
          validity: { ...quotation.validity, validUntil: '2026-09-28T12:00:00.000Z' },
        },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(invalidValidity)).toBe(true);

      const wrongScope = yield* persist({
        actionId: 'e7970000-0000-4000-8000-000000000907',
        quote: {
          ...quotation,
          binding: { ...quotation.binding, tenantId: 'e7970000-0000-4000-8000-000000000999' },
          quotationRef: 'pricing:quotation:postgres:797:wrong-scope',
        },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(wrongScope)).toBe(true);

      const [grants] = yield* admin.execute<{
        readonly delete_allowed: boolean;
        readonly insert_allowed: boolean;
        readonly select_allowed: boolean;
        readonly update_allowed: boolean;
      }>(
        sql`select
        has_table_privilege('ontos_runtime', 'pricing.pricing_quotations', 'DELETE') as delete_allowed,
        has_table_privilege('ontos_runtime', 'pricing.pricing_quotations', 'INSERT') as insert_allowed,
        has_table_privilege('ontos_runtime', 'pricing.pricing_quotations', 'SELECT') as select_allowed,
        has_table_privilege('ontos_runtime', 'pricing.pricing_quotations', 'UPDATE') as update_allowed`,
        'objects',
      );
      expect(grants).toEqual({
        delete_allowed: false,
        insert_allowed: true,
        select_allowed: true,
        update_allowed: false,
      });
    }),
  ),
);
