export interface CartItemSnapshot {
  productId: string;
  variantId?: string;
  slug: string;
  name: string;
  sku: string;
  imageSrc: string;
  imageAlt: string;
  unit: string;
  minimumQuantity: number;
  stockCount: number;
  priceMinor: number;
  variantLabel?: string;
}

export interface CartLine extends CartItemSnapshot {
  quantity: number;
}

export interface CartState {
  version: 3;
  lines: CartLine[];
}

export type CartAction =
  | { type: "add"; item: CartItemSnapshot; quantity: number }
  | { type: "set-quantity"; productId: string; variantId?: string; quantity: number }
  | { type: "remove"; productId: string; variantId?: string }
  | { type: "clear" };

export const createEmptyCart = (): CartState => ({ version: 3, lines: [] });

const getDecimalPlaces = (value: number) => {
  const [, fraction = ""] = value.toString().split(".");
  return Math.min(fraction.length, 6);
};

const getQuantityScale = (item: CartItemSnapshot) =>
  10 ** Math.max(getDecimalPlaces(item.minimumQuantity), getDecimalPlaces(item.stockCount));

export const getMaximumOrderQuantity = (item: CartItemSnapshot): number => {
  const scale = getQuantityScale(item);
  const step = Math.round(item.minimumQuantity * scale);
  const stock = Math.floor(item.stockCount * scale);

  if (step <= 0 || stock < step) return 0;
  return Math.floor(stock / step) * (step / scale);
};

export const normalizeOrderQuantity = (item: CartItemSnapshot, quantity: number): number => {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;

  const scale = getQuantityScale(item);
  const step = Math.round(item.minimumQuantity * scale);
  const requested = Math.round(quantity * scale);
  const maximum = Math.round(getMaximumOrderQuantity(item) * scale);
  if (step <= 0 || maximum <= 0) return 0;

  const normalized = Math.max(step, Math.floor(requested / step) * step);
  return Math.min(normalized, maximum) / scale;
};

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
  if (!currentLine && action.type !== "add") return state;

  const item = action.type === "add" ? (currentLine ?? action.item) : currentLine;
  if (!item) return state;
  const nextQuantity = normalizeOrderQuantity(
    item,
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

export const getCartItemCount = (cart: CartState): number => cart.lines.length;

export const getCartSubtotal = (cart: CartState): number =>
  cart.lines.reduce((total, line) => total + line.priceMinor * line.quantity, 0);

export const formatQuantity = (quantity: number): string =>
  quantity.toLocaleString("cs-CZ", { maximumFractionDigits: 6 });
