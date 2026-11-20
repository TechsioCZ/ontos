import { getTableConfig } from 'drizzle-orm/pg-core';
import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AUTH_MESSAGE_KINDS,
  assessCategoryConfiguration,
  authTypeEvidence,
  communicationsOwnDataInventory,
  INVENTORY_CATEGORY_IDS,
  inventoryCategory,
  noSuppliedPrivacyReferences,
  REQUIRED_INPUT_KEYS,
  TECHNICAL_COLUMN_REASONS,
  TECHNICAL_COLUMNS,
  ruleApplicableAt,
  TABLES_WITHOUT_PERSONAL_DATA,
} from '../../shared/privacy-owner/inventory.ts';
import type { SuppliedCategoryPrivacyReference } from '../../shared/privacy-owner/inventory.ts';
import { COMMUNICATIONS_TABLES, COMMUNICATIONS_TABLE_INVENTORY } from '../../src/database/schema.ts';

const tables = new Map(COMMUNICATIONS_TABLES.map((table) => [getTableConfig(table).name, getTableConfig(table)]));
const category = inventoryCategory;

/** A FICTIONAL, complete set of references for one category, used only to prove the states; nothing here is a legal value. */
const fictionalComplete = (
  overrides: Partial<SuppliedCategoryPrivacyReference> = {},
): SuppliedCategoryPrivacyReference => ({
  businessStartConfirmationRef: 'FICTIONAL-start-confirmation',
  controllerRef: 'FICTIONAL-controller',
  controllerRole: 'CONTROLLER',
  dataCategoryRefs: ['FICTIONAL-data-category'],
  humanDispositionOwnerRef: 'FICTIONAL-human-owner',
  legalHoldApplicabilityRef: 'FICTIONAL-legal-hold-assessment',
  processingScopeRef: 'FICTIONAL-processing-scope',
  purposeRef: 'FICTIONAL-purpose',
  purposeVersion: 1,
  retentionRules: [
    { applicabilityDecisionRef: 'FICTIONAL-applicability-1', ruleRef: 'FICTIONAL-rule', ruleVersion: 1 },
  ],
  ...overrides,
});

const storedBy = (id: Parameters<typeof category>[0], table: string) =>
  category(id).storage.find((entry) => entry.table === table)?.columns ?? [];

describe('Communications own-data inventory (#1410 AC-01 AC-03, PRIV-COM-01/02)', () => {
  it('declares the seven categories of the issue, each with the owner capability and its own content scope', () => {
    expect(communicationsOwnDataInventory.map(({ id }) => id)).toEqual([...INVENTORY_CATEGORY_IDS]);
    expect(INVENTORY_CATEGORY_IDS).toHaveLength(7);
    expect(new Set(communicationsOwnDataInventory.map(({ recordContentScope }) => recordContentScope)).size).toBe(7);
    expect(
      communicationsOwnDataInventory.every(({ ownerCapability }) => ownerCapability === 'communications.core'),
    ).toBe(true);
  });

  it('names only tables and columns the owner schema really has, and starts retention from an immutable existing column', () => {
    for (const { businessStart, storage } of communicationsOwnDataInventory) {
      for (const { columns, table } of storage) {
        const config = tables.get(table);
        expect(config, `table ${table}`).toBeDefined();
        const names = new Set(config?.columns.map(({ name }) => name));
        for (const column of columns) {
          expect(names.has(column), `${table}.${column}`).toBe(true);
        }
      }
      if (businessStart !== null) {
        expect(tables.get(businessStart.table)?.columns.some(({ name }) => name === businessStart.column)).toBe(true);
      }
    }
  });

  it('leaves no owner table unclassified: a table of a later lane must be declared before it can pass', () => {
    const classified = new Set([
      ...communicationsOwnDataInventory.flatMap(({ storage }) => storage.map(({ table }) => table)),
      ...Object.keys(TABLES_WITHOUT_PERSONAL_DATA),
    ]);
    expect([...COMMUNICATIONS_TABLE_INVENTORY].filter((table) => !classified.has(table))).toEqual([]);
  });

  it('classifies EVERY column of every owner table: stored by exactly one category, or technical with a stated reason', () => {
    const stored = new Map<string, string[]>();
    for (const { id, storage } of communicationsOwnDataInventory) {
      for (const { columns, table } of storage) {
        for (const column of columns) {
          stored.set(`${table}.${column}`, [...(stored.get(`${table}.${column}`) ?? []), id]);
        }
      }
    }
    const unclassified: string[] = [];
    const doubled: string[] = [];
    for (const [table, config] of tables) {
      if (table in TABLES_WITHOUT_PERSONAL_DATA) {
        continue;
      }
      for (const { name } of config.columns) {
        const key = `${table}.${name}`;
        const technical = TECHNICAL_COLUMNS[table]?.[name];
        const categories = stored.get(key) ?? [];
        if (categories.length === 0 && technical === undefined) {
          unclassified.push(key);
        }
        if (categories.length > 0 && technical !== undefined) {
          doubled.push(key);
        }
      }
    }
    // a column no category stores and no reason excuses would be personal data nobody can find; a category that also calls it
    // technical contradicts itself
    expect(unclassified).toEqual([]);
    expect(doubled).toEqual([]);
  });

  it('names no technical column that does not exist, and states a real reason for each', () => {
    const missing = Object.entries(TECHNICAL_COLUMNS).flatMap(([table, columns]) =>
      Object.keys(columns).flatMap((column) =>
        tables.get(table)?.columns.some(({ name }) => name === column) === true ? [] : [`${table}.${column}`],
      ),
    );
    expect(missing).toEqual([]);
    for (const reason of Object.values(TECHNICAL_COLUMNS).flatMap((columns) => Object.values(columns))) {
      expect(TECHNICAL_COLUMN_REASONS[reason].length).toBeGreaterThan(20);
    }
  });

  it('keeps the previously unclassified personal-data-bearing columns inside their categories', () => {
    expect(storedBy('REQUEST_DECISION_INTENT', 'communication_requests')).toEqual(
      expect.arrayContaining(['occurrence_id', 'scope_key', 'fingerprint']),
    );
    expect(storedBy('REQUEST_DECISION_INTENT', 'message_intents')).toEqual(
      expect.arrayContaining(['processing_scope', 'intent_key', 'slot_key']),
    );
    expect(storedBy('ATTEMPTS_PROVIDER_OBSERVATIONS_SUPPRESSION', 'provider_observations')).toEqual(
      expect.arrayContaining(['attempt_id', 'observed_at']),
    );
  });

  it('keeps the rendered content and attachment categories empty: nothing is persisted for them and no column suggests it', () => {
    for (const id of ['TEMPORARY_RENDERED_CONTENT', 'ATTACHMENT_LINK_REFERENCES'] as const) {
      expect(category(id).copyKind).toBe('NONE_PERSISTED');
      expect(category(id).storage).toEqual([]);
    }
    const suspicious =
      /(?:^|_)(?:body_text|rendered|html|attachment|document_url|download|secret|token|password|otp|address|email)(?:_|$)/u;
    const offending = COMMUNICATIONS_TABLES.flatMap((table) =>
      getTableConfig(table)
        .columns.map(({ name }) => `${getTableConfig(table).name}.${name}`)
        // the template body is the approved TEMPLATE text with placeholders, not personalized content
        .filter((name) => suspicious.test(name.split('.')[1] ?? '') && name !== 'template_revisions.body'),
    );
    expect(offending).toEqual([]);
  });

  it('keeps the product-owner minimization: no category stores a full body, an Auth secret or a raw address', () => {
    for (const { excludedContent, id } of communicationsOwnDataInventory) {
      expect(excludedContent.length, id).toBeGreaterThan(0);
    }
    const requestFacts = category('REQUEST_DECISION_INTENT');
    expect(requestFacts.excludedContent).toEqual(
      expect.arrayContaining(['FULL_PERSONALIZED_BODY', 'RAW_ENDPOINT_ADDRESS', 'AUTH_SECRET_OR_PROOF']),
    );
    expect(category('ORIGINAL_RECIPIENT_ENDPOINT').copyKind).toBe('LOCAL_REFERENCE_ONLY');
  });
});

describe('Input gates and configuration gaps (#1410 AC-03, PRIV-COM-09)', () => {
  it('invents no value: with nothing supplied every persisted category is a CONFIGURATION GAP naming the owner of each input', () => {
    for (const { copyKind, id } of communicationsOwnDataInventory) {
      const state = assessCategoryConfiguration(category(id), noSuppliedPrivacyReferences[id]);
      if (copyKind === 'NONE_PERSISTED') {
        expect(state).toEqual({ reason: 'NO_PERSONAL_DATA_PERSISTED', state: 'NOT_APPLICABLE' });
      } else {
        expect(state.state).toBe('CONFIGURATION_GAP');
        if (state.state === 'CONFIGURATION_GAP') {
          expect(state.gaps.map(({ input }) => input).toSorted()).toEqual([...REQUIRED_INPUT_KEYS].toSorted());
          expect(state.gaps.every(({ owner }) => owner.length > 0)).toBe(true);
        }
      }
    }
  });

  it('is never retain-forever, delete-done or a default period: the only states are gap, conflict, configured or not applicable', () => {
    const states = communicationsOwnDataInventory.map(({ id }) => assessCategoryConfiguration(category(id)).state);
    expect(new Set(states)).toEqual(new Set(['CONFIGURATION_GAP', 'NOT_APPLICABLE']));
  });

  it('is configured only when every input is supplied, and one missing input is still a gap that names its owner', () => {
    const target = category('REQUEST_DECISION_INTENT');
    expect(assessCategoryConfiguration(target, fictionalComplete()).state).toBe('CONFIGURED');
    const withoutRule = assessCategoryConfiguration(target, fictionalComplete({ retentionRules: [] }));
    expect(withoutRule).toEqual({
      gaps: [{ input: 'RETENTION_RULE_IDENTITY_VERSION', owner: 'PRIVACY_OWNER' }],
      state: 'CONFIGURATION_GAP',
    });
    const withoutHold = assessCategoryConfiguration(target, fictionalComplete({ legalHoldApplicabilityRef: ' ' }));
    expect(withoutHold).toEqual({
      gaps: [{ input: 'LEGAL_HOLD_APPLICABILITY', owner: 'LEGAL' }],
      state: 'CONFIGURATION_GAP',
    });
  });

  it('treats two different rules for the same applicability as a conflict, not a choice', () => {
    const state = assessCategoryConfiguration(
      category('REQUEST_DECISION_INTENT'),
      fictionalComplete({
        retentionRules: [
          { applicabilityDecisionRef: 'A', ruleRef: 'FICTIONAL-rule-a', ruleVersion: 1 },
          { applicabilityDecisionRef: 'B', ruleRef: 'FICTIONAL-rule-b', ruleVersion: 1 },
        ],
      }),
    );
    expect(state.state).toBe('CONFLICTING_CONFIGURATION');
  });

  it('never lets a new rule version rewrite an earlier record: a version applies from its own start and not before (PRIV-COM-15)', () => {
    const rules = [
      { applicabilityDecisionRef: 'A', ruleRef: 'FICTIONAL-rule', ruleVersion: 1 },
      {
        applicabilityDecisionRef: 'B',
        applicableStartFrom: DateTime.makeUnsafe('2026-12-01T00:00:00.000Z'),
        ruleRef: 'FICTIONAL-rule',
        ruleVersion: 2,
      },
    ] as const;
    expect(
      assessCategoryConfiguration(category('REQUEST_DECISION_INTENT'), fictionalComplete({ retentionRules: rules }))
        .state,
    ).toBe('CONFIGURED');
    expect(ruleApplicableAt(rules, DateTime.makeUnsafe('2026-11-19T10:00:00.000Z'))?.ruleVersion).toBe(1);
    expect(ruleApplicableAt(rules, DateTime.makeUnsafe('2026-12-01T00:00:00.000Z'))?.ruleVersion).toBe(2);
    // the evaluation date is irrelevant: only the record's own original start selects the version
    expect(ruleApplicableAt(rules, DateTime.makeUnsafe('2026-11-30T23:59:59.000Z'))?.ruleVersion).toBe(1);
  });

  it('names, for each of the three Auth types, the owner that must supply every missing input (comment, J)', () => {
    expect(authTypeEvidence.map(({ kind }) => kind)).toEqual([...AUTH_MESSAGE_KINDS]);
    for (const evidence of authTypeEvidence) {
      expect(evidence.secretOwner).toBe('PORTAL_AUTH_OWNER');
      const inputs = new Set(evidence.missingInputs.map(({ input }) => input));
      for (const input of REQUIRED_INPUT_KEYS) {
        expect(inputs.has(input), `${evidence.kind} ${input}`).toBe(true);
      }
      expect(evidence.missingInputs.every(({ owner }) => owner.length > 0)).toBe(true);
      expect(evidence.missingInputs.some(({ owner }) => owner === 'PORTAL_AUTH_OWNER')).toBe(true);
    }
  });
});
