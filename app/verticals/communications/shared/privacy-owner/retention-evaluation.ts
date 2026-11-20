import { DateTime } from 'effect';

import {
  assessCategoryConfiguration,
  communicationsOwnDataInventory,
  inventoryCategory,
  ruleApplicableAt,
} from './inventory.ts';
import type {
  GateOwner,
  InventoryCategoryId,
  MissingInput,
  SuppliedPrivacyReferences,
  SuppliedRetentionRule,
} from './inventory.ts';

/**
 * The non-destructive Retention Evaluation hook of Communications (#588, PRIV-COM-05/06/09/15/17).
 *
 * It looks at the originating business start of each category's records and at what Privacy supplied, and it reports an
 * obligation or a configuration gap for the existing Privacy process. It never executes anything: its result type has no
 * field that could carry a performed action, no state means "deleted" or "retain forever", and the retention PERIOD is never
 * computed or defaulted here because it belongs to the approved Retention Rule (Privacy supplies the due instant).
 * Running it as a system Principal creates no consent to any owner Action.
 */

/** The ORIGINAL business start of one record, as the immutable row recorded it. A retry, import or read never changes it. */
export interface BusinessStartObservation {
  readonly category: InventoryCategoryId;
  readonly contentRef: string;
  readonly startAt: DateTime.Utc;
}

/** What Privacy's own Retention Evaluation said for a rule version: only it knows the period, so only it supplies a due instant. */
export interface PrivacyEvaluatedDue {
  readonly dueAt: DateTime.Utc;
  readonly evaluationRef: string;
  readonly ruleRef: string;
  readonly ruleVersion: number;
}

export interface ResponsibleParty {
  readonly gateOwners: readonly GateOwner[];
}

export type RetentionFinding =
  | {
      readonly category: InventoryCategoryId;
      readonly gaps: readonly MissingInput[];
      readonly kind: 'CONFIGURATION_GAP';
      readonly nextStep: 'SUPPLY_MISSING_PRIVACY_INPUTS';
      readonly pendingReview: true;
      readonly responsible: ResponsibleParty;
    }
  | {
      readonly category: InventoryCategoryId;
      readonly conflictingRuleRefs: readonly string[];
      readonly kind: 'CONFLICTING_CONFIGURATION';
      readonly nextStep: 'PRIVACY_OWNER_DECIDES_WHICH_RULE_APPLIES';
      readonly pendingReview: true;
      readonly responsible: ResponsibleParty;
    }
  | {
      readonly category: InventoryCategoryId;
      readonly earliestBusinessStartAt: DateTime.Utc | 'NO_RECORD_YET';
      readonly kind: 'HANDED_TO_PRIVACY_EVALUATION';
      readonly nextStep: 'PRIVACY_RETENTION_EVALUATION_DECIDES_DUE_DATE';
      readonly responsible: ResponsibleParty;
      readonly rule: SuppliedRetentionRule;
    }
  | {
      readonly category: InventoryCategoryId;
      readonly dueAt: DateTime.Utc;
      readonly earliestBusinessStartAt: DateTime.Utc;
      readonly kind: 'NOT_YET_DUE';
      readonly rule: SuppliedRetentionRule;
    }
  | {
      readonly category: InventoryCategoryId;
      readonly dueAt: DateTime.Utc;
      readonly earliestBusinessStartAt: DateTime.Utc;
      readonly kind: 'OBLIGATION_OPEN';
      /** Stays open until an authorized owner Action is separately evidenced; an elapsed boundary settles nothing. */
      readonly nextStep: 'PRIVACY_DISPOSITION_DECISION_AND_HUMAN_CONFIRMED_OWNER_ACTION';
      readonly responsible: ResponsibleParty;
      readonly rule: SuppliedRetentionRule;
    }
  | {
      readonly category: InventoryCategoryId;
      readonly kind: 'NOT_APPLICABLE';
      readonly reason: 'NO_PERSONAL_DATA_PERSISTED';
    };

export interface RetentionEvaluationReport {
  /** Always false: the hook identifies and hands over; it executes nothing. */
  readonly destructiveActionPerformed: false;
  readonly evaluatedAt: DateTime.Utc;
  readonly findings: readonly RetentionFinding[];
}

const earliest = (starts: readonly BusinessStartObservation[]): DateTime.Utc | undefined =>
  starts.toSorted((left, right) => DateTime.toEpochMillis(left.startAt) - DateTime.toEpochMillis(right.startAt))[0]
    ?.startAt;

const dueFor = (rule: SuppliedRetentionRule, due: readonly PrivacyEvaluatedDue[]): PrivacyEvaluatedDue | undefined =>
  due.find((candidate) => candidate.ruleRef === rule.ruleRef && candidate.ruleVersion === rule.ruleVersion);

const ruleKey = (rule: SuppliedRetentionRule): string => `${rule.ruleRef}@${String(rule.ruleVersion)}`;

/** The finding of the records that start under ONE rule version: the earliest of them decides whether it is due. */
const versionFinding = (
  categoryId: InventoryCategoryId,
  rule: SuppliedRetentionRule,
  first: DateTime.Utc | undefined,
  due: readonly PrivacyEvaluatedDue[],
  evaluatedAt: DateTime.Utc,
): RetentionFinding => {
  const evaluated = dueFor(rule, due);
  if (first === undefined || evaluated === undefined) {
    return {
      category: categoryId,
      earliestBusinessStartAt: first ?? 'NO_RECORD_YET',
      kind: 'HANDED_TO_PRIVACY_EVALUATION',
      nextStep: 'PRIVACY_RETENTION_EVALUATION_DECIDES_DUE_DATE',
      responsible: { gateOwners: ['PRIVACY_OWNER'] },
      rule,
    };
  }
  return DateTime.isGreaterThanOrEqualTo(evaluatedAt, evaluated.dueAt)
    ? {
        category: categoryId,
        dueAt: evaluated.dueAt,
        earliestBusinessStartAt: first,
        kind: 'OBLIGATION_OPEN',
        nextStep: 'PRIVACY_DISPOSITION_DECISION_AND_HUMAN_CONFIRMED_OWNER_ACTION',
        responsible: { gateOwners: ['PRIVACY_OWNER', 'PRODUCT_OWNER'] },
        rule,
      }
    : { category: categoryId, dueAt: evaluated.dueAt, earliestBusinessStartAt: first, kind: 'NOT_YET_DUE', rule };
};

/**
 * One category's findings. A rule version applies by the record's own business start, never by the evaluation date, so a
 * category whose records started under several versions has ONE finding per version: the earliest record of each version
 * decides that version, and a later record under a shorter-period version is never hidden behind an earlier record under a
 * longer one. The findings are ordered by the earliest start they cover.
 */
const findingsFor = (
  categoryId: InventoryCategoryId,
  supplied: SuppliedPrivacyReferences,
  starts: readonly BusinessStartObservation[],
  due: readonly PrivacyEvaluatedDue[],
  evaluatedAt: DateTime.Utc,
): readonly RetentionFinding[] => {
  const configuration = assessCategoryConfiguration(inventoryCategory(categoryId), supplied[categoryId]);
  if (configuration.state === 'NOT_APPLICABLE') {
    return [{ category: categoryId, kind: 'NOT_APPLICABLE', reason: configuration.reason }];
  }
  if (configuration.state === 'CONFLICTING_CONFIGURATION') {
    return [
      {
        category: categoryId,
        conflictingRuleRefs: configuration.conflictingRuleRefs,
        kind: 'CONFLICTING_CONFIGURATION',
        nextStep: 'PRIVACY_OWNER_DECIDES_WHICH_RULE_APPLIES',
        pendingReview: true,
        responsible: { gateOwners: ['PRIVACY_OWNER'] },
      },
    ];
  }
  if (configuration.state === 'CONFIGURATION_GAP') {
    return [
      {
        category: categoryId,
        gaps: configuration.gaps,
        kind: 'CONFIGURATION_GAP',
        nextStep: 'SUPPLY_MISSING_PRIVACY_INPUTS',
        pendingReview: true,
        responsible: { gateOwners: [...new Set(configuration.gaps.map(({ owner }) => owner))].toSorted() },
      },
    ];
  }
  const rules = supplied[categoryId]?.retentionRules ?? [];
  if (starts.length === 0) {
    return [versionFinding(categoryId, configuration.rule, undefined, due, evaluatedAt)];
  }
  const byVersion = new Map<string, { rule: SuppliedRetentionRule; starts: BusinessStartObservation[] }>();
  for (const start of starts) {
    const rule = ruleApplicableAt(rules, start.startAt) ?? configuration.rule;
    const group = byVersion.get(ruleKey(rule)) ?? { rule, starts: [] };
    group.starts.push(start);
    byVersion.set(ruleKey(rule), group);
  }
  return [...byVersion.values()]
    .map((group) => ({ first: earliest(group.starts), group }))
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.first ?? evaluatedAt) - DateTime.toEpochMillis(right.first ?? evaluatedAt),
    )
    .map(({ first, group }) => versionFinding(categoryId, group.rule, first, due, evaluatedAt));
};

export const evaluateCommunicationsRetention = (input: {
  readonly businessStarts: readonly BusinessStartObservation[];
  readonly evaluatedAt: DateTime.Utc;
  readonly privacyEvaluatedDue?: readonly PrivacyEvaluatedDue[];
  readonly supplied: SuppliedPrivacyReferences;
}): RetentionEvaluationReport => ({
  destructiveActionPerformed: false,
  evaluatedAt: input.evaluatedAt,
  findings: communicationsOwnDataInventory.flatMap(({ id }) =>
    findingsFor(
      id,
      input.supplied,
      input.businessStarts.filter(({ category }) => category === id),
      input.privacyEvaluatedDue ?? [],
      input.evaluatedAt,
    ),
  ),
});
