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
  taxPrivacyOwnerDeclaration,
  taxPrivacyOwnerScopeParts,
} from '../../shared/tax-privacy-owner-contract.ts';
import type { TaxPrivacyOwnerScopePart, TaxPrivacyScopeObservation } from '../../shared/tax-privacy-owner-contract.ts';
import {
  TAX_TABLE_INVENTORY,
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

/** `contentKind` is the stable public name in content refs; private table names never reach Privacy (#956 B). */
const coverageTable = (table: CoverageTableSource, id: AnyPgColumn, contentKind: string) => ({
  contentKind,
  id,
  table,
});

const coverageTables = {
  tax_fact_authority_contract_revisions: coverageTable(
    taxFactAuthorityContractRevisions,
    taxFactAuthorityContractRevisions.taxFactAuthorityContractRevisionId,
    'tax-fact-authority-contract-revision',
  ),
  tax_fact_authority_contracts: coverageTable(
    taxFactAuthorityContracts,
    taxFactAuthorityContracts.taxFactAuthorityContractId,
    'tax-fact-authority-contract',
  ),
  tax_rule_corrections: coverageTable(
    taxRuleCorrections,
    taxRuleCorrections.taxRuleCorrectionId,
    'tax-rule-correction',
  ),
  tax_rule_revision_end_facts: coverageTable(
    taxRuleRevisionEndFacts,
    taxRuleRevisionEndFacts.taxRuleRevisionEndFactId,
    'tax-rule-revision-end-fact',
  ),
  tax_rule_revisions: coverageTable(taxRuleRevisions, taxRuleRevisions.taxRuleRevisionId, 'tax-rule-revision'),
  tax_rules: coverageTable(taxRules, taxRules.taxRuleId, 'tax-rule'),
  tax_source_assertions: coverageTable(
    taxSourceAssertions,
    taxSourceAssertions.taxSourceAssertionId,
    'tax-source-assertion',
  ),
  tax_source_conflicts: coverageTable(
    taxSourceConflicts,
    taxSourceConflicts.taxSourceConflictId,
    'tax-source-conflict',
  ),
} as const satisfies Record<TaxTableName, ReturnType<typeof coverageTable>>;

/**
 * Private TAX tables examined per owner scope part. Attribution columns exist on every table; the Selling Legal
 * Entity content parts own disjoint table sets. A part with no tables holds no TAX persistence by declaration.
 */
export const taxPrivacyScopePartTables = {
  ACCEPTED_TAX_TERMS_COPIES: [],
  ACTOR_PRINCIPAL_ATTRIBUTION: TAX_TABLE_INVENTORY,
  EXTERNAL_COPY_AND_RECOVERY_RESPONSIBILITIES: [],
  SELLING_LEGAL_ENTITY_SOURCE_ASSERTION_HISTORY: ['tax_source_assertions'],
  SOURCE_CONFLICT_DETECTION_EVIDENCE: ['tax_source_conflicts'],
  TAX_FACT_AUTHORITY_CONTRACT_HISTORY: ['tax_fact_authority_contracts', 'tax_fact_authority_contract_revisions'],
  TAX_RULE_GOVERNANCE_HISTORY: [
    'tax_rules',
    'tax_rule_revisions',
    'tax_rule_revision_end_facts',
    'tax_rule_corrections',
  ],
} as const satisfies Record<TaxPrivacyOwnerScopePart, readonly TaxTableName[]>;

/** Opaque owner reference to one TAX record, safe to hand to Privacy without exposing its content. */
export const taxPrivacyContentRef = (contentKind: string, recordId: string): string =>
  `commerce.tax.${contentKind}:${recordId}`;

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
        .select({
          contentKind: sql<string>`${coverageTables[tableName].contentKind}::text`.as('content_kind'),
          id: sql<string>`${id}::text`.as('id'),
        })
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
    const tableNames: readonly TaxTableName[] = taxPrivacyScopePartTables[scopePart];
    const { principalIds, sellerIds } = lookupKeys(lookups);
    // Attribution is looked up by principal; seller content parts by the confirmed Selling Legal Entity.
    let rows: readonly { readonly contentKind: string; readonly id: string }[] = [];
    let examinedTables: readonly TaxTableName[] = [];
    if (scopePart === 'ACTOR_PRINCIPAL_ATTRIBUTION' && principalIds.length > 0) {
      rows = yield* enumerate(tableNames, Option.some(principalIds));
      examinedTables = tableNames;
    } else if (scopePart !== 'ACTOR_PRINCIPAL_ATTRIBUTION' && sellerIds.length > 0) {
      rows = yield* enumerate(tableNames, Option.none());
      examinedTables = tableNames;
    }
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const foundContentRefs = rows.map(({ contentKind, id }) => taxPrivacyContentRef(contentKind, id)).toSorted(byText);
    const evidence = taxMeaningFingerprint({
      // Only tables actually enumerated for this lookup kind; a part no lookup applies to examined nothing.
      examinedTables: [...examinedTables],
      foundContentRefs,
      legalEntityId,
      lookupRefs: lookups.map(({ lookupRef }) => lookupRef).toSorted(byText),
      scopePart,
      tenantId,
    });
    // The examined seller is explicit: TAX evidence is isolated per Selling Legal Entity (#956 F21).
    const observation = {
      coverageStatus: 'COMPLETE',
      evidenceRefs: [`commerce.tax/privacy-owner-coverage/${legalEntityId}/${scopePart}/${evidence}`],
      foundContentRefs,
      observedAt,
      scopePart,
    } satisfies TaxPrivacyScopeObservation;
    // A staff principal may be attributed under other sellers this seller-bound read cannot see, so attribution
    // coverage is never complete for a principal and can never yield tenant-wide NO_DATA (#956 F19-F20).
    return scopePart === 'ACTOR_PRINCIPAL_ATTRIBUTION' && principalIds.length > 0
      ? {
          ...observation,
          coverageStatus: 'PARTIAL' as const,
          unresolvedReason: 'ATTRIBUTION_UNDER_OTHER_SELLING_LEGAL_ENTITIES_NOT_OBSERVED',
        }
      : observation;
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
        ownerDeclaration: taxPrivacyOwnerDeclaration,
      });
    },
  );

  return Object.freeze({ coverage });
};
