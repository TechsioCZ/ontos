import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { executeManageMarkets } from '@app/merchandise/apis/manage-markets-action/client';
import { ManageMarketsPayloadSchema } from '@app/merchandise/apis/manage-markets-action';
import { Effect, Schema } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';

import { merchandiseCommand, saveStorefrontCatalog } from '../../src/market-admin/page-data.ts';
import { ManageCatalogPayloadSchema } from '@app/merchandise/apis/manage-catalog-action';
import type { executeManageCatalog } from '@app/merchandise/apis/manage-catalog-action/client';
import type { MarketCommandInput } from '../../src/market-admin/page-data.ts';

const manageMarkets = rstest.hoisted(() => rstest.fn<typeof executeManageMarkets>());
rstest.mock('@app/merchandise/apis/manage-markets-action/client', () => ({ executeManageMarkets: manageMarkets }));
const manageCatalog = rstest.hoisted(() => rstest.fn<typeof executeManageCatalog>());
rstest.mock('@app/merchandise/apis/manage-catalog-action/client', () => ({ executeManageCatalog: manageCatalog }));

const command: MarketCommandInput = {
  _tag: 'ConfigureMarket',
  currency: 'CZK',
  exchangeRate: '1',
  expectedRevision: 3,
  marketCode: 'CZ_MAIN',
  marketId: '11111111-1111-4111-8111-111111111111',
  offerMode: 'WHOLE_CATALOGUE',
  roundingMinor: 100,
};
/** A committed ManageMarkets answer (the client's non-proposal success). */
const committed: Effect.Success<ReturnType<typeof executeManageMarkets>> = {
  entityIds: [],
  marketRevision: 4,
  revision: 17,
};

beforeEach(() => {
  manageMarkets.mockReset();
  manageCatalog.mockReset();
});

it.effect('saves one e-shop preference with catalogue authority, revision and idempotency', () =>
  Effect.gen(function* storefrontCatalogSetting() {
    manageCatalog.mockReturnValue(Effect.succeed(committed));
    expect(yield* saveStorefrontCatalog('akros-storefront', false, 17)).toEqual({ ok: true, value: committed });
    const [payload, correlation, options] = yield* Effect.fromNullishOr(manageCatalog.mock.calls[0]);
    expect(payload).toEqual(
      Schema.decodeUnknownSync(ManageCatalogPayloadSchema)({
        command: {
          _tag: 'ConfigureStorefrontCatalog',
          mainSourceProductsOnly: false,
          storefrontAppId: 'akros-storefront',
        },
        expectedRevision: 17,
      }),
    );
    expect(options).toEqual({ idempotencyKey: correlation });
    expect(manageMarkets).not.toHaveBeenCalled();
  }),
);

it.effect('retains proposal receipts and rejects malformed storefront ids without a write', () =>
  Effect.gen(function* storefrontCatalogProposal() {
    const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
      _tag: 'ActionProposalAccepted',
      expiresAt: '2030-01-01T00:00:00.000Z',
      proposalId: '22222222-2222-4222-8222-222222222222',
    });
    manageCatalog.mockReturnValue(Effect.succeed(proposal));
    expect(yield* saveStorefrontCatalog('akros-storefront', true, 17)).toEqual({ ok: true, value: proposal });
    manageCatalog.mockClear();
    expect(yield* saveStorefrontCatalog('../invalid', true, 17)).toEqual({ ok: false, reason: 'invalid' });
    expect(manageCatalog).not.toHaveBeenCalled();
  }),
);

it.effect('uses the narrow ManageMarkets payload and one fresh correlation/idempotency identity', () =>
  Effect.gen(function* currentMarketCommand() {
    manageMarkets.mockReturnValue(Effect.succeed(committed));
    expect(yield* merchandiseCommand(command, 17)).toBe(committed);
    const [payload, correlation, options] = yield* Effect.fromNullishOr(manageMarkets.mock.calls[0]);
    expect(payload).toEqual(Schema.decodeUnknownSync(ManageMarketsPayloadSchema)({ command, expectedRevision: 17 }));
    expect(correlation).toMatch(/^commerce-market-catalog:/u);
    expect(options).toEqual({ idempotencyKey: correlation });
    expect(manageMarkets).toHaveBeenCalledTimes(1);
  }),
);

it.effect('preserves the original successful 202 proposal receipt without inventing a committed revision', () =>
  Effect.gen(function* acceptedMarketProposal() {
    const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
      _tag: 'ActionProposalAccepted',
      expiresAt: '2030-01-01T00:00:00.000Z',
      proposalId: '22222222-2222-4222-8222-222222222222',
    });
    manageMarkets.mockReturnValue(Effect.succeed(proposal));
    const result = yield* merchandiseCommand(command, 17);
    expect(result).toBe(proposal);
    expect(Schema.is(ActionProposalAcceptedSchema)(result)).toBe(true);
    expect(result).not.toHaveProperty('entityIds');
    expect(result).not.toHaveProperty('marketRevision');
    expect(result).not.toHaveProperty('revision');
    expect(manageMarkets).toHaveBeenCalledTimes(1);
  }),
);

it.effect('rejects malformed market input before calling Merchandise', () =>
  Effect.gen(function* invalidMarketCommand() {
    expect(yield* merchandiseCommand({ ...command, marketId: '' }, 17).pipe(Effect.flip)).toBe('invalid');
    expect(manageMarkets).not.toHaveBeenCalled();
  }),
);
