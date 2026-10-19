import { EmptyState } from '../components/ui.tsx';
import { Link, useDocumentTitle } from '../router.tsx';

export const NotFoundPage = () => {
  useDocumentTitle('Stránka nenalezena');
  return (
    <div className="container page-pad">
      <EmptyState action={<Link className="button button--primary" to="/">Na úvod</Link>} title="Stránka nenalezena">
        <p>Tahle stránka v e-shopu Kavárna Doma neexistuje.</p>
      </EmptyState>
    </div>
  );
};
