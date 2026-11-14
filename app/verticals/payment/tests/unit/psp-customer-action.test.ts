import { Effect, Option, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { readGatewayCustomerAction } from '../../src/api/gateway-customer-action.read.ts';
import { readGatewayReturnStatus } from '../../src/api/gateway-return-status.read.ts';
import type { PspDispatchReadPersistence } from '../../src/persistence/psp-dispatch-read-persistence.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';

const operationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const paymentId = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const returnToken = 'AbCdEfGhIjKlMnOpQrStUv';

const persistenceWith = (overrides: Partial<PspDispatchReadPersistence>): PspDispatchReadPersistence => ({
  selectCustomerAction: () => Effect.succeed(Option.none()),
  selectReconciliationDebt: () => Effect.succeed({ nextAfterOperationId: Option.none(), rows: [] }),
  selectReturnStatus: () => Effect.succeed(Option.none()),
  ...overrides,
});

it.effect('#1156 The customer redirect is returned exactly as the persistence answers it', () =>
  Effect.gen(function* customerRedirect() {
    const seen: unknown[] = [];
    const result = yield* readGatewayCustomerAction(
      { operationId, paymentId },
      persistenceWith({
        selectCustomerAction: (query) => {
          seen.push(query);
          return Effect.succeed(
            Option.some({ redirectUrl: 'https://checkout.stripe.test/c/pay/cs_1', status: 'REDIRECT_AVAILABLE' }),
          );
        },
      }),
    );
    expect(result).toEqual({ redirectUrl: 'https://checkout.stripe.test/c/pay/cs_1', status: 'REDIRECT_AVAILABLE' });
    expect(seen).toEqual([{ operationId, paymentId }]);
  }),
);

it.effect('#1156 A customer action without a provider acknowledgement carries no redirect URL', () =>
  Effect.gen(function* awaitingProvider() {
    const result = yield* readGatewayCustomerAction(
      { operationId, paymentId },
      persistenceWith({ selectCustomerAction: () => Effect.succeed(Option.some({ status: 'AWAITING_PROVIDER' })) }),
    );
    expect(result).toEqual({ status: 'AWAITING_PROVIDER' });
    expect('redirectUrl' in result).toBe(false);
  }),
);

it.effect('#1156 An operation outside the trusted scope is a typed not-found', () =>
  Effect.gen(function* customerNotFound() {
    const failure = yield* Effect.flip(readGatewayCustomerAction({ operationId, paymentId }, persistenceWith({})));
    expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
  }),
);

it.effect('#1156 A failed customer action read is typed unavailable', () =>
  Effect.gen(function* customerUnavailable() {
    const failure = yield* Effect.flip(
      readGatewayCustomerAction(
        { operationId, paymentId },
        persistenceWith({ selectCustomerAction: () => Effect.fail(paymentUnavailable('read failed')) }),
      ),
    );
    expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
  }),
);

it.effect('#1157 A return token outside the trusted scope is a typed not-found', () =>
  Effect.gen(function* returnNotFound() {
    const failure = yield* Effect.flip(readGatewayReturnStatus({ returnToken }, persistenceWith({})));
    expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
  }),
);

it.effect('#1157 The return status reports only the Payment-owned outcome and dispatch state', () =>
  Effect.gen(function* returnStatus() {
    const seen: unknown[] = [];
    const result = yield* readGatewayReturnStatus(
      { returnToken },
      persistenceWith({
        selectReturnStatus: (token) => {
          seen.push(token);
          return Effect.succeed(Option.some({ dispatchState: 'ACKNOWLEDGED', outcome: 'PENDING' }));
        },
      }),
    );
    expect(result).toEqual({ dispatchState: 'ACKNOWLEDGED', outcome: 'PENDING' });
    expect(seen).toEqual([returnToken]);
  }),
);

it.effect('#1157 A failed return status read is typed unavailable', () =>
  Effect.gen(function* returnUnavailable() {
    const failure = yield* Effect.flip(
      readGatewayReturnStatus(
        { returnToken },
        persistenceWith({ selectReturnStatus: () => Effect.fail(paymentUnavailable('read failed')) }),
      ),
    );
    expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
  }),
);
