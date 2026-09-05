// expect-count: 2
import Router from '@modern-js/plugin-tanstack/runtime';

const CheckoutPage = () => {
  const params = Router.useParams({ strict: false });
  const form = new FormData(document.createElement("form"));
  return (
    <span>
      {String(params)}
      {String(form)}
    </span>
  );
};

export default CheckoutPage;
