// The "E-shop a obrázky" tab: the product's pictures, its publication, address and availability reporting. All of it
// is one draft: the tab's Uložit saves the changed settings (one UpdateProduct) and the changed gallery (one
// ChangeProductImages `Set`), each against the catalog revision the draft was read at.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Link } from '@techsio/ui-kit/atoms/link';
import { formatMoney, SectionCard } from '@app/admin-ui';
import { Match, Option } from 'effect';
import { useState } from 'react';
import { AvailabilityBadge } from './product-eshop.tsx';
import type { PanelProps } from './product-eshop.tsx';
import { DemoArchiveSection, PublicationSection } from './product-eshop-sections.tsx';
import { eshopCommandsOf, eshopDraftOf, eshopPartlyConfirmed, slugInvalidOf } from './product-eshop-draft.ts';
import type { EshopDraft } from './product-eshop-draft.ts';
import { useProductLabel } from './product-form-labels.ts';
import { ProductImageGallery } from './product-image-gallery.tsx';
import type { StageImage } from './product-image-gallery.tsx';
import type { GalleryDraftOptions } from './product-image-gallery-draft.ts';
import { ProductTabSaveBar, useProductTabSave } from './product-tab-save.tsx';

export interface EshopPanelProps extends PanelProps {
  /** Turns a chosen file into the upload; the browser's image preparation by default. */
  readonly prepare?: GalleryDraftOptions['prepare'];
  /** Stores an uploaded picture; the merchandise Action by default. */
  readonly stage?: StageImage | undefined;
}

const useEshopPanel = ({ onCommitted, onReload, product, revision }: EshopPanelProps) => {
  const k = useProductLabel();
  const [form, setForm] = useState<EshopDraft>(() => eshopDraftOf(product));
  // The slug the server refused because another product uses it; editing the field clears the message.
  const [takenSlug, setTakenSlug] = useState<string | null>(null);
  const save = useProductTabSave<EshopDraft>({
    commandOf: (value, confirmed) => eshopCommandsOf(product.id, value, confirmed),
    // The business refusals of this save, named after the command the server refused: a slug another product already
    // uses (the settings), or a picture no longer available (the gallery). Settings that went through before a refused
    // gallery stay saved (`partlyConfirmed`), so their slug is never reported as taken.
    failureText: (outcome, value, refused) =>
      Option.liftPredicate(refused, () => outcome.reason === 'rejected').pipe(
        Option.flatMap((command) =>
          Match.value(command).pipe(
            Match.tag('ChangeProductImages', () => Option.some(k('gallery.saveRejected'))),
            Match.tag('UpdateProduct', () => {
              const typed = value.slug.trim();
              if (typed === '' || typed === (product.slug ?? '')) {
                return Option.none<string>();
              }
              setTakenSlug(typed);
              return Option.some('Adresu produktu už používá jiný produkt. Zvolte jinou adresu, nic se neuložilo.');
            }),
            Match.orElse(() => Option.none<string>()),
          ),
        ),
        Option.getOrUndefined,
      ),
    isValid: (value) => !slugInvalidOf(value.slug) && !(takenSlug !== null && takenSlug === value.slug.trim()),
    onReload,
    onSaved: () => onCommitted('Nastavení e-shopu uloženo.'),
    partlyConfirmed: eshopPartlyConfirmed,
    reset: setForm,
    revision,
    server: eshopDraftOf(product),
    value: form,
  });
  return { form, save, setForm, takenSlug };
};

export const EshopPanel = (props: EshopPanelProps) => {
  const { t } = useModernI18n();
  const { canWrite, canWriteImages = false, onArchived, onCommitted, onReload, product, revision } = props;
  const { form, save, setForm, takenSlug } = useEshopPanel(props);
  const { published } = form;
  const storefrontHref =
    props.storefrontOrigin === undefined
      ? undefined
      : `${props.storefrontOrigin}/produkt/${product.slug ?? product.id}`;
  return (
    <div className="flex flex-col gap-250">
      <ProductImageGallery
        canWrite={canWriteImages}
        images={form.images}
        onImagesChange={(update) => setForm((current) => ({ ...current, images: update(current.images) }))}
        productId={product.id}
        productName={product.name}
        {...(props.prepare === undefined ? {} : { prepare: props.prepare })}
        stage={props.stage}
      />
      <SectionCard title={t('merchandise.ui.customerProductView')}>
        <div className="flex flex-wrap items-center gap-150">
          <span className="font-semibold text-lg tabular-nums">
            {product.grossPriceMinor === undefined
              ? 'cena není dostupná'
              : `${(product.variantRecords ?? []).length > 0 ? 'od ' : ''}${formatMoney(product.grossPriceMinor)}`}
          </span>
          <span className="text-fg-secondary text-sm">s DPH</span>
          <AvailabilityBadge value={product.availability} />
          {published && product.active ? (
            <Badge size="sm" variant="info">
              Zveřejněno v e-shopu
            </Badge>
          ) : (
            <Badge size="sm" variant="outline">
              Skryto v e-shopu
            </Badge>
          )}
          {storefrontHref !== undefined && (
            <Link className="ml-auto" external href={storefrontHref} target="_blank">
              Otevřít v e-shopu
            </Link>
          )}
        </div>
      </SectionCard>
      {canWrite && !product.active && product.published === false && (
        <DemoArchiveSection
          onArchived={onArchived}
          onCommitted={onCommitted}
          onReload={onReload}
          product={product}
          revision={revision}
        />
      )}
      <PublicationSection
        canWrite={canWrite}
        form={form}
        onFormChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
        takenSlug={takenSlug}
      />
      {/* The tab's one Save button, last: settings and pictures are saved together. */}
      {(canWrite || canWriteImages) && <ProductTabSaveBar active={props.active ?? true} save={save} />}
    </div>
  );
};
