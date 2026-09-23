import { describe, expect, it } from 'effect-rstest';

import {
  catalogLocalOverridePermission,
  decideCatalogLocalOverrideTransition,
  isCatalogLocalOverrideFactKeyAllowed,
} from '../../src/domain/catalog-local-override.ts';
import type { CatalogLocalOverride } from '../../src/domain/catalog-source-resolution.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scope = {
  factKey: 'height',
  targetId: '22222222-2222-4222-8222-222222222222',
  targetKind: 'PRODUCT',
  tenantId,
} as const;
const override = (revision: bigint, lifecycle: 'ACTIVE' | 'RELEASED'): CatalogLocalOverride<string> => ({
  actorPrincipalId: 'principal-1',
  evidenceRef: 'evidence-1',
  lifecycle,
  reason: 'Measured correction',
  revision,
  scope,
  value: '90 cm',
});

describe('Catalog Local Override operation decisions', () => {
  it('activates a first revision only when authorized and the fact is overridable', () => {
    expect(
      decideCatalogLocalOverrideTransition({
        authorized: true,
        expectedRevision: null,
        operation: 'ACTIVATE',
        overrides: [],
        scope,
      }),
    ).toEqual({ nextRevision: 1n, status: 'PROCEED' });
    expect(
      decideCatalogLocalOverrideTransition({
        authorized: false,
        expectedRevision: null,
        operation: 'ACTIVATE',
        overrides: [],
        scope,
      }).status,
    ).toBe('PERMISSION_REQUIRED');
    expect(
      decideCatalogLocalOverrideTransition({
        authorized: true,
        expectedRevision: null,
        operation: 'ACTIVATE',
        overrides: [],
        scope: { ...scope, factKey: 'price.amount' },
      }).status,
    ).toBe('FORBIDDEN_FACT');
  });

  it('keeps at most one active winner and requires compare-and-set for change and release', () => {
    expect(
      decideCatalogLocalOverrideTransition({
        authorized: true,
        expectedRevision: null,
        operation: 'ACTIVATE',
        overrides: [override(1n, 'ACTIVE')],
        scope,
      }).status,
    ).toBe('ALREADY_ACTIVE');
    expect(
      decideCatalogLocalOverrideTransition({
        authorized: true,
        expectedRevision: 1n,
        operation: 'CHANGE',
        overrides: [override(2n, 'ACTIVE')],
        scope,
      }).status,
    ).toBe('STALE_EDITOR');
    expect(
      decideCatalogLocalOverrideTransition({
        authorized: true,
        expectedRevision: 2n,
        operation: 'CHANGE',
        overrides: [override(2n, 'ACTIVE')],
        scope,
      }).status,
    ).toBe('PROCEED');
    expect(
      decideCatalogLocalOverrideTransition({
        authorized: true,
        expectedRevision: null,
        operation: 'RELEASE',
        overrides: [override(2n, 'ACTIVE')],
        scope,
      }).status,
    ).toBe('STALE_EDITOR');
    expect(
      decideCatalogLocalOverrideTransition({
        authorized: true,
        expectedRevision: 2n,
        operation: 'RELEASE',
        overrides: [override(2n, 'ACTIVE')],
        scope,
      }),
    ).toEqual({ nextRevision: 3n, status: 'PROCEED' });
    expect(
      decideCatalogLocalOverrideTransition({
        authorized: true,
        expectedRevision: 1n,
        operation: 'RELEASE',
        overrides: [override(1n, 'RELEASED')],
        scope,
      }).status,
    ).toBe('ALREADY_RELEASED');
  });

  it('never lets an older ACTIVE revision compete with a newer revision', () => {
    expect(
      decideCatalogLocalOverrideTransition({
        authorized: true,
        expectedRevision: 2n,
        operation: 'RELEASE',
        overrides: [override(1n, 'ACTIVE'), override(2n, 'ACTIVE')],
        scope,
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('guards Price, Inventory, Party, Legal Entity, and Permission facts', () => {
    for (const factKey of ['price', 'price.amount', 'inventory:qty', 'party', 'legal-entity', 'permission']) {
      expect(isCatalogLocalOverrideFactKeyAllowed(factKey)).toBe(false);
    }
    expect(isCatalogLocalOverrideFactKeyAllowed('height')).toBe(true);
  });

  it('assigns a distinct #477 permission to activate, change, and release', () => {
    const permissions = Object.values(catalogLocalOverridePermission);
    expect(new Set(permissions).size).toBe(permissions.length);
  });
});
