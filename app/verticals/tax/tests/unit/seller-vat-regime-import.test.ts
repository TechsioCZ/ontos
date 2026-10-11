import { DateTime, Match, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ImportSellerVatRegimeDeclarationsPayloadSchema } from '../../shared/actions/seller-vat-regime-declaration.ts';
import {
  planSellerVatRegimeImport,
  sellerVatRegimeImportDisposition,
} from '../../src/domain/seller-vat-regime-import.ts';
import type {
  ImportedSellerVatRegimeRevision,
  SellerVatRegimeImportDisposition,
  StoredSellerVatRegimeRevision,
} from '../../src/domain/seller-vat-regime-import.ts';

const MIGRATION_STARTED_AT = '2026-03-01T00:00:00.000Z';
const RUN = 'migration-run-1';

const decodePayload = Schema.decodeUnknownResult(ImportSellerVatRegimeDeclarationsPayloadSchema, {
  onExcessProperty: 'error',
});

const payload = (declarations: readonly Readonly<Record<string, string>>[]) =>
  Result.getOrThrow(decodePayload({ declarations, migrationRunRef: RUN, migrationStartedAt: MIGRATION_STARTED_AT }));

const planOf = (declarations: readonly Readonly<Record<string, string>>[]) =>
  planSellerVatRegimeImport(payload(declarations));

const plannedRevisions = (declarations: readonly Readonly<Record<string, string>>[]) =>
  Match.value(planOf(declarations)).pipe(
    Match.tag('PLANNED', ({ revisions }) => revisions),
    Match.tag('AMBIGUOUS_SOURCE_HISTORY', () => {
      throw new Error('Expected a planned import, got AMBIGUOUS_SOURCE_HISTORY');
    }),
    Match.exhaustive,
  );

const isAmbiguous = (declarations: readonly Readonly<Record<string, string>>[]) =>
  Match.value(planOf(declarations)).pipe(
    Match.tag('AMBIGUOUS_SOURCE_HISTORY', () => true),
    Match.tag('PLANNED', () => false),
    Match.exhaustive,
  );

/** The disposition's name, read through exhaustive Match rather than a hand-written `_tag` comparison. */
const dispositionName = (disposition: SellerVatRegimeImportDisposition) =>
  Match.value(disposition).pipe(
    Match.tag('INSERT', () => 'INSERT'),
    Match.tag('REPLAY', () => 'REPLAY'),
    Match.tag('MIGRATION_RUN_CONFLICT', () => 'MIGRATION_RUN_CONFLICT'),
    Match.tag('SELLER_ALREADY_DECLARED', () => 'SELLER_ALREADY_DECLARED'),
    Match.exhaustive,
  );

const at = (instant: string) => DateTime.makeUnsafe(instant);

describe('907-Q08 Seller VAT Regime import payload', () => {
  it('907-Q08 #960 the payload needs a run, its stable migration instant and at least one source declaration', () => {
    expect(
      Result.isFailure(
        decodePayload({ declarations: [], migrationRunRef: RUN, migrationStartedAt: MIGRATION_STARTED_AT }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodePayload({
          declarations: [{ regime: 'VAT_PAYER', sourceRecordRef: 'legacy:1' }],
          migrationRunRef: '',
          migrationStartedAt: MIGRATION_STARTED_AT,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodePayload({
          declarations: [{ regime: 'VAT_PAYER', sourceRecordRef: 'x'.repeat(201) }],
          migrationRunRef: RUN,
          migrationStartedAt: MIGRATION_STARTED_AT,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodePayload({ declarations: [{ regime: 'VAT_PAYER', sourceRecordRef: 'legacy:1' }], migrationRunRef: RUN }),
      ),
    ).toBe(true);
  });

  it('907-Q08 #922 an explicit regime is required: no DIČ, zero-tax or verification fallback decodes', () => {
    for (const [index, declaration] of [
      { sourceRecordRef: 'legacy:1' },
      { dic: 'CZ00000000', sourceRecordRef: 'legacy:1' },
      { regime: 'VAT_PAYER', sourceRecordRef: 'legacy:1', verified: 'true' },
      { regime: 'ZERO_TAX', sourceRecordRef: 'legacy:1' },
    ].entries()) {
      expect(
        Result.isFailure(
          decodePayload({
            declarations: [declaration],
            migrationRunRef: RUN,
            migrationStartedAt: MIGRATION_STARTED_AT,
          }),
        ),
        `declaration ${index}`,
      ).toBe(true);
    }
  });
});

describe('907-Q08 Seller VAT Regime import plan', () => {
  it('907-Q08 #925 a current-only source state takes effect at the migration instant, never an invented earlier date', () => {
    expect(plannedRevisions([{ regime: 'NON_PAYER', sourceRecordRef: 'legacy:1' }])).toEqual([
      {
        effectiveFrom: at(MIGRATION_STARTED_AT),
        effectiveFromOrigin: 'MIGRATION_START',
        regime: 'NON_PAYER',
        revision: 1,
        sourceRecordRef: 'legacy:1',
      },
    ]);
  });

  it('907-Q08 #925 dated source history and a scheduled change keep their own dates, in effect order', () => {
    expect(
      plannedRevisions([
        { effectiveFrom: '2027-01-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:scheduled' },
        {
          effectiveFrom: '2024-01-01T00:00:00.000Z',
          reason: 'Source note',
          regime: 'NON_PAYER',
          sourceRecordRef: 'legacy:first',
        },
        { effectiveFrom: '2025-06-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:second' },
      ]),
    ).toEqual([
      {
        effectiveFrom: at('2024-01-01T00:00:00.000Z'),
        effectiveFromOrigin: 'SOURCE',
        reason: 'Source note',
        regime: 'NON_PAYER',
        revision: 1,
        sourceRecordRef: 'legacy:first',
      },
      {
        effectiveFrom: at('2025-06-01T00:00:00.000Z'),
        effectiveFromOrigin: 'SOURCE',
        regime: 'VAT_PAYER',
        revision: 2,
        sourceRecordRef: 'legacy:second',
      },
      {
        effectiveFrom: at('2027-01-01T00:00:00.000Z'),
        effectiveFromOrigin: 'SOURCE',
        regime: 'VAT_PAYER',
        revision: 3,
        sourceRecordRef: 'legacy:scheduled',
      },
    ]);
  });

  it('907-Q08 #960 ambiguous source history is rejected: duplicate dates, duplicate records, current-only beside dated', () => {
    const ambiguous = [
      [
        { effectiveFrom: '2025-01-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:1' },
        { effectiveFrom: '2025-01-01T00:00:00.000Z', regime: 'NON_PAYER', sourceRecordRef: 'legacy:2' },
      ],
      [
        { effectiveFrom: '2025-01-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:1' },
        { effectiveFrom: '2026-01-01T00:00:00.000Z', regime: 'NON_PAYER', sourceRecordRef: 'legacy:1' },
      ],
      [
        { regime: 'VAT_PAYER', sourceRecordRef: 'legacy:current' },
        { effectiveFrom: '2025-01-01T00:00:00.000Z', regime: 'NON_PAYER', sourceRecordRef: 'legacy:dated' },
      ],
      [
        { regime: 'VAT_PAYER', sourceRecordRef: 'legacy:1' },
        { regime: 'NON_PAYER', sourceRecordRef: 'legacy:2' },
      ],
    ];
    for (const [index, declarations] of ambiguous.entries()) {
      expect(isAmbiguous(declarations), `case ${index}`).toBe(true);
    }
  });
});

describe('907-Q08 Seller VAT Regime import against stored revisions', () => {
  const currentOnly: ImportedSellerVatRegimeRevision = {
    effectiveFrom: at(MIGRATION_STARTED_AT),
    effectiveFromOrigin: 'MIGRATION_START',
    regime: 'VAT_PAYER',
    revision: 1,
    sourceRecordRef: 'legacy:1',
  };
  const planned = [currentOnly];
  const storedFrom = (overrides: Partial<StoredSellerVatRegimeRevision> = {}): StoredSellerVatRegimeRevision => ({
    ...currentOnly,
    migrationRunRef: RUN,
    ...overrides,
  });
  const disposition = (stored: readonly StoredSellerVatRegimeRevision[]) =>
    dispositionName(sellerVatRegimeImportDisposition({ migrationRunRef: RUN, planned, stored }));

  it('907-Q08 #960 a seller with no revision is inserted', () => {
    expect(disposition([])).toBe('INSERT');
  });

  it('907-Q08 #925 the same run with identical content replays, keeping the same start', () => {
    expect(disposition([storedFrom()])).toBe('REPLAY');
  });

  it('907-Q08 #960 the same run with other content is a run conflict, never a shifted start', () => {
    expect(disposition([storedFrom({ effectiveFrom: at('2026-03-02T00:00:00.000Z') })])).toBe('MIGRATION_RUN_CONFLICT');
    expect(disposition([storedFrom({ regime: 'NON_PAYER' })])).toBe('MIGRATION_RUN_CONFLICT');
  });

  it('907-Q08 #922 a seller already declared directly or by another run is not imported over', () => {
    const direct: StoredSellerVatRegimeRevision = { ...currentOnly, effectiveFromOrigin: 'DECLARED' };
    expect(disposition([direct])).toBe('SELLER_ALREADY_DECLARED');
    expect(disposition([storedFrom({ migrationRunRef: 'migration-run-0' })])).toBe('SELLER_ALREADY_DECLARED');
    // A later direct declare after this run's import: the seller is declared, the import does not replay over it.
    expect(disposition([storedFrom(), { ...direct, revision: 2 }])).toBe('SELLER_ALREADY_DECLARED');
  });
});
