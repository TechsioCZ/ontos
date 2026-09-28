export interface CartLine {
  productId: string;
  variantId?: string;
  quantity: number;
}

export interface CartState {
  version: 1;
  lines: CartLine[];
}

export type CartAction =
  | { type: "add"; productId: string; variantId?: string; quantity: number }
  | { type: "set-quantity"; productId: string; variantId?: string; quantity: number }
  | { type: "remove"; productId: string; variantId?: string }
  | { type: "clear" };

export const createEmptyCart = (): CartState => ({ version: 1, lines: [] });

const normalizeQuantity = (quantity: number) => Math.max(0, Math.trunc(quantity));

const isSameLine = (line: CartLine, action: Extract<CartAction, { productId: string }>) =>
  line.productId === action.productId && line.variantId === action.variantId;

export const cartReducer = (state: CartState, action: CartAction): CartState => {
  if (action.type === "clear") return createEmptyCart();

  if (action.type === "remove") {
    return {
      ...state,
      lines: state.lines.filter((line) => !isSameLine(line, action)),
    };
  }

  const currentLine = state.lines.find((line) => isSameLine(line, action));
  const nextQuantity = normalizeQuantity(
    action.type === "add" ? (currentLine?.quantity ?? 0) + action.quantity : action.quantity,
  );

  if (nextQuantity === 0) {
    return {
      ...state,
      lines: state.lines.filter((line) => !isSameLine(line, action)),
    };
  }

  if (!currentLine) {
    return {
      ...state,
      lines: [
        ...state.lines,
        {
          productId: action.productId,
          ...(action.variantId ? { variantId: action.variantId } : {}),
          quantity: nextQuantity,
        },
      ],
    };
  }

  return {
    ...state,
    lines: state.lines.map((line) =>
      isSameLine(line, action) ? { ...line, quantity: nextQuantity } : line,
    ),
  };
};

export const getCartItemCount = (cart: CartState): number =>
  cart.lines.reduce((total, line) => total + line.quantity, 0);

export const getCartSubtotal = (
  cart: CartState,
  getPriceMinor: (productId: string, variantId?: string) => number | undefined,
): number =>
  cart.lines.reduce(
    (total, line) => total + (getPriceMinor(line.productId, line.variantId) ?? 0) * line.quantity,
    0,
  );
