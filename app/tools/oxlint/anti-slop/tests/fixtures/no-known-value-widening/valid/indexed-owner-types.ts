type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
interface EditCommand {
  readonly lines?: readonly { readonly productId: string; readonly quantity: number; readonly variantId?: string }[];
  readonly contact?: { readonly name: string; readonly email: string; readonly phone?: string };
}
type EditLine = NonNullable<EditCommand['lines']>[number];
const totals = (input: { readonly quantity: number; readonly price: number; readonly vat?: number }) => input.quantity * input.price;

export const line: Mutable<EditLine> = { productId: 'product', quantity: 1 };
export const contact: Mutable<NonNullable<EditCommand['contact']>> = { name: 'Name', email: 'name@example.test' };
export const input: Mutable<Parameters<typeof totals>[0]> = { quantity: 1, price: 10 };
export const inline: { -readonly [Key in keyof Parameters<typeof totals>[0]]: Parameters<typeof totals>[0][Key] } = {
  quantity: 1, price: 10,
};
