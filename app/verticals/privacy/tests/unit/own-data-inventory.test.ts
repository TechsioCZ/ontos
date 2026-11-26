import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import { PreVerificationBindingRecordSchema } from '../../shared/domain/pre-verification-binding.ts';
import {
  PRE_VERIFICATION_BINDING_RECORD_FIELDS,
  PRIVACY_OWN_DATA_CATEGORY_IDS,
  privacyOwnDataInventory,
  RETENTION_INPUT_KEYS,
  TABLES_PREDATING_OWN_DATA_INVENTORY,
  TECHNICAL_COLUMN_REASONS,
  TECHNICAL_COLUMNS,
} from '../../src/database/own-data-inventory.ts';
import {
  PRIVACY_TABLE_INVENTORY,
  PRIVACY_TABLES,
  PRIVACY_TENANT_SCOPED_TABLE_INVENTORY,
} from '../../src/database/schema.ts';

const tables = new Map(PRIVACY_TABLES.map((table) => [getTableConfig(table).name, getTableConfig(table)]));
const inventoriedTables = new Set(privacyOwnDataInventory.flatMap(({ storage }) => storage.map(({ table }) => table)));

describe('Privacy own-data inventory (#1406)', () => {
  it('declares every category once, each with its own content scope', () => {
    expect(privacyOwnDataInventory.map(({ id }) => id)).toEqual([...PRIVACY_OWN_DATA_CATEGORY_IDS]);
    const scopes = privacyOwnDataInventory.map(({ recordContentScope }) => recordContentScope);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('inventories the pre-verification binding table added by D21 and every Tenant-scoped Privacy table', () => {
    expect(inventoriedTables.has('pre_verification_bindings')).toBe(true);
    for (const table of PRIVACY_TENANT_SCOPED_TABLE_INVENTORY) {
      expect(inventoriedTables.has(table), table).toBe(true);
    }
  });

  it('names only tables and columns the Privacy schema really has, and a retention start candidate that exists', () => {
    for (const { businessStartCandidate, storage } of privacyOwnDataInventory) {
      for (const { columns, table } of storage) {
        const names = new Set(tables.get(table)?.columns.map(({ name }) => name));
        expect(names.size, table).toBeGreaterThan(0);
        for (const column of columns) {
          expect(names.has(column), `${table}.${column}`).toBe(true);
        }
      }
      const startColumns = tables.get(businessStartCandidate.table)?.columns ?? [];
      expect(startColumns.some(({ name }) => name === businessStartCandidate.column)).toBe(true);
    }
  });

  it('leaves no column of an inventoried table unclassified, and no column in both lists', () => {
    for (const table of inventoriedTables) {
      const stored = new Set(
        privacyOwnDataInventory.flatMap(({ storage }) =>
          storage.filter((entry) => entry.table === table).flatMap(({ columns }) => columns),
        ),
      );
      const technical = Object.keys(TECHNICAL_COLUMNS[table] ?? {});
      expect(
        technical.filter((column) => stored.has(column)),
        table,
      ).toEqual([]);
      const classified = new Set([...stored, ...technical]);
      const columns = tables.get(table)?.columns.map(({ name }) => name) ?? [];
      expect(
        columns.filter((column) => !classified.has(column)),
        table,
      ).toEqual([]);
    }
    for (const reasons of Object.values(TECHNICAL_COLUMNS)) {
      for (const reason of Object.values(reasons ?? {})) {
        expect(Object.keys(TECHNICAL_COLUMN_REASONS)).toContain(reason);
      }
    }
  });

  it('classifies every field of the stored binding record, so a field added later cannot pass unseen', () => {
    expect(new Set(Object.keys(PRE_VERIFICATION_BINDING_RECORD_FIELDS))).toEqual(
      new Set(Object.keys(PreVerificationBindingRecordSchema.fields)),
    );
    // the record carries no address, token, link or code field
    expect(
      Object.keys(PreVerificationBindingRecordSchema.fields).filter((field) =>
        /address|email|phone|token|secret|code|link|otp|password/iu.test(field),
      ),
    ).toEqual([]);
  });

  it('accounts for every Privacy table: inventoried, or one of the closed list that predates the inventory', () => {
    const predating = new Set(TABLES_PREDATING_OWN_DATA_INVENTORY);
    expect(predating.size).toBe(TABLES_PREDATING_OWN_DATA_INVENTORY.length);
    expect([...inventoriedTables].filter((table) => predating.has(table))).toEqual([]);
    expect(
      [...PRIVACY_TABLE_INVENTORY].filter((table) => !inventoriedTables.has(table) && !predating.has(table)),
    ).toEqual([]);
  });

  it('states retention as a configuration gap pending the Privacy owner, never a period, basis or default', () => {
    for (const { retention } of privacyOwnDataInventory) {
      expect(retention).toEqual({
        owner: 'PRIVACY_OWNER',
        pendingInputs: [...RETENTION_INPUT_KEYS],
        state: 'CONFIGURATION_GAP',
      });
    }
    // no retention period, legal basis or purpose value appears anywhere in the declaration
    const declaration = JSON.stringify(privacyOwnDataInventory);
    expect(declaration).not.toMatch(/\b(?:P\d+[YMWD]|\d+\s*(?:day|month|year)s?)\b/iu);
    expect(declaration).not.toMatch(/legalBasis|retentionPeriod|purposeRef|controllerRef/u);
  });
});
