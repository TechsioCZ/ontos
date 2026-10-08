import type { OperationalScope } from '@app/core-runtime';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Match, Option } from 'effect';

import type {
  TaxPrivacyOwnerCoverageRequest,
  TaxPrivacyOwnerCoverageResponse,
} from '../../shared/apis/tax-privacy-owner-coverage.ts';
import {
  assessTaxPrivacyOwnerCoverage,
  taxPrivacyContentRef,
  taxPrivacyOwnerScopeParts,
  taxPrivacyOwnerScopePartTables,
} from '../../shared/tax-privacy-owner-contract.ts';
import type { TaxPrivacyOwnerScopePart, TaxPrivacyScopeObservation } from '../../shared/tax-privacy-owner-contract.ts';
import type { TAX_TABLE_INVENTORY } from '../database/schema.ts';
import {
  taxFactAuthorityContractRevisions,
  taxFactAuthorityContracts,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSourceAssertions,
  taxSourceConflicts,
} from '../database/schema.ts';
import { taxMeaningFingerprint } from './tax-governance-fingerprint.ts';
import { query } from './tax-governance-persistence.ts';
import type { PersistenceUnavailable, ScopedTransaction } from './tax-governance-persistence.ts';

type TaxTableName = (typeof TAX_TABLE_INVENTORY)[number];

type CoverageTableSource =
  | typeof taxFactAuthorityContractRevisions
  | typeof taxFactAuthorityContracts
  | typeof taxRuleCorrections
  | typeof taxRuleRevisionEndFacts
  | typeof taxRuleRevisions
  | typeof taxRules
  | typeof taxSourceAssertions
  | typeof taxSourceConflicts;

const coverageTable = (table: CoverageTableSource, id: AnyPgColumn) => ({ id, table });

const coverageTables = {
  tax_fact_authority_contract_revisions: coverageTable(
    taxFactAuthorityContractRevisions,
    taxFactAuthorityContractRevisions.taxFactAuthorityContractRevisionId,
  ),
  tax_fact_authority_contracts: coverageTable(
    taxFactAuthorityContracts,
    taxFactAuthorityContracts.taxFactAuthorityContractId,
  ),
  tax_rule_corrections: coverageTable(taxRuleCorrections, taxRuleCorrections.taxRuleCorrectionId),
  tax_rule_revision_end_facts: coverageTable(taxRuleRevisionEndFacts, taxRuleRevisionEndFacts.taxRuleRevisionEndFactId),
  tax_rule_revisions: coverageTable(taxRuleRevisions, taxRuleRevisions.taxRuleRevisionId),
  tax_rules: coverageTable(taxRules, taxRules.taxRuleId),
  tax_source_assertions: coverageTable(taxSourceAssertions, taxSourceAssertions.taxSourceAssertionId),
  tax_source_conflicts: coverageTable(taxSourceConflicts, taxSourceConflicts.taxSourceConflictId),
} as const satisfies Record<TaxTableName, ReturnType<typeof coverageTable>>;

/** Owner-local Privacy coverage read, bound to one scoped transaction. */
export interface TaxPrivacyCoverage {
  /** None when the requested Privacy scope or seller lookup is not the trusted Tenant and Selling Legal Entity. */
  readonly coverage: (
    request: TaxPrivacyOwnerCoverageRequest,
  ) => Effect.Effect<Option.Option<TaxPrivacyOwnerCoverageResponse>, PersistenceUnavailable>;
}

const byText = (left: string, right: string) => left.localeCompare(right, 'en');

const lookupKeysOf = (lookup: TaxPrivacyOwnerCoverageRequest['trustedLookups'][number]) =>
  Match.value(lookup).pipe(
    Match.tag('ACTOR_PRINCIPAL', ({ principalId }) => ({ principalIds: [String(principalId)], sellerIds: [] })),
    Match.tag('SELLING_LEGAL_ENTITY', ({ legalEntityId }) => ({
      principalIds: [],
      sellerIds: [String(legalEntityId)],
    })),
    Match.exhaustive,
  );

/** Confirmed principal and seller identities named by Privacy's typed lookups. */
const lookupKeys = (lookups: TaxPrivacyOwnerCoverageRequest['trustedLookups']) => {
  const keys = lookups.map(lookupKeysOf);
  return {
    principalIds: keys.flatMap(({ principalIds }) => principalIds),
    sellerIds: keys.flatMap(({ sellerIds }) => sellerIds),
  };
};

export const taxPrivacyCoverageForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): TaxPrivacyCoverage => {
  const { tenantId } = scope;
  const legalEntityId = scope.legalEntityId ?? '';

  /** One statement per part: the part's tables are enumerated together, so the part has one observation. */
  const enumerate = (tableNames: readonly TaxTableName[], principalIds: Option.Option<readonly string[]>) => {
    const selects = tableNames.map((tableName) => {
      const { id, table } = coverageTables[tableName];
      const scoped = and(eq(table.tenantId, tenantId), eq(table.legalEntityId, legalEntityId));
      return transaction
        .select({ id: sql<string>`${id}::text`.as('id'), tableName: sql<string>`${tableName}::text`.as('table_name') })
        .from(table)
        .where(
          Option.match(principalIds, {
            onNone: () => scoped,
            onSome: (ids) => and(scoped, inArray(table.actorPrincipalId, [...ids])),
          }),
        );
    });
    const [first, second, ...rest] = selects;
    if (first === undefined) {
      return Effect.succeed([]);
    }
    if (second === undefined) {
      return query(first);
    }
    let union = first.unionAll(second);
    for (const select of rest) {
      union = union.unionAll(select);
    }
    return query(union);
  };

  const observe = Effect.fn('taxPrivacyCoverage.observe')(function* observeEffect(
    scopePart: TaxPrivacyOwnerScopePart,
    lookups: TaxPrivacyOwnerCoverageRequest['trustedLookups'],
  ) {
    const tableNames: readonly TaxTableName[] = taxPrivacyOwnerScopePartTables[scopePart];
    const { principalIds, sellerIds } = lookupKeys(lookups);
    // Attribution is looked up by principal; seller content parts by the confirmed Selling Legal Entity.
    let rows: readonly { readonly id: string; readonly tableName: string }[] = [];
    if (scopePart === 'ACTOR_PRINCIPAL_ATTRIBUTION' && principalIds.length > 0) {
      rows = yield* enumerate(tableNames, Option.some(principalIds));
    } else if (scopePart !== 'ACTOR_PRINCIPAL_ATTRIBUTION' && sellerIds.length > 0) {
      rows = yield* enumerate(tableNames, Option.none());
    }
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const foundContentRefs = rows.map(({ id, tableName }) => taxPrivacyContentRef(tableName, id)).toSorted(byText);
    const evidence = taxMeaningFingerprint({
      examinedTables: [...tableNames],
      foundContentRefs,
      legalEntityId,
      lookupRefs: lookups.map(({ lookupRef }) => lookupRef).toSorted(byText),
      scopePart,
      tenantId,
    });
    return {
      coverageStatus: 'COMPLETE',
      evidenceRefs: [`commerce.tax/privacy-owner-coverage/${scopePart}/${evidence}`],
      foundContentRefs,
      observedAt,
      scopePart,
    } satisfies TaxPrivacyScopeObservation;
  });

  const coverage: TaxPrivacyCoverage['coverage'] = Effect.fn('taxPrivacyCoverage.coverage')(
    function* coverageEffect(request) {
      const foreignSeller = lookupKeys(request.trustedLookups).sellerIds.some((sellerId) => sellerId !== legalEntityId);
      if (scope.legalEntityId === undefined || String(request.scope.tenantId) !== tenantId || foreignSeller) {
        return Option.none();
      }
      const observations = yield* Effect.forEach(
        taxPrivacyOwnerScopeParts,
        (scopePart) => observe(scopePart, request.trustedLookups),
        { concurrency: 1 },
      );
      const scopeEncoded = { ...request.scope, tenantId: String(request.scope.tenantId) };
      return Option.some({
        coverage: assessTaxPrivacyOwnerCoverage({
          assessedAt: DateTime.formatIso(yield* DateTime.now),
          evidenceRefs: observations.flatMap(({ evidenceRefs }) => evidenceRefs),
          observations,
          scope: scopeEncoded,
        }),
      });
    },
  );

  return Object.freeze({ coverage });
};
