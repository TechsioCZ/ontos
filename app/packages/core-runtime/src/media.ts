// @effect-diagnostics asyncFunction:off extendsNativeError:off globalDate:off nodeBuiltinImport:off
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { OperationContext } from './operation-context.ts';
import type { CoreReadonlyDbExecutor, CoreTransaction } from './db/types.ts';
import { mediaAssetBytes, mediaAssets } from './db/schema.ts';
import { MediaUploadRejectedError } from './media-upload-rejected-error.ts';

export interface MediaUploadPolicy {
  readonly maxBytesPerFile: number;
}

export class MediaUploadConfigurationError extends Error {
  readonly code = 'core.media.upload_limit_invalid';

  constructor() {
    super('CORE_MEDIA_MAX_UPLOAD_BYTES must be a positive safe integer byte count.');
    this.name = 'MediaUploadConfigurationError';
  }
}

export interface MediaAssetUploadInput {
  readonly bytes: Uint8Array;
  readonly clientMimeType?: string;
  readonly filename: string;
}

export interface CommittedMediaAsset {
  readonly access: 'download';
  readonly byteSize: number;
  readonly displayFilename: string;
  readonly effectiveMimeType: string;
  readonly mediaAssetId: string;
}

const detectedMimeType = (bytes: Uint8Array): string | undefined => {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  ) {
    return 'image/png';
  }
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const prefix = Buffer.from(bytes.subarray(0, 12)).toString('ascii');
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) {
    return 'image/gif';
  }
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
};

const extensionMimeTypes = new Map([
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);

const suppliedExtensionMimeType = (filename: string): string | undefined => {
  const separator = filename.lastIndexOf('.');
  if (separator <= 0 || separator === filename.length - 1) {
    return undefined;
  }
  return extensionMimeTypes.get(filename.slice(separator + 1).toLowerCase());
};

const meaningfulClientMimeType = (clientMimeType: string | undefined): string | undefined => {
  const normalized = clientMimeType?.trim().toLowerCase();
  return normalized === undefined || normalized === '' || normalized === 'application/octet-stream'
    ? undefined
    : normalized;
};

export const getMediaUploadPolicy = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MediaUploadPolicy => {
  const configured = environment['CORE_MEDIA_MAX_UPLOAD_BYTES'];
  if (configured === undefined) {
    return { maxBytesPerFile: 104_857_600 };
  }

  const maxBytesPerFile = Number(configured);
  if (
    !/^\d+$/u.test(configured) ||
    !Number.isSafeInteger(maxBytesPerFile) ||
    maxBytesPerFile <= 0
  ) {
    throw new MediaUploadConfigurationError();
  }
  return { maxBytesPerFile };
};

export const commitMediaAssetUpload = async (
  input: MediaAssetUploadInput,
  services: {
    readonly context: OperationContext<unknown>;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly tx: CoreTransaction;
  },
): Promise<CommittedMediaAsset> => {
  const policy = getMediaUploadPolicy(services.environment);
  if (input.bytes.byteLength > policy.maxBytesPerFile) {
    throw new MediaUploadRejectedError(
      'core.media.upload_too_large',
      `The upload exceeds the ${policy.maxBytesPerFile} byte per-file limit.`,
    );
  }

  const detected = detectedMimeType(input.bytes);
  const extension = suppliedExtensionMimeType(input.filename);
  const client = meaningfulClientMimeType(input.clientMimeType);
  if (
    detected !== undefined &&
    ((extension !== undefined && extension !== detected) ||
      (client !== undefined && client !== detected))
  ) {
    throw new MediaUploadRejectedError(
      'core.media.type_mismatch',
      'Detected file content conflicts with a supplied filename extension or MIME type.',
    );
  }

  const effectiveMimeType = detected ?? 'application/octet-stream';
  const mediaAssetId = randomUUID();
  const storageKey = randomUUID();
  await services.tx.insert(mediaAssets).values({
    byteSize: BigInt(input.bytes.byteLength),
    contentSha256: createHash('sha256').update(input.bytes).digest('hex'),
    displayFilename: input.filename,
    ingestedByPrincipalId: services.context.principalId,
    ingestionSource: 'user',
    legalEntityId: services.context.legalEntityId,
    mediaAssetId,
    mimeType: effectiveMimeType,
    originalFilename: input.filename,
    processingStatus: 'ready',
    sealedAt: new Date(),
    storageKey,
    storageProvider: 'database',
    tenantId: services.context.tenantId,
  });
  await services.tx.insert(mediaAssetBytes).values({
    bytes: input.bytes,
    mediaAssetId,
    tenantId: services.context.tenantId,
  });

  return {
    access: 'download',
    byteSize: input.bytes.byteLength,
    displayFilename: input.filename,
    effectiveMimeType,
    mediaAssetId,
  };
};

export type AuthorizedMediaDownloadResult =
  | { readonly _tag: 'MediaDownloadDenied' }
  | { readonly _tag: 'MediaDownloadNotFound' }
  | {
      readonly _tag: 'MediaDownloadReady';
      readonly download: {
        readonly bytes: Uint8Array;
        readonly contentDisposition: 'attachment';
        readonly displayFilename: string;
        readonly mimeType: string;
      };
    };

export const getAuthorizedMediaDownload = async (
  input: { readonly mediaAssetId: string; readonly tenantId: string },
  services: {
    readonly authorize: (input: {
      readonly mediaAssetId: string;
      readonly tenantId: string;
    }) => boolean | Promise<boolean>;
    readonly db: CoreReadonlyDbExecutor;
  },
): Promise<AuthorizedMediaDownloadResult> => {
  if (!(await services.authorize(input))) {
    return { _tag: 'MediaDownloadDenied' };
  }

  const rows = await services.db
    .select({
      bytes: mediaAssetBytes.bytes,
      displayFilename: mediaAssets.displayFilename,
      mimeType: mediaAssets.mimeType,
    })
    .from(mediaAssets)
    .innerJoin(mediaAssetBytes, eq(mediaAssetBytes.mediaAssetId, mediaAssets.mediaAssetId))
    .where(
      sql`${mediaAssets.mediaAssetId} = ${input.mediaAssetId} and ${mediaAssets.tenantId} = ${input.tenantId}`,
    );
  const asset = rows.at(0);
  return asset === undefined
    ? { _tag: 'MediaDownloadNotFound' }
    : {
        _tag: 'MediaDownloadReady',
        download: {
          bytes: asset.bytes,
          contentDisposition: 'attachment',
          displayFilename: asset.displayFilename,
          mimeType: asset.mimeType,
        },
      };
};
