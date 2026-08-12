/* eslint-disable max-classes-per-file -- Deal validation and scoped lookup failures are one closed owner-local vocabulary. */
import { createHash } from 'node:crypto';
import type { DataAccessEventInput, ScopedTransactionExecutor } from '@app/core-runtime';
import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import type {
  DealFields,
  DealView,
  DealWorkspaceResponse,
} from '../../shared/apis/deal-workspace.ts';
import { decodeDealCursorValue } from '../../shared/apis/deal-workspace.ts';
import { isDealCurrencyCode } from '../../shared/deal-currencies.ts';
import type { DealCurrencyCode } from '../../shared/deal-currencies.ts';
import type { CreateDealPayload, CreateDealResult } from '../../shared/apis/create-deal-action.ts';
import type { DeleteDealPayload, DeleteDealResult } from '../../shared/apis/delete-deal-action.ts';
import type { EditDealPayload, EditDealResult } from '../../shared/apis/edit-deal-action.ts';
import {
  CreateDealNotFound,
  CreateDealRejected,
  CreateDealUnavailable,
} from '../actions/create-deal.action.ts';
import {
  DeleteDealConflict,
  DeleteDealNotFound,
  DeleteDealUnavailable,
} from '../actions/delete-deal.action.ts';
import {
  EditDealConflict,
  EditDealNotFound,
  EditDealRejected,
  EditDealUnavailable,
} from '../actions/edit-deal.action.ts';
import { contactDisplayName } from '../contacts/contact-service.ts';
import { makeContactRepository } from '../contacts/contact-repository.ts';
import type {
  ContactRepository,
  ContactRepositoryUnavailable,
} from '../contacts/contact-repository.ts';
import { makeCustomerLookup } from '../customers/customer-service.ts';
import type { CustomerLookup, CustomerLookupUnavailable } from '../customers/customer-service.ts';
import { makeDealRepository } from './deal-repository.ts';
import type { DealRepository, DealRepositoryUnavailable, DealRow } from './deal-repository.ts';

export class DealValidationError extends Schema.TaggedErrorClass<DealValidationError>()(
  'DealValidationError',
  { reason: Schema.String },
) {}

class DealParentNotFoundError extends Schema.TaggedErrorClass<DealParentNotFoundError>()(
  'DealParentNotFoundError',
  { target: Schema.Literals(['Customer', 'Contact']) },
) {}

export interface NormalizedDealFields {
  readonly contactId: null | string;
  readonly currency: DealCurrencyCode;
  readonly customerId: string;
  readonly description: null | string;
  readonly expectedCloseDate: null | string;
  readonly expectedValue: number;
  readonly title: string;
}

export interface DealMutationOutcome<Result> {
  readonly dataAccess: readonly DataAccessEventInput[];
  readonly result: Result;
}

type DealListResponse = Extract<DealWorkspaceResponse, { readonly operation: 'list' }>;

const invalid = (reason: string) => new DealValidationError({ reason });
const normalizeOptional = (value: string | undefined): null | string => {
  const normalized = value?.normalize('NFKC').trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
};

export const normalizeDealFields = (
  input: DealFields,
): Effect.Effect<NormalizedDealFields, DealValidationError> =>
  Effect.gen(function* normalizeDealInput() {
    const title = input.title.normalize('NFKC').trim();
    if (title.length === 0 || title.length > 300) {
      return yield* invalid('Deal title must contain between 1 and 300 characters');
    }
    const description = normalizeOptional(input.description);
    if (description !== null && description.length > 5000) {
      return yield* invalid('Deal description must contain at most 5000 characters');
    }
    if (
      !Number.isFinite(input.expectedValue) ||
      input.expectedValue < 0 ||
      input.expectedValue > 999_999_999_999.99 ||
      !/^\d+(?:\.\d{1,2})?$/u.test(String(input.expectedValue))
    ) {
      return yield* invalid('Expected value must be non-negative with at most two decimal places');
    }
    if (!isDealCurrencyCode(input.currency)) {
      return yield* invalid('Currency must be an uppercase ISO 4217 code');
    }
    if (input.expectedCloseDate !== undefined && input.expectedCloseDate !== null) {
      const date = DateTime.make(`${input.expectedCloseDate}T00:00:00.000Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/u.test(input.expectedCloseDate) ||
        Option.isNone(date) ||
        DateTime.formatIso(date.value).slice(0, 10) !== input.expectedCloseDate
      ) {
        return yield* invalid('Expected close date must be a real YYYY-MM-DD calendar date');
      }
    }
    return {
      contactId: input.contactId ?? null,
      currency: input.currency,
      customerId: input.customerId,
      description,
      expectedCloseDate: input.expectedCloseDate ?? null,
      expectedValue: input.expectedValue,
      title,
    };
  });

export const dealRowToView = (
  row: DealRow,
  customerLabel: string,
  contactLabel: null | string,
): DealView =>
  Object.freeze({
    contactId: row.contactId,
    contactLabel,
    createdAt: row.createdAt.toISOString(),
    currency: row.currency,
    customerId: row.customerId,
    customerLabel,
    dealId: row.dealId,
    description: row.description,
    expectedCloseDate: row.expectedCloseDate,
    expectedValue: row.expectedValue,
    status: row.status,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  });

export const encodeDealCursor = (deal: Pick<DealView, 'dealId' | 'updatedAt'>): string =>
  `${Buffer.from(deal.updatedAt, 'utf-8').toString('base64url')}.${deal.dealId}`;

export const decodeDealCursor = (cursor: string) => {
  const decoded = decodeDealCursorValue(cursor);
  if (decoded === undefined) {
    return;
  }
  const updatedAt = DateTime.make(decoded.updatedAt);
  if (Option.isNone(updatedAt)) {
    return;
  }
  return { dealId: decoded.dealId, updatedAt: DateTime.toDateUtc(updatedAt.value) };
};

const hashQuery = (query: string): string => createHash('sha256').update(query).digest('hex');
const dealEvidence = (
  accessKind: 'list' | 'read',
  dealId: string | undefined,
  resultCount: number,
): DataAccessEventInput => ({
  accessKind,
  queryHash: hashQuery(
    accessKind === 'list' ? 'crm.deals.active-scope-list.v1' : 'crm.deals.active-by-id.v1',
  ),
  resultCount,
  servingModuleKey: 'crm.core',
  targetModuleKey: 'crm.core',
  ...(dealId === undefined
    ? {}
    : {
        targetResourceId: dealId,
        targetResourceType: 'crm.core.deal',
      }),
});
const customerEvidence = (customerId: string): DataAccessEventInput => ({
  accessKind: 'read',
  queryHash: hashQuery('crm.customers.active-parent-for-deal.v1'),
  resultCount: 1,
  servingModuleKey: 'crm.core',
  targetModuleKey: 'crm.core',
  targetResourceId: customerId,
  targetResourceType: 'crm.core.customer',
});
const contactEvidence = (contactId: string): DataAccessEventInput => ({
  accessKind: 'read',
  queryHash: hashQuery('crm.contacts.active-parent-for-deal.v1'),
  resultCount: 1,
  servingModuleKey: 'crm.core',
  targetModuleKey: 'crm.core',
  targetResourceId: contactId,
  targetResourceType: 'crm.core.contact',
});

type PersistenceUnavailable =
  | ContactRepositoryUnavailable
  | CustomerLookupUnavailable
  | DealRepositoryUnavailable;
const createUnavailable = (_error: PersistenceUnavailable) =>
  new CreateDealUnavailable({
    code: 'deal_persistence_unavailable',
    reason: 'Deal persistence is temporarily unavailable',
  });
const editUnavailable = (_error: PersistenceUnavailable) =>
  new EditDealUnavailable({
    code: 'deal_persistence_unavailable',
    reason: 'Deal persistence is temporarily unavailable',
  });
const deleteUnavailable = (_error: PersistenceUnavailable) =>
  new DeleteDealUnavailable({
    code: 'deal_persistence_unavailable',
    reason: 'Deal persistence is temporarily unavailable',
  });
type DealParentLookupError = DealParentNotFoundError | DealValidationError | PersistenceUnavailable;
const createParentLookupError = (error: DealParentLookupError) => {
  switch (error._tag) {
    case 'DealParentNotFoundError': {
      return new CreateDealNotFound({
        code: 'action_target_not_found',
        reason: `The requested ${error.target} was not found`,
      });
    }
    case 'DealValidationError': {
      return new CreateDealRejected({
        code: 'action_semantically_rejected',
        reason: error.reason,
      });
    }
    default: {
      return createUnavailable(error);
    }
  }
};
const editParentLookupError = (error: DealParentLookupError) => {
  switch (error._tag) {
    case 'DealParentNotFoundError': {
      return new EditDealNotFound({
        code: 'action_target_not_found',
        reason: `The requested ${error.target} was not found`,
      });
    }
    case 'DealValidationError': {
      return new EditDealRejected({
        code: 'action_semantically_rejected',
        reason: error.reason,
      });
    }
    default: {
      return editUnavailable(error);
    }
  }
};
const readUnavailable = () =>
  new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Deal persistence is temporarily unavailable',
  });
const readNotFound = () =>
  new ReadHandlerNotFound({
    code: 'read_handler_not_found',
    reason: 'The requested Deal was not found',
  });

export interface DealService {
  readonly createDeal: (
    input: CreateDealPayload,
  ) => Effect.Effect<
    DealMutationOutcome<CreateDealResult>,
    CreateDealNotFound | CreateDealRejected | CreateDealUnavailable
  >;
  readonly deleteDeal: (
    input: DeleteDealPayload,
  ) => Effect.Effect<
    DealMutationOutcome<DeleteDealResult>,
    DeleteDealConflict | DeleteDealNotFound | DeleteDealUnavailable
  >;
  readonly editDeal: (
    input: EditDealPayload,
  ) => Effect.Effect<
    DealMutationOutcome<EditDealResult>,
    EditDealConflict | EditDealNotFound | EditDealRejected | EditDealUnavailable
  >;
  readonly getDeal: (
    dealId: string,
  ) => Effect.Effect<DealView, ReadHandlerNotFound | ReadHandlerUnavailable>;
  readonly listDeals: (
    limit: number,
    customerId?: string,
    cursor?: string,
  ) => Effect.Effect<DealListResponse, ReadHandlerNotFound | ReadHandlerUnavailable>;
}

export const makeDealService = (
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  legalEntityId: string,
  now: () => Date = () => DateTime.toDateUtc(DateTime.nowUnsafe()),
): DealService => {
  const repository: DealRepository = makeDealRepository(transaction);
  const customers: CustomerLookup = makeCustomerLookup(transaction, tenantId);
  const contacts: ContactRepository = makeContactRepository(transaction);

  const lockEligibleParents = (fields: NormalizedDealFields) =>
    Effect.gen(function* lockDealParents() {
      const customer = yield* customers.lockActiveCustomer(fields.customerId);
      if (customer === undefined) {
        return yield* new DealParentNotFoundError({ target: 'Customer' });
      }
      const contact =
        fields.contactId === null
          ? null
          : yield* contacts.lockActiveById(tenantId, fields.contactId);
      if (fields.contactId !== null && contact === undefined) {
        return yield* new DealParentNotFoundError({ target: 'Contact' });
      }
      if (contact !== null && contact !== undefined && contact.customerId !== fields.customerId) {
        return yield* invalid('The selected Contact does not belong to the Deal Customer');
      }
      return {
        contact,
        contactLabel:
          contact === null || contact === undefined ? null : contactDisplayName(contact),
        customer,
        dataAccess: [
          customerEvidence(fields.customerId),
          ...(fields.contactId === null ? [] : [contactEvidence(fields.contactId)]),
        ],
      };
    });

  const labelsFor = (
    row: DealRow,
  ): Effect.Effect<
    { readonly contactLabel: null | string; readonly customerLabel: string },
    ReadHandlerNotFound | ReadHandlerUnavailable
  > =>
    Effect.gen(function* resolveDealLabels() {
      const customer = yield* customers
        .findCustomer(row.customerId)
        .pipe(Effect.mapError(readUnavailable));
      if (customer === undefined) {
        return yield* readNotFound();
      }
      let contactLabel: null | string = null;
      if (row.contactId !== null) {
        const contact = yield* contacts
          .findById(tenantId, row.contactId)
          .pipe(Effect.mapError(readUnavailable));
        contactLabel = contact === undefined ? 'Deleted contact' : contactDisplayName(contact);
      }
      return { contactLabel, customerLabel: customer.name };
    });

  const service: DealService = {
    createDeal: (input) =>
      Effect.gen(function* createDeal() {
        const normalized = yield* normalizeDealFields(input).pipe(
          Effect.mapError(
            (error) =>
              new CreateDealRejected({
                code: 'action_semantically_rejected',
                reason: error.reason,
              }),
          ),
        );
        const parents = yield* lockEligibleParents(normalized).pipe(
          Effect.mapError(createParentLookupError),
        );
        const created = yield* repository
          .create({
            ...normalized,
            legalEntityId,
            status: 'New',
            tenantId,
          })
          .pipe(Effect.mapError(createUnavailable));
        return {
          dataAccess: parents.dataAccess,
          result: dealRowToView(created, parents.customer.name, parents.contactLabel),
        };
      }),
    deleteDeal: (input) =>
      Effect.gen(function* deleteDeal() {
        const existing = yield* repository
          .lockActiveById(tenantId, legalEntityId, input.dealId)
          .pipe(Effect.mapError(deleteUnavailable));
        if (existing === undefined) {
          return yield* new DeleteDealNotFound({
            code: 'action_target_not_found',
            reason: 'The requested Deal was not found',
          });
        }
        if (existing.version !== input.expectedVersion) {
          return yield* new DeleteDealConflict({
            code: 'action_conflict',
            reason: 'The Deal version is stale',
          });
        }
        const customer = yield* customers
          .lockActiveCustomer(existing.customerId)
          .pipe(Effect.mapError(deleteUnavailable));
        if (customer === undefined) {
          return yield* new DeleteDealNotFound({
            code: 'action_target_not_found',
            reason: 'The Deal Customer was not found',
          });
        }
        const contact =
          existing.contactId === null
            ? null
            : yield* contacts
                .lockActiveById(tenantId, existing.contactId)
                .pipe(Effect.mapError(deleteUnavailable));
        if (
          existing.contactId !== null &&
          (contact === null || contact === undefined || contact.customerId !== existing.customerId)
        ) {
          return yield* new DeleteDealNotFound({
            code: 'action_target_not_found',
            reason: 'The Deal Contact was not found',
          });
        }
        const deletedAt = now();
        const deleted = yield* repository
          .softDelete(tenantId, legalEntityId, input.dealId, input.expectedVersion, deletedAt)
          .pipe(Effect.mapError(deleteUnavailable));
        if (deleted === undefined) {
          return yield* new DeleteDealConflict({
            code: 'action_conflict',
            reason: 'The Deal changed concurrently',
          });
        }
        return {
          dataAccess: [
            dealEvidence('read', input.dealId, 1),
            customerEvidence(existing.customerId),
            ...(existing.contactId === null ? [] : [contactEvidence(existing.contactId)]),
          ],
          result: {
            customerId: deleted.customerId,
            customerLabel: customer.name,
            dealId: deleted.dealId,
            deletedAt: deletedAt.toISOString(),
            version: deleted.version,
          },
        };
      }),
    editDeal: (input) =>
      Effect.gen(function* editDeal() {
        const existing = yield* repository
          .lockActiveById(tenantId, legalEntityId, input.dealId)
          .pipe(Effect.mapError(editUnavailable));
        if (existing === undefined) {
          return yield* new EditDealNotFound({
            code: 'action_target_not_found',
            reason: 'The requested Deal was not found',
          });
        }
        if (existing.version !== input.expectedVersion) {
          return yield* new EditDealConflict({
            code: 'action_conflict',
            reason: 'The Deal version is stale',
          });
        }
        const normalized = yield* normalizeDealFields(input).pipe(
          Effect.mapError(
            (error) =>
              new EditDealRejected({
                code: 'action_semantically_rejected',
                reason: error.reason,
              }),
          ),
        );
        const parents = yield* lockEligibleParents(normalized).pipe(
          Effect.mapError(editParentLookupError),
        );
        const updated = yield* repository
          .update(tenantId, legalEntityId, input.dealId, input.expectedVersion, normalized, now())
          .pipe(Effect.mapError(editUnavailable));
        if (updated === undefined) {
          return yield* new EditDealConflict({
            code: 'action_conflict',
            reason: 'The Deal changed concurrently',
          });
        }
        return {
          dataAccess: [dealEvidence('read', input.dealId, 1), ...parents.dataAccess],
          result: dealRowToView(updated, parents.customer.name, parents.contactLabel),
        };
      }),
    getDeal: (dealId) =>
      Effect.gen(function* getDeal() {
        const row = yield* repository
          .findActiveById(tenantId, legalEntityId, dealId)
          .pipe(Effect.mapError(readUnavailable));
        if (row === undefined) {
          return yield* readNotFound();
        }
        const labels = yield* labelsFor(row);
        return dealRowToView(row, labels.customerLabel, labels.contactLabel);
      }),
    listDeals: (limit, customerId, cursor) =>
      Effect.gen(function* listDeals() {
        const decodedCursor = cursor === undefined ? undefined : decodeDealCursor(cursor);
        if (cursor !== undefined && decodedCursor === undefined) {
          return yield* readNotFound();
        }
        if (customerId !== undefined) {
          const customer = yield* customers
            .findActiveCustomer(customerId)
            .pipe(Effect.mapError(readUnavailable));
          if (customer === undefined) {
            return yield* readNotFound();
          }
        }
        const rows = yield* repository
          .listActive(tenantId, legalEntityId, limit, customerId, decodedCursor)
          .pipe(Effect.mapError(readUnavailable));
        const page = rows.slice(0, limit);
        const items = yield* Effect.forEach((row: DealRow) =>
          labelsFor(row).pipe(
            Effect.map((labels) => dealRowToView(row, labels.customerLabel, labels.contactLabel)),
          ),
        )(page);
        const last = items.at(-1);
        return {
          items,
          nextCursor: rows.length > limit && last !== undefined ? encodeDealCursor(last) : null,
          operation: 'list' as const,
        };
      }),
  };
  return Object.freeze(service);
};
