import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { executeManageMarkets } from '@app/merchandise/clients/manage-markets';
import { ManageMarketsPayloadSchema, ManageMarketsResultSchema } from '@app/merchandise/contracts/manage-markets';
import { Effect, Schema } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';

import { merchandiseCommand } from '../../src/market-admin/page-data.ts';
import type { MarketCommandInput } from '../../src/market-admin/page-data.ts';

const manageMarkets = rstest.hoisted(() => rstest.fn<typeof executeManageMarkets>());
rstest.mock('@app/merchandise/clients/manage-markets', () => ({ executeManageMarkets: manageMarkets }));

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
const committed = Schema.decodeUnknownSync(ManageMarketsResultSchema)({
  entityIds: [],
  marketRevision: 4,
  revision: 17,
});

beforeEach(() => {
  manageMarkets.mockReset();
});

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
    expect(Schema.is(ManageMarketsResultSchema)(result)).toBe(false);
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
