import { Effect } from 'effect';
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Pure browser gateway value constructor, not a Context service.
import { makeOperationGateway } from './operation-gateway.ts';
import type { OperationGatewayIssuer } from './operation-gateway.ts';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type EffectChannels<Value> =
  Value extends Effect.Effect<infer Success, infer Failure, infer Requirements>
    ? readonly [Success, Failure, Requirements]
    : never;

const inventoryAudience = 'inventory-stock' as const;
const acquisitionFailure = { _tag: 'AcquisitionFailure' } as const;
const attemptFailure = { _tag: 'AttemptFailure' } as const;
const inventoryGateway = makeOperationGateway(inventoryAudience, ({ audience }) => {
  const exactAudience: typeof inventoryAudience = audience;
  return Effect.fail(acquisitionFailure).pipe(Effect.annotateLogs({ exactAudience }));
});
const failedInvocation = inventoryGateway.invoke(() => Effect.fail(attemptFailure));
const successfulInvocation = makeOperationGateway(inventoryAudience, () =>
  Effect.succeed({ expiresAt: 1_700_000_300, token: 'test-token' }),
).invoke(() => Effect.succeed('completed' as const));

type InventoryIssuer = OperationGatewayIssuer<typeof inventoryAudience, typeof acquisitionFailure>;
type InventoryAudience = Parameters<InventoryIssuer>[0]['audience'];

const audienceIsExact: Equal<InventoryAudience, 'inventory-stock'> = true;
const failureChannelsAreExact: Equal<
  EffectChannels<typeof failedInvocation>,
  readonly [never, typeof acquisitionFailure | typeof attemptFailure, never]
> = true;
const successChannelsAreExact: Equal<
  EffectChannels<typeof successfulInvocation>,
  readonly ['completed', never, never]
> = true;

void audienceIsExact;
void failureChannelsAreExact;
void successChannelsAreExact;
