// Sections of the "E-shop a obrázky" tab: publication settings (part of the tab's draft), archiving a product (a
// one-click command that takes the product off the e-shop, so it asks first) and restoring an archived one.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { FormInput, Switch } from '@app/admin-ui/form-controls';
import { SectionCard, formatDateTime } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { LiveShopConfirm } from './live-shop-confirm.tsx';
import { useCommandFailure, useProductLabel } from './product-form-labels.ts';
import { runCommand } from './products-api.ts';
import { slugInvalidOf } from './product-eshop-draft.ts';
import type { EshopDraft } from './product-eshop-draft.ts';

const slugFieldError = (invalid: boolean, taken: boolean) => {
  if (invalid) {
    return { helpText: 'Jen malá písmena bez diakritiky, číslice a pomlčky', validateStatus: 'error' as const };
  }
  if (taken) {
    return { helpText: 'Tuto adresu už má jiný produkt', validateStatus: 'error' as const };
  }
  return {};
};

interface PublicationSectionProps {
  readonly canWrite: boolean;
  readonly form: EshopDraft;
  readonly onFormChange: (patch: Partial<EshopDraft>) => void;
  /** The slug the server refused because another product uses it. */
  readonly takenSlug: string | null;
}

/** Publication, slug and how availability is reported. Editing changes the tab's draft only. */
export const PublicationSection = ({ canWrite, form, onFormChange, takenSlug }: PublicationSectionProps) => {
  const { t } = useModernI18n();
  const { published, slug, sourceBaseProduct, stockTracked } = form;
  const slugTakenNow = takenSlug !== null && takenSlug === slug.trim();
  return (
    <SectionCard title={t('merchandise.ui.publicationAvailability')}>
      <div className="flex flex-col gap-200">
        <FormInput
          disabled={!canWrite}
          id="eshop-slug"
          label={t('merchandise.ui.productSlug')}
          name="slug"
          onChange={(event) => onFormChange({ slug: event.target.value })}
          value={slug}
          {...slugFieldError(slugInvalidOf(slug), slugTakenNow)}
        />
        <Switch
          checked={published}
          disabled={!canWrite}
          name="published"
          onCheckedChange={(checked: boolean) => onFormChange({ published: checked })}
        >
          Zveřejnit v e-shopu
        </Switch>
        <Switch
          checked={sourceBaseProduct}
          disabled={!canWrite}
          name="sourceBaseProduct"
          onCheckedChange={(checked: boolean) => onFormChange({ sourceBaseProduct: checked })}
        >
          Zobrazit v seznamech e-shopu jako hlavní produkt
        </Switch>
        <p className="text-fg-secondary text-sm">
          Akros a ŠroubShop ve výpisech kategorií a vyhledávání ukazují jen hlavní produkty, dokud je v Prodej › E-shopy
          zapnuté „Jen hlavní produkty“. Stránka produktu zůstává dostupná přímým odkazem.
        </p>
        <Switch
          checked={stockTracked}
          disabled={!canWrite}
          name="stockTracked"
          onCheckedChange={(checked: boolean) => onFormChange({ stockTracked: checked })}
        >
          Sklad je evidovaný (vypnuto = zákazník uvidí „Dostupnost nelze ověřit“ a nemůže objednat)
        </Switch>
      </div>
    </SectionCard>
  );
};

interface ArchiveSectionProps {
  readonly onArchived?: (() => void) | undefined;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
}

/**
 * Archives the product with a reason, after a confirmation that names it; it takes the product off the e-shop. It
 * names the product version on screen, so only a change of this product refuses it, not a write elsewhere.
 */
export const ArchiveSection = ({ onArchived, onCommitted, onReload, product, revision }: ArchiveSectionProps) => {
  const { t } = useModernI18n();
  const k = useProductLabel();
  const failure = useCommandFailure();
  const toaster = useToast();
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleConfirm = () => {
    setAsking(false);
    setBusy(true);
    const command = {
      _tag: 'ArchiveProduct',
      expectedUpdatedAt: product.updatedAt,
      id: product.id,
      reason: reason.trim(),
    } as const;
    runCommand(command, revision, (outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        // A refusal is said twice: under the button and as a toast, so it is seen even when the page reloads the product.
        const said = failure(outcome.reason, onReload, outcome.proposal);
        const message =
          outcome.reason === 'conflict' && outcome.proposal === undefined
            ? 'Produkt se mezitím změnil, proto se nearchivoval. Načetli jsme jeho aktuální stav, zkontrolujte ho a archivaci potvrďte znovu.'
            : said;
        setError(message);
        toaster.create({ title: message, type: 'error' });
        return;
      }
      onCommitted('Produkt archivován. Najdete ho pod filtrem Archivované.');
      onArchived?.();
    });
  };
  return (
    <SectionCard title={t('merchandise.ui.archiveProduct')}>
      <p className="text-fg-secondary text-sm">
        Produkt zmizí ze seznamu i z e-shopu. Skladové pohyby, objednávky a audit zůstanou zachovány a produkt lze
        obnovit.
      </p>
      <FormInput
        id="product-archive-reason"
        label={t('merchandise.ui.archiveReason')}
        maxLength={500}
        name="archiveReason"
        onChange={(event) => setReason(event.target.value)}
        value={reason}
      />
      <Button
        appearance="outline"
        data-testid="product-archive"
        disabled={busy || reason.trim().length < 5}
        isLoading={busy}
        onClick={() => setAsking(true)}
        severity="danger"
      >
        Archivovat produkt
      </Button>
      {error !== null && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      <LiveShopConfirm
        confirmLabel={k('eshop.archiveConfirm')}
        description={k('eshop.archiveDescription', { name: product.name })}
        destructive
        onCancel={() => setAsking(false)}
        onConfirm={handleConfirm}
        open={asking}
        title={k('eshop.archiveTitle', { name: product.name })}
      />
    </SectionCard>
  );
};

/** An archived product: who archived it and why, and the way back to the lists (inactive and hidden). */
export const RestoreSection = ({
  onCommitted,
  onReload,
  product,
  revision,
}: Omit<ArchiveSectionProps, 'onArchived'>) => {
  const failure = useCommandFailure();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archive = product.demoArchive;
  const handleRestore = () => {
    setBusy(true);
    runCommand({ _tag: 'RestoreProduct', expectedUpdatedAt: product.updatedAt, id: product.id }, revision, (outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setError(failure(outcome.reason, onReload, outcome.proposal));
        return;
      }
      onCommitted('Produkt obnoven. Je v seznamu produktů, neaktivní a skrytý v e-shopu.');
    });
  };
  return (
    <SectionCard title="Archivovaný produkt">
      <p className="text-fg-secondary text-sm">
        {archive === undefined
          ? 'Produkt je archivovaný.'
          : `Archivováno ${formatDateTime(DateTime.formatIso(archive.at))}. Důvod: ${archive.reason}`}
      </p>
      <p className="text-fg-secondary text-sm">
        Obnovený produkt se vrátí do seznamu produktů jako neaktivní a skrytý v e-shopu.
      </p>
      <Button
        data-testid="product-restore"
        disabled={busy}
        isLoading={busy}
        onClick={handleRestore}
        severity="secondary"
      >
        Obnovit produkt
      </Button>
      {error !== null && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
    </SectionCard>
  );
};
