import { describe, expect, it } from 'effect-rstest';
import { Option, Schema } from 'effect';

import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayLookupTargetSchema } from '../../src/integrations/psp/psp-request.ts';

const operationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const otherOperationId = '7d3e9a10-55b2-4f6c-8a1d-2b3c4d5e6f70';

describe('#1158 PSP provider correlation', () => {
  it('#1158 Correlation is deterministic for the same operation', () => {
    const first = deriveProviderCorrelation(operationId);
    const second = deriveProviderCorrelation(operationId);

    expect(second).toEqual(first);
    expect(first.orderReference).toBe('0f8b5c1e3a2d4c7b9e1f5a6b7c8d9e0f');
    expect(first.orderReference).toHaveLength(32);
    expect(first.idempotencyKey).toBe(`ontos-pop-${operationId}`);
  });

  it('#1158 Different operations give different provider references', () => {
    const first = deriveProviderCorrelation(operationId);
    const other = deriveProviderCorrelation(otherOperationId);

    expect(other.orderReference).not.toBe(first.orderReference);
    expect(other.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('#1158 The idempotency key is at most 255 characters', () => {
    expect(deriveProviderCorrelation(operationId).idempotencyKey.length).toBeLessThanOrEqual(255);
  });

  it('#1158 Upper-case operation ids derive the same canonical correlation', () => {
    expect(deriveProviderCorrelation(operationId.toUpperCase())).toEqual(deriveProviderCorrelation(operationId));
  });

  it('#1158 Stripe order-reference search carries exactly the derived order reference', () => {
    const { orderReference } = deriveProviderCorrelation(operationId);
    const decode = Schema.decodeUnknownOption(GatewayLookupTargetSchema);

    // `metadata[ontos_order_reference]` is written with this value and searched with it after the window.
    expect(decode({ _tag: 'ORDER_REFERENCE', orderReference })).toEqual(
      Option.some({ _tag: 'ORDER_REFERENCE', orderReference }),
    );
    expect(Option.isNone(decode({ _tag: 'ORDER_REFERENCE', orderReference: operationId }))).toBe(true);
  });
});
