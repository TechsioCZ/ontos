import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { ReadHandlerUnavailable } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { and, desc, eq, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Effect, Schema } from 'effect';

import type { CustomerProfileSourceItem } from '../../shared/apis/customer-profile-source.ts';
import { AddressBookProfileSchema, ActiveSavedAddressSchema } from '../../shared/domain/address-book.ts';
import type { AddressBookProfile } from '../../shared/domain/address-book.ts';
import { SavedAddressSourceAssertionSchema } from '../../shared/domain/saved-address-source.ts';
import { savedAddressSourceBindings, savedAddressSourceReceipts } from '../database/schema.ts';
import { savedAddressSourceReadService } from '../services/saved-address-source.service.ts';
import { addressReadServicesForTransaction } from './address-persistence.ts';

const unavailable = () => new ReadHandlerUnavailable({
  code: 'read_handler_unavailable',
  reason: 'Current source-owned addresses are unavailable',
});

export const projectSourceProfileAddresses = Effect.fn('CustomerProfileSourceRead.addressValues')(
  function* addressValues(
    candidates: readonly { readonly savedAddressId: string; readonly source: unknown }[],
    profile: AddressBookProfile,
    tenantId: string,
    current: ReturnType<typeof savedAddressSourceReadService>,
    values: Pick<ReturnType<typeof addressReadServicesForTransaction>, 'detail'>,
  ) {
    if (candidates.length > 256 || profile.profileRef.tenantId !== tenantId) return yield* unavailable();
    const seen = new Set<string>();
    const addresses: typeof ActiveSavedAddressSchema.Type[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.savedAddressId)) continue;
      seen.add(candidate.savedAddressId);
      const source = yield* Schema.decodeUnknownEffect(SavedAddressSourceAssertionSchema)(candidate.source).pipe(
        Effect.mapError(unavailable),
      );
      const state = yield* current.read({ mode: 'CURRENT', source, profile });
      if (state._tag !== 'CURRENT' || state.savedAddressRef.tenantId !== tenantId ||
        state.savedAddressRef.resourceId !== candidate.savedAddressId ||
        computeCanonicalValueHash(state.profile) !== computeCanonicalValueHash(profile)) return yield* unavailable();
      if (state.lifecycle === 'REMOVED') continue;
      const detail = yield* values.detail({ profile, savedAddressRef: state.savedAddressRef }, tenantId).pipe(
        Effect.mapError(unavailable),
      );
      if (detail.address.revision !== state.revision || detail.address.lifecycle !== state.lifecycle ||
        computeCanonicalValueHash([...detail.address.purposes].toSorted()) !==
          computeCanonicalValueHash([...state.purposes].toSorted()) ||
        computeCanonicalValueHash(detail.address.profile) !== computeCanonicalValueHash(profile) ||
        detail.address.savedAddressRef.resourceId !== state.savedAddressRef.resourceId) return yield* unavailable();
      addresses.push(yield* Schema.decodeUnknownEffect(ActiveSavedAddressSchema)(detail.address).pipe(
        Effect.mapError(unavailable),
      ));
    }
    return addresses;
  },
);

/** Called only after the profile's fresh SOURCE_SYNC permit, never for an ordinary buyer or staff read. */
export const readSourceProfileAddresses = Effect.fn('CustomerProfileSourceRead.addresses')(
  function* readAddresses(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    item: CustomerProfileSourceItem,
    privacyRequirement: string,
  ) {
    if (scope.legalEntityId === undefined) return yield* unavailable();
    const { kind: _kind, ...profileRef } = item.profile.profileRef;
    const profile = yield* Schema.decodeUnknownEffect(AddressBookProfileSchema)(
      item.profile.subject.kind === 'COUNTERPARTY'
        ? { kind: 'COUNTERPARTY', counterpartyRef: item.profile.subject.counterpartyRef, profileRef }
        : { kind: 'RETAIL', profileRef },
    ).pipe(Effect.mapError(unavailable));
    const binding = savedAddressSourceBindings;
    const receipt = savedAddressSourceReceipts;
    const newer = alias(savedAddressSourceReceipts, 'newer_source_address_receipt');
    const newerReceipt = transaction.select({ id: newer.actionInvocationId }).from(newer).where(and(
      eq(newer.tenantId, receipt.tenantId),
      eq(newer.legalEntityId, receipt.legalEntityId),
      eq(newer.issuer, receipt.issuer),
      eq(newer.namespace, receipt.namespace),
      sql`${newer.source} #>> '{identity,recordType}' = ${binding.recordType}`,
      sql`${newer.source} #>> '{identity,recordId}' = ${binding.recordId}`,
      sql`${newer.result} #>> '{profile,profileRef,resourceId}' = ${binding.customerProfileId}::text`,
      sql`${newer.source} #>> '{identity,routeRef}' = ${item.source.route.id}`,
      sql`(${newer.recordedAt}, ${newer.actionInvocationId}) > (${receipt.recordedAt}, ${receipt.actionInvocationId})`,
    ));
    // Only source correlation metadata is selected before the native source/current and Privacy checks.
    const candidates = yield* transaction.select({
      savedAddressId: binding.savedAddressId,
      source: receipt.source,
    }).from(binding).innerJoin(receipt, and(
      eq(receipt.tenantId, binding.tenantId),
      eq(receipt.legalEntityId, binding.legalEntityId),
      eq(receipt.issuer, binding.issuer),
      eq(receipt.namespace, binding.namespace),
      sql`${receipt.source} #>> '{identity,recordType}' = ${binding.recordType}`,
      sql`${receipt.source} #>> '{identity,recordId}' = ${binding.recordId}`,
      sql`${receipt.result} #>> '{profile,profileRef,resourceId}' = ${binding.customerProfileId}::text`,
      sql`${receipt.source} #>> '{identity,routeRef}' = ${item.source.route.id}`,
    )).where(and(
      eq(binding.tenantId, scope.tenantId),
      eq(binding.legalEntityId, scope.legalEntityId),
      eq(binding.customerProfileId, profileRef.resourceId),
      eq(binding.issuer, item.source.issuer),
      eq(binding.namespace, item.source.namespace),
      notExists(newerReceipt),
    )).orderBy(binding.savedAddressId, desc(receipt.recordedAt)).limit(257).pipe(Effect.mapError(unavailable));
    return yield* projectSourceProfileAddresses(
      candidates, profile, scope.tenantId,
      savedAddressSourceReadService(transaction, scope, privacyRequirement),
      addressReadServicesForTransaction(transaction, scope),
    );
  },
);
