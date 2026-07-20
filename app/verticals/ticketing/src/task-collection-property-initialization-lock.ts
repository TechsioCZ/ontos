import { sql } from '@app/core-runtime/db/sql';
import type { CoreTransaction } from '@app/core-runtime/db/types';

export const lockTaskCollectionForPropertyInitialization = async ({
  collectionId,
  tenantId,
  tx,
}: {
  readonly collectionId: string;
  readonly tenantId: string;
  readonly tx: CoreTransaction;
}): Promise<void> => {
  await tx.execute(sql`
    select collection_id
    from ticketing.task_collections
    where collection_id = ${collectionId}
      and tenant_id = ${tenantId}
    for update
  `);
};
