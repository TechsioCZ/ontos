import { CartProvider } from './cart.tsx';
import { Layout } from './components/Layout.tsx';
import { CartPage } from './pages/Cart.tsx';
import { CheckoutPage } from './pages/Checkout.tsx';
import { ConfirmationPage } from './pages/Confirmation.tsx';
import { HomePage } from './pages/Home.tsx';
import { ListingPage } from './pages/Listing.tsx';
import { NotFoundPage } from './pages/NotFound.tsx';
import { ProductPage } from './pages/Product.tsx';
import { useLocation } from './router.tsx';

const Routes = () => {
  const { path } = useLocation();
  if (path === '/' || path === '') return <HomePage />;
  if (path === '/produkty') return <ListingPage />;
  const category = /^\/kategorie\/([a-z0-9-]+)\/?$/u.exec(path);
  if (category !== null) return <ListingPage categorySlug={category[1]} key={category[1]} />;
  const product = /^\/produkt\/([a-z0-9-]+)\/?$/u.exec(path);
  if (product !== null) return <ProductPage key={product[1]} slug={product[1]} />;
  if (path === '/kosik') return <CartPage />;
  if (path === '/pokladna') return <CheckoutPage />;
  const order = /^\/objednavka\/([A-Za-z0-9-]{8,120})\/?$/u.exec(path);
  if (order !== null) return <ConfirmationPage submissionId={order[1]} />;
  return <NotFoundPage />;
};

export const App = () => (
  <CartProvider>
    <Layout>
      <Routes />
    </Layout>
  </CartProvider>
);
