import type { ExportMeta, ExportRow } from './finance-planning.ts';

/**
 * STORMWARE POHODA XML import file (`dat:dataPack` version 2.0, one `inv:invoice` per row).
 * SKELETON: implemented by the real-accounting-export lane task "pohoda-builder".
 */
export const buildPohodaDataPack = (_rows: readonly ExportRow[], _meta: ExportMeta): string => {
  throw new Error('POHODA XML builder not implemented yet');
};
