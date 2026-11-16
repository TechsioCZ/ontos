// Exact-target employee reads of the Zaměstnanci page over the generated records client.
import type { EffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import type { RecordsRequest } from '../../../../../shared/apis/records.ts';
import { executeRecords } from '../../../../api/records-client.ts';

/** Exact-target reads opt out explicitly; the generated client forwards these canonical transport options. */
export const executeFreshRecords = (payload: RecordsRequest, requestCorrelation: string) => {
  const options: Pick<EffectBffClientOptions, 'baseUrl' | 'compositionRevision' | 'requestCache'> = {
    requestCache: 'no-store',
  };
  return executeRecords(payload, requestCorrelation, options);
};
