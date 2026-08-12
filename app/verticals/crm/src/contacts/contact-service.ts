import { createHash } from 'node:crypto';
import type { DataAccessEventInput, ScopedTransactionExecutor } from '@app/core-runtime';
import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import type {
  ContactFields,
  ContactView,
  CustomerDirectoryResponse,
} from '../../shared/apis/customer-directory.ts';
import { decodeContactCursorValue } from '../../shared/apis/customer-directory.ts';
import type {
  CreateContactPayload,
  CreateContactResult,
} from '../../shared/apis/create-contact-action.ts';
import type {
  DeleteContactPayload,
  DeleteContactResult,
} from '../../shared/apis/delete-contact-action.ts';
import type {
  EditContactPayload,
  EditContactResult,
} from '../../shared/apis/edit-contact-action.ts';
import {
  CreateContactNotFound,
  CreateContactRejected,
  CreateContactUnavailable,
} from '../actions/create-contact.action.ts';
import {
  DeleteContactConflict,
  DeleteContactNotFound,
  DeleteContactUnavailable,
} from '../actions/delete-contact.action.ts';
import {
  EditContactConflict,
  EditContactNotFound,
  EditContactRejected,
  EditContactUnavailable,
} from '../actions/edit-contact.action.ts';
import { makeCustomerLookup } from '../customers/customer-service.ts';
import type { CustomerLookup, CustomerLookupUnavailable } from '../customers/customer-service.ts';
import { makeContactRepository } from './contact-repository.ts';
import type {
  ContactListCursor,
  ContactRepository,
  ContactRepositoryUnavailable,
  ContactRow,
} from './contact-repository.ts';

export class ContactValidationError extends Schema.TaggedErrorClass<ContactValidationError>()(
  'ContactValidationError',
  { reason: Schema.String },
) {}

export interface NormalizedContactFields {
  readonly email: null | string;
  readonly firstName: null | string;
  readonly jobTitle: null | string;
  readonly lastName: null | string;
  readonly phone: null | string;
}

export interface ContactMutationOutcome<Result> {
  readonly dataAccess: readonly DataAccessEventInput[];
  readonly result: Result;
}

export interface HistoricalContactLabel {
  readonly contactId: string;
  readonly customerId: string;
  readonly customerLabel: string;
  readonly displayName: string;
}

const normalizeOptional = (value: string | undefined): null | string => {
  const normalized = value?.normalize('NFKC').trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
};

const invalid = (reason: string) => new ContactValidationError({ reason });

export const normalizeContactFields = (
  input: ContactFields,
): Effect.Effect<NormalizedContactFields, ContactValidationError> =>
  Effect.gen(function* normalizeContactInput() {
    const firstName = normalizeOptional(input.firstName);
    const lastName = normalizeOptional(input.lastName);
    if (firstName === null && lastName === null) {
      return yield* invalid('At least one Contact name part is required');
    }

    const emailInput = normalizeOptional(input.email);
    const email = emailInput?.toLowerCase() ?? null;
    if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      return yield* invalid('Email address is invalid');
    }

    const phone = normalizeOptional(input.phone)?.replaceAll(/\s+/gu, ' ') ?? null;
    if (phone !== null && !/^\+?[\d ()./-]+$/u.test(phone)) {
      return yield* invalid('Phone number is invalid');
    }

    return {
      email,
      firstName,
      jobTitle: normalizeOptional(input.jobTitle),
      lastName,
      phone,
    };
  });

export const contactDisplayName = (contact: Pick<ContactRow, 'firstName' | 'lastName'>): string =>
  [contact.firstName, contact.lastName].filter((part): part is string => part !== null).join(' ');

export const contactRowToView = (row: ContactRow, customerLabel: string): ContactView =>
  Object.freeze({
    contactId: row.contactId,
    createdAt: row.createdAt.toISOString(),
    customerId: row.customerId,
    customerLabel,
    displayName: contactDisplayName(row),
    email: row.email,
    firstName: row.firstName,
    isPrimaryContact: row.isPrimaryContact,
    jobTitle: row.jobTitle,
    lastName: row.lastName,
    phone: row.phone,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  });

const hashQuery = (query: string): string => createHash('sha256').update(query).digest('hex');
const contactReadEvidence = (contactId: string, resultCount: number): DataAccessEventInput => ({
  accessKind: 'read',
  queryHash: hashQuery('crm.contacts.active-by-id.v1'),
  resultCount,
  servingModuleKey: 'crm.core',
  targetModuleKey: 'crm.core',
  targetResourceId: contactId,
  targetResourceType: 'crm.core.contact',
});
const customerReadEvidence = (customerId: string, resultCount: number): DataAccessEventInput => ({
  accessKind: 'read',
  queryHash: hashQuery('crm.customers.active-parent-for-contact.v1'),
  resultCount,
  servingModuleKey: 'crm.core',
  targetModuleKey: 'crm.core',
  targetResourceId: customerId,
  targetResourceType: 'crm.core.customer',
});

const normalizedName = (value: null | string): string =>
  value?.normalize('NFKC').toLowerCase() ?? '';

export const encodeContactCursor = (
  contact: Pick<ContactView, 'contactId' | 'firstName' | 'lastName'>,
): string => {
  const names = JSON.stringify([
    normalizedName(contact.lastName),
    normalizedName(contact.firstName),
  ]);
  return `${Buffer.from(names, 'utf-8').toString('base64url')}.${contact.contactId}`;
};

export const decodeContactCursor = (cursor: string): ContactListCursor | undefined =>
  decodeContactCursorValue(cursor);

const readUnavailable = () =>
  new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Contact persistence is temporarily unavailable',
  });
const readNotFound = () =>
  new ReadHandlerNotFound({
    code: 'read_handler_not_found',
    reason: 'The requested Contact or Customer was not found',
  });

const createUnavailable = (_error: ContactRepositoryUnavailable | CustomerLookupUnavailable) =>
  new CreateContactUnavailable({
    code: 'contact_persistence_unavailable',
    reason: 'Contact persistence is temporarily unavailable',
  });
const editUnavailable = (_error: ContactRepositoryUnavailable | CustomerLookupUnavailable) =>
  new EditContactUnavailable({
    code: 'contact_persistence_unavailable',
    reason: 'Contact persistence is temporarily unavailable',
  });
const deleteUnavailable = (_error: ContactRepositoryUnavailable | CustomerLookupUnavailable) =>
  new DeleteContactUnavailable({
    code: 'contact_persistence_unavailable',
    reason: 'Contact persistence is temporarily unavailable',
  });

type ContactListResponse = Extract<CustomerDirectoryResponse, { readonly operation: 'contacts' }>;

export interface ContactService {
  readonly createContact: (
    input: CreateContactPayload,
  ) => Effect.Effect<
    ContactMutationOutcome<CreateContactResult>,
    CreateContactNotFound | CreateContactRejected | CreateContactUnavailable
  >;
  readonly deleteContact: (
    input: DeleteContactPayload,
  ) => Effect.Effect<
    ContactMutationOutcome<DeleteContactResult>,
    DeleteContactConflict | DeleteContactNotFound | DeleteContactUnavailable
  >;
  readonly editContact: (
    input: EditContactPayload,
  ) => Effect.Effect<
    ContactMutationOutcome<EditContactResult>,
    EditContactConflict | EditContactNotFound | EditContactRejected | EditContactUnavailable
  >;
  readonly getContact: (
    contactId: string,
  ) => Effect.Effect<ContactView, ReadHandlerNotFound | ReadHandlerUnavailable>;
  readonly getHistoricalContactLabel: (
    contactId: string,
  ) => Effect.Effect<HistoricalContactLabel, ReadHandlerNotFound | ReadHandlerUnavailable>;
  readonly listContacts: (
    customerId: string,
    limit: number,
    cursor?: string,
  ) => Effect.Effect<ContactListResponse, ReadHandlerNotFound | ReadHandlerUnavailable>;
}

export const makeContactService = (
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  now: () => Date = () => DateTime.toDateUtc(DateTime.nowUnsafe()),
): ContactService => {
  const repository: ContactRepository = makeContactRepository(transaction);
  const customers: CustomerLookup = makeCustomerLookup(transaction, tenantId);

  const service: ContactService = {
    createContact: (input) =>
      Effect.gen(function* createContact() {
        const normalized = yield* normalizeContactFields(input).pipe(
          Effect.mapError(
            (error) =>
              new CreateContactRejected({
                code: 'action_semantically_rejected',
                reason: error.reason,
              }),
          ),
        );
        const customer = yield* customers
          .lockActiveCustomer(input.customerId)
          .pipe(Effect.mapError(createUnavailable));
        if (customer === undefined) {
          return yield* new CreateContactNotFound({
            code: 'action_target_not_found',
            reason: 'The requested Customer was not found',
          });
        }
        const created = yield* repository
          .create({
            ...normalized,
            customerId: input.customerId,
            isPrimaryContact: false,
            tenantId,
          })
          .pipe(Effect.mapError(createUnavailable));
        return {
          dataAccess: [customerReadEvidence(input.customerId, 1)],
          result: contactRowToView(created, customer.name),
        };
      }),
    deleteContact: (input) =>
      Effect.gen(function* deleteContact() {
        const existing = yield* repository
          .findActiveById(tenantId, input.contactId)
          .pipe(Effect.mapError(deleteUnavailable));
        if (existing === undefined) {
          return yield* new DeleteContactNotFound({
            code: 'action_target_not_found',
            reason: 'The requested Contact was not found',
          });
        }
        const customer = yield* customers
          .lockActiveCustomer(existing.customerId)
          .pipe(Effect.mapError(deleteUnavailable));
        if (customer === undefined) {
          return yield* new DeleteContactNotFound({
            code: 'action_target_not_found',
            reason: 'The Contact Customer was not found',
          });
        }
        if (existing.version !== input.expectedVersion) {
          return yield* new DeleteContactConflict({
            code: 'action_conflict',
            reason: 'The Contact version is stale',
          });
        }
        const deletedAt = now();
        const deleted = yield* repository
          .softDelete(tenantId, input.contactId, input.expectedVersion, deletedAt)
          .pipe(Effect.mapError(deleteUnavailable));
        if (deleted === undefined) {
          return yield* new DeleteContactConflict({
            code: 'action_conflict',
            reason: 'The Contact changed concurrently',
          });
        }
        return {
          dataAccess: [
            contactReadEvidence(input.contactId, 1),
            customerReadEvidence(existing.customerId, 1),
          ],
          result: {
            contactId: deleted.contactId,
            customerId: deleted.customerId,
            customerLabel: customer.name,
            deletedAt: deletedAt.toISOString(),
            version: deleted.version,
          },
        };
      }),
    editContact: (input) =>
      Effect.gen(function* editContact() {
        const existing = yield* repository
          .findActiveById(tenantId, input.contactId)
          .pipe(Effect.mapError(editUnavailable));
        if (existing === undefined) {
          return yield* new EditContactNotFound({
            code: 'action_target_not_found',
            reason: 'The requested Contact was not found',
          });
        }
        const customer = yield* customers
          .lockActiveCustomer(existing.customerId)
          .pipe(Effect.mapError(editUnavailable));
        if (customer === undefined) {
          return yield* new EditContactNotFound({
            code: 'action_target_not_found',
            reason: 'The Contact Customer was not found',
          });
        }
        if (existing.version !== input.expectedVersion) {
          return yield* new EditContactConflict({
            code: 'action_conflict',
            reason: 'The Contact version is stale',
          });
        }
        const normalized = yield* normalizeContactFields(input).pipe(
          Effect.mapError(
            (error) =>
              new EditContactRejected({
                code: 'action_semantically_rejected',
                reason: error.reason,
              }),
          ),
        );
        const updated = yield* repository
          .update(tenantId, input.contactId, input.expectedVersion, normalized, now())
          .pipe(Effect.mapError(editUnavailable));
        if (updated === undefined) {
          return yield* new EditContactConflict({
            code: 'action_conflict',
            reason: 'The Contact changed concurrently',
          });
        }
        return {
          dataAccess: [
            contactReadEvidence(input.contactId, 1),
            customerReadEvidence(existing.customerId, 1),
          ],
          result: contactRowToView(updated, customer.name),
        };
      }),
    getContact: (contactId) =>
      Effect.gen(function* getContact() {
        const contact = yield* repository
          .findActiveById(tenantId, contactId)
          .pipe(Effect.mapError(readUnavailable));
        if (contact === undefined) {
          return yield* readNotFound();
        }
        const customer = yield* customers
          .findActiveCustomer(contact.customerId)
          .pipe(Effect.mapError(readUnavailable));
        if (customer === undefined) {
          return yield* readNotFound();
        }
        return contactRowToView(contact, customer.name);
      }),
    getHistoricalContactLabel: (contactId) =>
      Effect.gen(function* getHistoricalContactLabel() {
        const contact = yield* repository
          .findById(tenantId, contactId)
          .pipe(Effect.mapError(readUnavailable));
        if (contact === undefined) {
          return yield* readNotFound();
        }
        const customer = yield* customers
          .findCustomer(contact.customerId)
          .pipe(Effect.mapError(readUnavailable));
        if (customer === undefined) {
          return yield* readNotFound();
        }
        return {
          contactId: contact.contactId,
          customerId: contact.customerId,
          customerLabel: customer.name,
          displayName: contactDisplayName(contact),
        };
      }),
    listContacts: (customerId, limit, cursor) => {
      const decodedCursor = cursor === undefined ? undefined : decodeContactCursor(cursor);
      if (cursor !== undefined && decodedCursor === undefined) {
        return Effect.fail(readNotFound());
      }
      return Effect.gen(function* listContacts() {
        const customer = yield* customers
          .findActiveCustomer(customerId)
          .pipe(Effect.mapError(readUnavailable));
        if (customer === undefined) {
          return yield* readNotFound();
        }
        const rows = yield* repository
          .listActiveForCustomer(tenantId, customerId, limit, decodedCursor)
          .pipe(Effect.mapError(readUnavailable));
        const hasNext = rows.length > limit;
        const items = rows.slice(0, limit).map((row) => contactRowToView(row, customer.name));
        const last = items.at(-1);
        return {
          customerId,
          customerLabel: customer.name,
          items,
          nextCursor: hasNext && last !== undefined ? encodeContactCursor(last) : null,
          operation: 'contacts' as const,
        };
      });
    },
  };
  return Object.freeze(service);
};
