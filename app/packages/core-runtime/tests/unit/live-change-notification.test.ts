import { Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { decodeLiveChange, encodeLiveChange } from '../../src/live/change-notification.ts';

const tenantId = '0b9c7f3e-4e9a-4d5c-9f51-2a1c8e7d6b40';
const legalEntityId = '5d2f4a91-7c3b-4e8f-a6d0-1b9e8c7f2a35';

describe('live change notifications', () => {
  it('round-trips a legal-entity scoped change with sorted unique module ids', () => {
    const payload = encodeLiveChange({
      legalEntityId,
      moduleKeys: ['sales.pipeline', 'crm', 'crm'],
      tenantId,
    });
    expect(payload).toEqual(Option.some(`${tenantId}|${legalEntityId}|crm,sales.pipeline`));
    expect(payload.pipe(Option.flatMap(decodeLiveChange))).toEqual(
      Option.some({ legalEntityId, moduleKeys: ['crm', 'sales.pipeline'], tenantId }),
    );
  });

  it('round-trips a tenant-wide change', () => {
    const payload = encodeLiveChange({ legalEntityId: null, moduleKeys: ['finance.billing'], tenantId });
    expect(payload.pipe(Option.flatMap(decodeLiveChange))).toEqual(
      Option.some({ legalEntityId: null, moduleKeys: ['finance.billing'], tenantId }),
    );
  });

  it('publishes nothing without a valid scope or module', () => {
    expect(encodeLiveChange({ legalEntityId, moduleKeys: [], tenantId })).toEqual(Option.none());
    expect(encodeLiveChange({ legalEntityId, moduleKeys: ['crm'], tenantId: 'tenant' })).toEqual(Option.none());
    expect(encodeLiveChange({ legalEntityId: 'x', moduleKeys: ['crm'], tenantId })).toEqual(Option.none());
    expect(encodeLiveChange({ legalEntityId, moduleKeys: ['Bad|Key'], tenantId })).toEqual(Option.none());
  });

  it('rejects malformed payloads from the channel', () => {
    expect(decodeLiveChange('')).toEqual(Option.none());
    expect(decodeLiveChange(`${tenantId}|${legalEntityId}`)).toEqual(Option.none());
    expect(decodeLiveChange(`${tenantId}|${legalEntityId}|crm|extra`)).toEqual(Option.none());
    expect(decodeLiveChange(`${tenantId}|nope|crm`)).toEqual(Option.none());
    expect(decodeLiveChange(`${tenantId}||CRM`)).toEqual(Option.none());
  });
});
