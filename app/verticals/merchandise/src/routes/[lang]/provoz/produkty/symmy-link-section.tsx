// "Propojení se Symmy" in the "E-shop a obrázky" tab: a shop product the Symmy copy linked by its SKU can be unlinked
// ("Odpojit od Symmy", after a confirmation), and an unlinked one can be allowed to link again. Both are one staff
// command (SetSymmyLink) that only the admin sends; the server keeps the unlink until the ERP changes the product.
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SectionCard, formatDateTime } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { LiveShopConfirm } from './live-shop-confirm.tsx';
import { useCommandFailure } from './product-form-labels.ts';
import { runCommand } from './products-api.ts';
import { isSymmyImported } from './symmy-provenance.tsx';

interface SymmyLinkSectionProps {
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
}

/** A shop product linked to a Symmy product by its SKU (not a row Symmy created itself). */
export const isSymmyLinkedShopProduct = (product: Pick<ProductRecord, 'id' | 'importedVia'>): boolean =>
  isSymmyImported(product) && !product.id.startsWith('symmy-');

/** Shown for a linked shop product and for one staff unlinked; nothing for any other product. */
export const SymmyLinkSection = ({ onCommitted, onReload, product, revision }: SymmyLinkSectionProps) => {
  const failure = useCommandFailure();
  const toaster = useToast();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linked = isSymmyLinkedShopProduct(product);
  const refusedAt = product.symmyLinkRefusedAt;
  if (!linked && refusedAt === undefined) {
    return null;
  }
  const send = (action: 'ALLOW' | 'UNLINK') => {
    setAsking(false);
    setBusy(true);
    setError(null);
    runCommand(
      { _tag: 'SetSymmyLink', action, expectedUpdatedAt: product.updatedAt, id: product.id },
      revision,
      (outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          const message = failure(outcome.reason, onReload, outcome.proposal);
          setError(message);
          toaster.create({ title: message, type: 'error' });
          return;
        }
        onCommitted(
          action === 'UNLINK'
            ? 'Produkt je odpojený od Symmy. Cena a sklad už se neřídí ERP.'
            : 'Propojení se Symmy je povolené. Symmy produkt propojí při příští synchronizaci.',
        );
      },
    );
  };
  return (
    <SectionCard title="Propojení se Symmy">
      {linked ? (
        <>
          <p className="text-fg-secondary text-sm" data-symmy-link="linked">
            Produkt je propojený s produktem ERP {product.erpCode ?? ''} přes stejné SKU: cenu a sklad zapisuje Symmy.
          </p>
          <Button
            appearance="outline"
            data-testid="product-symmy-unlink"
            disabled={busy}
            isLoading={busy}
            onClick={() => setAsking(true)}
            severity="danger"
          >
            Odpojit od Symmy
          </Button>
        </>
      ) : (
        <>
          <p className="text-fg-secondary text-sm" data-symmy-link="refused">
            {`Odpojeno od Symmy ${refusedAt === undefined ? '' : formatDateTime(DateTime.formatIso(refusedAt))}. `}
            Symmy produkt znovu nepropojí, dokud ERP produkt nezmění nebo dokud propojení nepovolíte.
          </p>
          <Button
            appearance="outline"
            data-testid="product-symmy-allow"
            disabled={busy}
            isLoading={busy}
            onClick={() => send('ALLOW')}
            severity="secondary"
          >
            Povolit propojení se Symmy
          </Button>
        </>
      )}
      {error !== null && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      <LiveShopConfirm
        confirmLabel="Odpojit od Symmy"
        description={`Cena a sklad produktu „${product.name}“ už nebudou sledovat ERP (Symmy) a značka „Importováno přes Symmy“ zmizí. Současná cena, sklad, texty, obrázky a zveřejnění zůstanou. Symmy produkt znovu nepropojí, dokud ERP produkt nezmění.`}
        destructive
        onCancel={() => setAsking(false)}
        onConfirm={() => send('UNLINK')}
        open={asking}
        title={`Odpojit „${product.name}“ od Symmy?`}
      />
    </SectionCard>
  );
};
