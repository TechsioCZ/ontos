import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/** A temporary, non-binding cart: the browser only remembers the choice; the BFF re-validates it. */
export interface CartItem {
  readonly productId: string;
  readonly variantId: string;
  readonly slug: string;
  readonly name: string;
  readonly variantLabel: string | null;
  readonly image: string;
  readonly quantity: number;
  /** Gross unit price last confirmed by the backend and accepted by the customer. */
  readonly priceMinor: number | null;
}

interface CartApi {
  readonly items: readonly CartItem[];
  readonly count: number;
  readonly add: (item: CartItem) => void;
  readonly setQuantity: (productId: string, variantId: string, quantity: number) => void;
  readonly remove: (productId: string, variantId: string) => void;
  readonly acceptPrice: (productId: string, variantId: string, priceMinor: number) => void;
  readonly clear: () => void;
  readonly lastAdded: CartItem | null;
  readonly dismissAdded: () => void;
}

const KEY = 'kavarna-doma.cart.v1';
const read = (): CartItem[] => {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? (value as CartItem[]).filter((item) => typeof item?.productId === 'string' && item.quantity > 0) : [];
  } catch {
    return [];
  }
};

const CartContext = createContext<CartApi | null>(null);
const same = (item: CartItem, productId: string, variantId: string) => item.productId === productId && item.variantId === variantId;

export const CartProvider = ({ children }: { readonly children: ReactNode }) => {
  const [items, setItems] = useState<CartItem[]>(read);
  const [lastAdded, setLastAdded] = useState<CartItem | null>(null);
  useEffect(() => {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  }, [items]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === KEY) setItems(read());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const add = useCallback((item: CartItem) => {
    setItems((current) => {
      const existing = current.find((entry) => same(entry, item.productId, item.variantId));
      if (existing === undefined) return [...current, item];
      return current.map((entry) => (entry === existing ? { ...item, quantity: Math.min(999, entry.quantity + item.quantity) } : entry));
    });
    setLastAdded(item);
  }, []);
  const setQuantity = useCallback((productId: string, variantId: string, quantity: number) => {
    setItems((current) => current.map((entry) => (same(entry, productId, variantId) ? { ...entry, quantity: Math.max(1, Math.min(999, Math.round(quantity))) } : entry)));
  }, []);
  const remove = useCallback((productId: string, variantId: string) => {
    setItems((current) => current.filter((entry) => !same(entry, productId, variantId)));
  }, []);
  const acceptPrice = useCallback((productId: string, variantId: string, priceMinor: number) => {
    setItems((current) => current.map((entry) => (same(entry, productId, variantId) ? { ...entry, priceMinor } : entry)));
  }, []);
  const clear = useCallback(() => setItems([]), []);
  const dismissAdded = useCallback(() => setLastAdded(null), []);
  const value = useMemo<CartApi>(
    () => ({ acceptPrice, add, clear, count: items.reduce((sum, item) => sum + item.quantity, 0), dismissAdded, items, lastAdded, remove, setQuantity }),
    [acceptPrice, add, clear, dismissAdded, items, lastAdded, remove, setQuantity],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
};

export const useCart = (): CartApi => {
  const context = useContext(CartContext);
  if (context === null) throw new Error('CartProvider missing');
  return context;
};
