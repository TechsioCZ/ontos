// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import { commitMediaAssetUpload, rowsFromResult } from '@app/core-runtime';
import type { ActionHandler } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import type {
  FilesMediaItem,
  UploadFilesMediaItemActionPayload,
  UploadFilesMediaItemActionResponse,
} from '../shared/actions/upload-files-media-item.ts';

interface InsertedItemRow {
  readonly itemId: string;
}

type FilesMediaItemCommitServices = Pick<
  Parameters<
    ActionHandler<UploadFilesMediaItemActionPayload, UploadFilesMediaItemActionResponse>
  >[1],
  'context' | 'tx'
>;

export class InvalidFilesMediaUploadBytesError extends Error {
  readonly name = 'InvalidFilesMediaUploadBytesError';
}

export const commitFilesMediaItem = async (
  input: {
    readonly bytesBase64: string;
    readonly clientMimeType?: string;
    readonly filename: string;
    readonly position: number;
    readonly propertyDefinitionId: string;
    readonly taskId: string;
  },
  services: FilesMediaItemCommitServices,
): Promise<FilesMediaItem> => {
  const bytes = Buffer.from(input.bytesBase64, 'base64');
  if (bytes.toString('base64') !== input.bytesBase64) {
    throw new InvalidFilesMediaUploadBytesError('Uploaded bytes are not canonical base64.');
  }

  const asset = await commitMediaAssetUpload(
    {
      bytes,
      ...(input.clientMimeType === undefined ? {} : { clientMimeType: input.clientMimeType }),
      filename: input.filename,
    },
    { context: services.context, tx: services.tx },
  );
  const inserted = await services.tx.execute(sql`
    insert into ticketing.task_files_media_items (
      media_asset_id, position, property_definition_id, task_id, tenant_id
    )
    values (
      ${asset.mediaAssetId},
      ${input.position},
      ${input.propertyDefinitionId},
      ${input.taskId},
      ${services.context.tenantId}
    )
    returning item_id as "itemId"
  `);
  const item = rowsFromResult<InsertedItemRow>(inserted).at(0);
  if (item === undefined) {
    throw new Error('The Files & media item could not be committed.');
  }
  return {
    ...asset,
    itemId: item.itemId,
    position: input.position,
    propertyDefinitionId: input.propertyDefinitionId,
  };
};
