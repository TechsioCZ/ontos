// Sections of the "E-shop a obrázky" tab: publication settings (part of the tab's draft) and archiving a DEMO product
// (a one-click command that takes the product off the e-shop, so it asks first).
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput, Switch } from '@app/admin-ui/form-controls';
import { SectionCard } from '@app/admin-ui';
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
  const { published, slug, stockTracked } = form;
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
          checked={stockTracked}
          disabled={!canWrite}
          name="stockTracked"
          onCheckedChange={(checked: boolean) => onFormChange({ stockTracked: checked })}
        >
          Sklad je evidovaný (vypnuto = zákazník uvidí „dostupnost nyní nelze ověřit“ a nemůže objednat)
        </Switch>
      </div>
    </SectionCard>
  );
};

interface DemoArchiveSectionProps {
  readonly onArchived?: (() => void) | undefined;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
}

/** Archives a hidden DEMO product with a reason, after a confirmation that names the product. */
export const DemoArchiveSection = ({
  onArchived,
  onCommitted,
  onReload,
  product,
  revision,
}: DemoArchiveSectionProps) => {
  const { t } = useModernI18n();
  const k = useProductLabel();
  const failure = useCommandFailure();
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleConfirm = () => {
    setAsking(false);
    setBusy(true);
    runCommand({ _tag: 'ArchiveDemoProduct', id: product.id, reason: reason.trim() }, revision, (outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setError(failure(outcome.reason, onReload, outcome.proposal));
        return;
      }
      onCommitted('DEMO produkt archivován. Audit a skladové pohyby zachovány.');
      onArchived?.();
    });
  };
  return (
    <SectionCard title={t('merchandise.ui.archiveDemoProduct')}>
      <p className="text-fg-secondary text-sm">
        Produkt zmizí ze seznamu i e-shopu. Skladové pohyby, objednávky a audit zůstanou zachovány.
      </p>
      <FormInput
        id="demo-archive-reason"
        label={t('merchandise.ui.archiveReason')}
        maxLength={500}
        name="archiveReason"
        onChange={(event) => setReason(event.target.value)}
        value={reason}
      />
      <Button
        data-testid="demo-archive"
        disabled={busy || reason.trim().length < 5}
        isLoading={busy}
        onClick={() => setAsking(true)}
        theme="outlined"
        variant="danger"
      >
        Archivovat DEMO produkt
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
