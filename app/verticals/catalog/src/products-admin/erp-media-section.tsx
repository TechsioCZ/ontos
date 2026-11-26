// "Obrázek" section of the ERP product dialog: the Product's main image. An upload is stored in Core Media and
// assigned to the Product in the same Catalog Action (assign-catalog-media); remove ends the assignment. The Akros
// storefront shows the main assignment on Novinky z ERP through Catalog's governed image read.
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option, Schema } from 'effect';
import { Base64 } from 'effect/encoding';
import { useEffect, useState } from 'react';

import { AssignCatalogMediaPayloadSchema } from '../../shared/actions/assign-catalog-media.ts';
import { RemoveCatalogMediaPayloadSchema } from '../../shared/actions/catalog-media.ts';
import type { ProductPageItem } from '../../shared/apis/product-page.ts';
import { executeAssignCatalogMedia } from '../api/assign-catalog-media-action-client.ts';
import { executeCatalogMediaContent } from '../api/catalog-media-content-client.ts';
import { executeCatalogMediaCurrent } from '../api/catalog-media-current-client.ts';
import { executeRemoveCatalogMedia } from '../api/remove-catalog-media-action-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { freshUuid, requestId } from './browser-crypto.ts';
import { productListData } from './page-data.ts';

interface Problem {
  readonly _tag: string;
}
const ProblemCodeSchema = Schema.Struct({ code: Schema.String });
const describe = (step: string, problem: Problem): string => {
  const code = Schema.decodeUnknownOption(ProblemCodeSchema)(problem);
  return `${step}: ${problem._tag}${Option.isSome(code) ? ` (${code.value.code})` : ''}`;
};

const MAIN_PURPOSE = 'MAIN';
const MEDIA_MODULE = 'core.media';
const MEDIA_TYPE = 'core.media.asset';
const FULL_EDGE = 1600;
const THUMB_EDGE = 480;

interface Current {
  readonly assetId: string | undefined;
  readonly assignmentId: string | undefined;
  readonly setRevision: number;
}

const readCurrent = (item: ProductPageItem) =>
  requestId.pipe(
    Effect.flatMap((id) => executeCatalogMediaCurrent({ target: item.productRef }, id)),
    Effect.map((answer): Current => {
      const main = Option.getOrUndefined(answer.main);
      return {
        assetId:
          main?.assignment.resourceRef.moduleId === MEDIA_MODULE ? main.assignment.resourceRef.resourceId : undefined,
        assignmentId: main?.assignment.assignmentId,
        setRevision: answer.setRevision,
      };
    }),
    Effect.mapError((problem: Problem) => describe('Čtení obrázku', problem)),
  );

const readPreview = (item: ProductPageItem, assetId: string) =>
  requestId.pipe(
    Effect.flatMap((id) =>
      executeCatalogMediaContent({ assetId, productRef: item.productRef, rendition: 'thumbnail' }, id),
    ),
    Effect.map((image) => `data:${image.mimeType};base64,${image.contentBase64}`),
    Effect.mapError((problem: Problem) => describe('Náhled obrázku', problem)),
  );

/** One rendition: the picture scaled to fit `edge`, as WebP (JPEG where the browser has no WebP encoder). */
const encode = async (bitmap: ImageBitmap, edge: number) => {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Canvas is unavailable');
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  let blob = await canvas.convertToBlob({ quality: 0.86, type: 'image/webp' });
  if (blob.type !== 'image/webp') {
    blob = await canvas.convertToBlob({ quality: 0.86, type: 'image/jpeg' });
  }
  return { contentBase64: Base64.encode(new Uint8Array(await blob.arrayBuffer())), height, width };
};

const prepareUpload = (file: File) =>
  Effect.tryPromise({
    catch: () => 'Obrázek nelze načíst (podporované jsou JPEG, PNG a WebP)',
    try: async () => {
      const bitmap = await createImageBitmap(file);
      try {
        return {
          filename: file.name,
          full: await encode(bitmap, FULL_EDGE),
          thumbnail: await encode(bitmap, THUMB_EDGE),
        };
      } finally {
        bitmap.close();
      }
    },
  });

const upload = (item: ProductPageItem, current: Current, file: File, reason: string) =>
  Effect.gen(function* uploadImage() {
    const image = yield* prepareUpload(file);
    const [assetId, assignmentId] = yield* Effect.all([freshUuid, freshUuid], { concurrency: 1 }).pipe(
      Effect.mapError(() => 'Nelze vytvořit identifikátor'),
    );
    const payload = yield* Schema.decodeUnknownEffect(AssignCatalogMediaPayloadSchema)({
      assignmentId,
      evidenceRefs: [],
      expectedSetRevision: current.setRevision,
      order: 1,
      purpose: MAIN_PURPOSE,
      reason,
      resourceKind: 'MEDIA',
      resourceRef: {
        moduleId: MEDIA_MODULE,
        resourceId: assetId,
        resourceType: MEDIA_TYPE,
        tenantId: item.productRef.tenantId,
      },
      subjectRef: item.productRef,
      upload: image,
    }).pipe(Effect.mapError((problem) => describe('Obrázek', problem)));
    const id = yield* requestId.pipe(Effect.mapError(() => 'Nelze vytvořit identifikátor'));
    yield* executeAssignCatalogMedia(payload, id, { idempotencyKey: assignmentId }).pipe(
      Effect.mapError((problem: Problem) => describe('Uložení obrázku', problem)),
    );
  });

const remove = (item: ProductPageItem, current: Current, reason: string) =>
  Effect.gen(function* removeImage() {
    if (current.assignmentId === undefined) {
      return;
    }
    const payload = yield* Schema.decodeUnknownEffect(RemoveCatalogMediaPayloadSchema)({
      assignmentId: current.assignmentId,
      evidenceRefs: [],
      expectedSetRevision: current.setRevision,
      reason,
      subjectRef: item.productRef,
    }).pipe(Effect.mapError((problem) => describe('Odebrání obrázku', problem)));
    const [id, key] = yield* Effect.all([requestId, freshUuid], { concurrency: 1 }).pipe(
      Effect.mapError(() => 'Nelze vytvořit identifikátor'),
    );
    yield* executeRemoveCatalogMedia(payload, id, { idempotencyKey: key }).pipe(
      Effect.mapError((problem: Problem) => describe('Odebrání obrázku', problem)),
    );
  });

interface ErpMediaSectionProps {
  readonly item: ProductPageItem;
  readonly reason: string;
}

export const ErpMediaSection = ({ item, reason }: ErpMediaSectionProps) => {
  const [current, setCurrent] = useState<Current | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    setPreview(null);
    browserRuntime.runFork(
      readCurrent(item).pipe(
        Effect.tap((value) =>
          value.assetId === undefined
            ? Effect.void
            : readPreview(item, value.assetId).pipe(
                Effect.match({ onFailure: (text) => setFailure(text), onSuccess: (src) => setPreview(src) }),
              ),
        ),
        Effect.match({ onFailure: (text: string) => setFailure(text), onSuccess: (value) => setCurrent(value) }),
      ),
    );
  }, [item, generation]);
  const run = (work: Effect.Effect<void, string>) => {
    setBusy(true);
    setFailure(null);
    browserRuntime.runFork(
      work.pipe(
        Effect.match({
          onFailure: (text: string) => {
            setBusy(false);
            setFailure(text);
          },
          onSuccess: () => {
            setBusy(false);
            productListData.invalidate();
            setGeneration((value) => value + 1);
          },
        }),
      ),
    );
  };
  const why = reason.trim() === '' ? 'Úprava obrázku produktu v administraci' : reason.trim();
  return (
    <fieldset className="flex flex-col gap-100 text-sm">
      <legend className="font-medium">Obrázek</legend>
      {current === null && failure === null && <StatusText status="default">Načítám obrázek…</StatusText>}
      {current !== null && (
        <div className="flex items-center gap-200">
          {preview === null ? (
            <span className="text-fg-secondary">
              {current.assetId === undefined ? 'Produkt nemá obrázek.' : 'Načítám náhled…'}
            </span>
          ) : (
            <img
              alt="Hlavní obrázek produktu"
              className="h-[96px] w-[96px] rounded-md border border-border-primary object-contain"
              src={preview}
            />
          )}
          <label className="flex flex-col gap-50">
            <span>{current.assetId === undefined ? 'Nahrát obrázek' : 'Nahradit obrázek'}</span>
            <input
              accept="image/jpeg,image/png,image/webp"
              aria-label="Obrázek produktu"
              disabled={busy}
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                event.target.value = '';
                if (chosen !== undefined) {
                  run(upload(item, current, chosen, why));
                }
              }}
              type="file"
            />
          </label>
          {current.assignmentId !== undefined && (
            <Button
              disabled={busy}
              isLoading={busy}
              onClick={() => run(remove(item, current, why))}
              size="sm"
              theme="outlined"
              type="button"
              variant="secondary"
            >
              Odebrat obrázek
            </Button>
          )}
        </div>
      )}
      {failure !== null && (
        <StatusText showIcon status="error">
          {failure}
        </StatusText>
      )}
    </fieldset>
  );
};
