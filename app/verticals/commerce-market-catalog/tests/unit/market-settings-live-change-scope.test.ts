// @rstest-environment happy-dom
// The market settings store reloads on a live change only when merchandise or this vertical changed.
import { executeRecords } from '@app/merchandise/clients/records';
import { RecordsResponseSchema } from '@app/merchandise/contracts/records';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import { expect, it, rstest } from 'effect-rstest';

import { marketSettingsData } from '../../src/market-admin/page-data.ts';

rstest.mock('@app/merchandise/clients/records');

const legalEntityId = '33333333-3333-4333-8333-333333333333';
const tenantId = '11111111-1111-4111-8111-111111111111';

const response = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: { principalId: '20000000-0000-4000-8000-000000000002', tenantId },
  canWrite: true,
  indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
  movements: [],
  orders: [],
  products: [],
  revision: 3,
});

it.live('live changes of modules the market settings do not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    rstest.mocked(executeRecords).mockReset();
    rstest.mocked(executeRecords).mockReturnValue(Effect.succeed(response));
    yield* marketSettingsData.preload(legalEntityId);
    const before = rstest.mocked(executeRecords).mock.calls.length;
    const unsubscribe = marketSettingsData.subscribe(() => {
      marketSettingsData.snapshot(legalEntityId);
    }, legalEntityId);
    globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['party-registry'] } }));
    yield* Effect.sleep('10 millis');
    expect(rstest.mocked(executeRecords).mock.calls.length).toBe(before);
    globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['merchandise'] } }));
    yield* Effect.sleep('10 millis');
    expect(rstest.mocked(executeRecords).mock.calls.length).toBe(before + 1);
    unsubscribe();
  }),
);
