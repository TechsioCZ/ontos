import { describe, expect, it } from 'effect-rstest';
import { authorizedImportSamples } from '../../api/authorized-import-samples.ts';
import { Schema } from 'effect';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { ordersCsvTemplate, parseOrdersCsv } from '../../shared/imports/csv.ts';
import { ordersCsvSamples } from '../../shared/imports/samples.ts';

const representative = Schema.decodeUnknownSync(CrmViewerSchema)({
  assign: false,
  principalId: 'rep-a',
  readAll: false,
  readAssigned: true,
  salespersonId: 'a',
  writeAll: false,
  writeAssigned: true,
});

describe('CRM import sample authorization', () => {
  it('never includes company-wide sample bytes for a representative or a read-only lead', () => {
    expect(authorizedImportSamples(representative)).toEqual([]);
    expect(authorizedImportSamples({ ...representative, readAll: true })).toEqual([]);
  });

  it('preserves all downloadable samples for an authorized import manager', () => {
    expect(authorizedImportSamples({ ...representative, writeAll: true })).toEqual(ordersCsvSamples);
  });

  it('keeps the public template useful without reproducing any seeded order or customer identity', () => {
    const template = ordersCsvTemplate();
    const parsed = parseOrdersCsv(template);
    expect(parsed.fileError).toBeUndefined();
    expect(parsed.rows).toHaveLength(1);
    const [example] = parsed.rows;
    expect(example?.kind).toBe('ok');
    if (example?.kind !== 'ok') {
      throw new Error('Fiktivní příklad šablony není platný');
    }
    expect(example.value.customerEmail).toBe('objednavky@example.invalid');
    expect(example.value.externalId).toBe('VZOR-001');
    for (const sample of ordersCsvSamples) {
      for (const row of parseOrdersCsv(sample.csv).rows) {
        if (row.kind !== 'ok') {
          continue;
        }
        for (const key of [
          'externalId',
          'number',
          'externalCustomerId',
          'customerName',
          'customerRegNo',
          'customerEmail',
          'eventId',
        ] as const) {
          const fixture = row.value[key];
          if (fixture !== undefined) {
            expect(template.includes(fixture)).toBe(false);
          }
        }
      }
    }
  });
});
