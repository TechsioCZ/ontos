export interface CartItemSnapshot {
  productId: string;
  variantId?: string;
  slug: string;
  name: string;
  sku: string;
  imageSrc: string;
  imageAlt: string;
  unit: string;
  stockCount: number;
  priceMinor: number;
  variantLabel?: string;
}

export interface CartLine extends CartItemSnapshot {
  quantity: number;
}

export interface CartState {
  version: 2;
  lines: CartLine[];
}

export type CartAction =
  | { type: "add"; item: CartItemSnapshot; quantity: number }
  | { type: "set-quantity"; productId: string; variantId?: string; quantity: number }
  | { type: "remove"; productId: string; variantId?: string }
  | { type: "clear" };

export const createEmptyCart = (): CartState => ({ version: 2, lines: [] });

const normalizeQuantity = (quantity: number) => Math.max(0, Math.trunc(quantity));

const isSameLine = (line: CartLine, productId: string, variantId?: string) =>
  line.productId === productId && line.variantId === variantId;

export const cartReducer = (state: CartState, action: CartAction): CartState => {
  if (action.type === "clear") return createEmptyCart();

  if (action.type === "remove") {
    return {
      ...state,
      lines: state.lines.filter((line) => !isSameLine(line, action.productId, action.variantId)),
    };
  }

  const productId = action.type === "add" ? action.item.productId : action.productId;
  const variantId = action.type === "add" ? action.item.variantId : action.variantId;
  const currentLine = state.lines.find((line) => isSameLine(line, productId, variantId));
  const nextQuantity = normalizeQuantity(
    action.type === "add" ? (currentLine?.quantity ?? 0) + action.quantity : action.quantity,
  );

  if (nextQuantity === 0) {
    return {
      ...state,
      lines: state.lines.filter((line) => !isSameLine(line, productId, variantId)),
    };
  }

  if (!currentLine) {
    if (action.type !== "add") return state;

    return {
      ...state,
      lines: [
        ...state.lines,
        {
          ...action.item,
          quantity: nextQuantity,
        },
      ],
    };
  }

  return {
    ...state,
    lines: state.lines.map((line) =>
      isSameLine(line, productId, variantId) ? { ...line, quantity: nextQuantity } : line,
    ),
  };
};

export const getCartItemCount = (cart: CartState): number =>
  cart.lines.reduce((total, line) => total + line.quantity, 0);

export const getCartSubtotal = (cart: CartState): number =>
  cart.lines.reduce((total, line) => total + line.priceMinor * line.quantity, 0);
