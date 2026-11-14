import { CartView } from "@/features/cart-view";
import { getDictionary } from "@/i18n";

const CartPage = async ({ params }: { params: Promise<{ locale: string }> }) => {
  const { locale } = await params;
  return <CartView dictionary={getDictionary(locale)} locale={locale} />;
};
export default CartPage;
