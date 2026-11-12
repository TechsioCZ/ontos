import type { SymmySourceRecordRef } from '@app/shared-contracts/symmy';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** A stable reference excludes transport revision and occurrence but distinguishes the full source identity. */
export const symmySourceRecordFingerprint = (record: SymmySourceRecordRef): string =>
  bytesToHex(
    sha256(
      utf8ToBytes(
        [
          record.route.tenantId,
          record.route.integrationRouteId,
          record.issuerId,
          record.sourceNamespace,
          record.entityKind,
          record.sourceRecordId,
        ]
          .map((part) => `${part.length}:${part}`)
          .join(''),
      ),
    ),
  );
