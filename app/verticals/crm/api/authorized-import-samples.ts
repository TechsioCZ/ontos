import type { CrmViewer } from '../shared/domain/access.ts';
import { ordersCsvSamples } from '../shared/imports/samples.ts';
import type { OrdersCsvSample } from '../shared/imports/samples.ts';

/** Seed samples contain company-wide orders. Keep their bytes on the server for import managers only. */
export const authorizedImportSamples = (viewer: CrmViewer): readonly OrdersCsvSample[] =>
  viewer.writeAll ? ordersCsvSamples : [];
