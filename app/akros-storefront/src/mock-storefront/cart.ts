export interface CartLine {
  productId: string;
  quantity: number;
}

export interface CartState {
  version: 1;
  lines: CartLine[];
}

export type CartAction =
  | { type: "add"; productId: string; quantity: number }
  | { type: "set-quantity"; productId: string; quantity: number }
  | { type: "remove"; productId: string }
  | { type: "clear" };

export const createEmptyCart = (): CartState => ({ version: 1, lines: [] });

const normalizeQuantity = (quantity: number) => Math.max(0, Math.trunc(quantity));

export const cartReducer = (state: CartState, action: CartAction): CartState => {
  if (action.type === "clear") return createEmptyCart();

  if (action.type === "remove") {
    return {
      ...state,
      lines: state.lines.filter((line) => line.productId !== action.productId),
    };
  }

  const currentLine = state.lines.find((line) => line.productId === action.productId);
  const nextQuantity = normalizeQuantity(
    action.type === "add" ? (currentLine?.quantity ?? 0) + action.quantity : action.quantity,
  );

  if (nextQuantity === 0) {
    return {
      ...state,
      lines: state.lines.filter((line) => line.productId !== action.productId),
    };
  }

  if (!currentLine) {
    return {
      ...state,
      lines: [...state.lines, { productId: action.productId, quantity: nextQuantity }],
    };
  }

  return {
    ...state,
    lines: state.lines.map((line) =>
      line.productId === action.productId ? { ...line, quantity: nextQuantity } : line,
    ),
  };
};

export const getCartItemCount = (cart: CartState): number =>
  cart.lines.reduce((total, line) => total + line.quantity, 0);

export const getCartSubtotal = (
  cart: CartState,
  getPriceMinor: (productId: string) => number | undefined,
): number =>
  cart.lines.reduce(
    (total, line) => total + (getPriceMinor(line.productId) ?? 0) * line.quantity,
    0,
  );
