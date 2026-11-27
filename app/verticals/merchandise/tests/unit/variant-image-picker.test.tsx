// @rstest-environment happy-dom
// The variant photo picker shows each photo as a thumbnail with its file name and marks only the product's real main
// photo "Hlavní", never whichever photo happens to come first. A product without a gallery has no main photo.
import { acted, unmountAll } from '@app/admin-ui/testing/module-ui';
import { pinTestDocument } from '@app/shared-contracts/testing/http-double';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, expect, it } from 'effect-rstest';
import { ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import { VariantDetailEditor } from '../../src/routes/[lang]/provoz/produkty/product-variant-editor.tsx';
import type { VariantDetailDraft } from '../../src/routes/[lang]/provoz/produkty/product-variant-editor.tsx';
import { mountInRoute } from '../support/module-ui.ts';

const gallery = 'https://www.akros.cz/img/banner/fve-konstrukce-banner-sekce.jpg';
const hook = 'https://www.akros.cz/img/product/nastavitelny-hak-l145.jpg';
const chosen = 'https://www.akros.cz/img/product/pevny-hak-nerez-1-4301-an-9822.jpg';

const draft: VariantDetailDraft = {
  description: '',
  flags: { isAction: false, isNew: false, isRecommended: false, isSale: false },
  imageSrc: chosen,
  minimumQuantityText: '',
  originalPriceText: '',
  packageQuantityText: '',
  parameters: [],
  sourceUnit: '',
  tiers: [],
  tiersEdited: false,
  unit: '',
  weightGramsText: '',
};

const editor = (
  images: readonly string[],
  mainImage?: string,
  onChange: (next: Partial<VariantDetailDraft>) => void = constVoid,
) => (
  <VariantDetailEditor
    disabled={false}
    draft={draft}
    idPrefix="variant-1"
    images={images}
    mainImage={mainImage}
    onChange={onChange}
    productId={Schema.decodeSync(ProductIdSchema)('product-1')}
    vatRate={21}
  />
);

const choices = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="variant-image-choice"]')];
const captionOf = (choice: HTMLButtonElement) =>
  choice.querySelector('[data-testid="variant-image-caption"]')?.textContent ?? '';
const choiceOf = (caption: string) =>
  Option.getOrThrow(Option.fromNullishOr(choices().find((choice) => captionOf(choice) === caption)));
const marked = () => choices().filter((choice) => choice.textContent?.includes('Hlavní'));

afterEach(unmountAll);

it.live('a product without a gallery has no photo marked "Hlavní"; each photo shows its thumbnail and file name', () =>
  Effect.gen(function* withoutGallery() {
    yield* pinTestDocument;
    yield* mountInRoute(editor([hook, chosen]));
    expect(choices().map(captionOf)).toEqual([
      'Bez obrázku',
      'nastavitelny-hak-l145.jpg',
      'pevny-hak-nerez-1-4301-an-9822.jpg',
    ]);
    expect(marked()).toEqual([]);
    expect(choiceOf('nastavitelny-hak-l145.jpg').querySelector('img')?.getAttribute('src')).toBe(hook);
    expect(choiceOf('pevny-hak-nerez-1-4301-an-9822.jpg').getAttribute('aria-pressed')).toBe('true');
  }),
);

it.live('only the main gallery photo is "Hlavní"; picking a thumbnail makes it the variant photo', () =>
  Effect.gen(function* withGallery() {
    yield* pinTestDocument;
    const picked: Partial<VariantDetailDraft>[] = [];
    yield* mountInRoute(
      editor([gallery, hook, chosen], gallery, (next) => {
        picked.push(next);
      }),
    );
    expect(marked().map(captionOf)).toEqual(['fve-konstrukce-banner-sekce.jpg']);
    yield* acted(() => choiceOf('nastavitelny-hak-l145.jpg').click());
    yield* acted(() => choiceOf('Bez obrázku').click());
    expect(picked).toEqual([{ imageSrc: hook }, { imageSrc: '' }]);
  }),
);
