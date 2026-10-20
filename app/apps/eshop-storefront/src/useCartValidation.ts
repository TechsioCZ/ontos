import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request } from './api.ts';
import type { CartItem } from './cart.tsx';
import type { CartValidation } from './shared/types.ts';

const keyOf = (items: readonly CartItem[]) => JSON.stringify(items.map((item) => [item.productId, item.variantId, item.quantity, item.priceMinor]));

export interface CartValidationState {
  readonly validation: CartValidation | undefined;
  readonly error: ApiError | undefined;
  readonly checking: boolean;
  /** True when the last server answer belongs to exactly the current cart content. */
  readonly current: boolean;
  readonly revalidate: () => void;
}

/** Re-checks the cart against live owner prices and availability on every change (debounced) and on demand. */
export const useCartValidation = (items: readonly CartItem[]): CartValidationState => {
  const key = keyOf(items);
  const [state, setState] = useState<{ validation?: CartValidation; error?: ApiError; checking: boolean; key?: string }>({ checking: items.length > 0 });
  const [nonce, setNonce] = useState(0);
  const ticket = useRef(0);
  useEffect(() => {
    const mine = ++ticket.current;
    if (items.length === 0) {
      setState({ checking: false });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ validation: previous.validation, checking: true }));
    const timer = window.setTimeout(() => {
      request<CartValidation>('/api/cart/validate', {
        body: JSON.stringify({ lines: items.map(({ priceMinor, productId, quantity, variantId }) => ({ priceMinor, productId, quantity, variantId })) }),
        method: 'POST',
        signal: controller.signal,
      })
        .then((validation) => {
          if (mine === ticket.current) setState({ checking: false, key, validation });
        })
        .catch((error: unknown) => {
          if (mine === ticket.current) setState({ checking: false, error: error instanceof ApiError ? error : new ApiError(0, { code: 'unknown', message: String(error) }), key });
        });
    }, 250);
    return () => {
      ++ticket.current;
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const revalidate = useCallback(() => setNonce((value) => value + 1), []);
  return { checking: state.checking, current: state.key === key && !state.checking && state.error === undefined, error: state.error, revalidate, validation: state.validation };
};
