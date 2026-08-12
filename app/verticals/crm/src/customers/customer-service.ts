/* eslint-disable max-classes-per-file, no-use-before-define -- The owner-local lookup error belongs with Customer behavior and reuses the canonical row mapper declared below. */
import { createHash } from 'node:crypto';
import type { DataAccessEventInput, ScopedTransactionExecutor } from '@app/core-runtime';
import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import type {
  CustomerDirectoryResponse,
  CustomerFields,
  CustomerView,
} from '../../shared/apis/customer-directory.ts';
import type {
  CreateCustomerPayload,
  CreateCustomerResult,
} from '../../shared/apis/create-customer-action.ts';
import type {
  DeleteCustomerPayload,
  DeleteCustomerResult,
} from '../../shared/apis/delete-customer-action.ts';
import type {
  EditCustomerPayload,
  EditCustomerResult,
} from '../../shared/apis/edit-customer-action.ts';
import {
  CreateCustomerConflict,
  CreateCustomerRejected,
  CreateCustomerUnavailable,
} from '../actions/create-customer.action.ts';
import {
  DeleteCustomerConflict,
  DeleteCustomerNotFound,
  DeleteCustomerUnavailable,
} from '../actions/delete-customer.action.ts';
import {
  EditCustomerConflict,
  EditCustomerNotFound,
  EditCustomerRejected,
  EditCustomerUnavailable,
} from '../actions/edit-customer.action.ts';
import { makeCustomerRepository } from './customer-repository.ts';
import type {
  CustomerRepository,
  CustomerRepositoryConflict,
  CustomerRepositoryUnavailable,
  CustomerRow,
} from './customer-repository.ts';

export class CustomerValidationError extends Schema.TaggedErrorClass<CustomerValidationError>()(
  'CustomerValidationError',
  { reason: Schema.String },
) {}

export class CustomerLookupUnavailable extends Schema.TaggedErrorClass<CustomerLookupUnavailable>()(
  'CustomerLookupUnavailable',
  { reason: Schema.String },
) {}

export interface CustomerLookup {
  readonly findActiveCustomer: (
    customerId: string,
  ) => Effect.Effect<CustomerView | undefined, CustomerLookupUnavailable>;
  readonly findCustomer: (
    customerId: string,
  ) => Effect.Effect<CustomerView | undefined, CustomerLookupUnavailable>;
  readonly lockActiveCustomer: (
    customerId: string,
  ) => Effect.Effect<CustomerView | undefined, CustomerLookupUnavailable>;
}

export const makeCustomerLookup = (
  transaction: ScopedTransactionExecutor,
  tenantId: string,
): CustomerLookup => {
  const repository = makeCustomerRepository(transaction);
  const mapLookup = (
    lookup: Effect.Effect<CustomerRow | undefined, CustomerRepositoryUnavailable>,
  ) =>
    lookup.pipe(
      Effect.mapError(
        () =>
          new CustomerLookupUnavailable({
            reason: 'Customer persistence is temporarily unavailable',
          }),
      ),
      Effect.map((row) => (row === undefined ? undefined : customerRowToView(row))),
    );
  const lookup: CustomerLookup = {
    findActiveCustomer: (customerId) => mapLookup(repository.findActiveById(tenantId, customerId)),
    findCustomer: (customerId) => mapLookup(repository.findById(tenantId, customerId)),
    lockActiveCustomer: (customerId) => mapLookup(repository.lockActiveById(tenantId, customerId)),
  };
  return Object.freeze(lookup);
};

export interface NormalizedCustomerFields {
  readonly addressLine1: null | string;
  readonly addressLine2: null | string;
  readonly city: null | string;
  readonly companyRegistrationNumber: null | string;
  readonly countryCode: null | string;
  readonly email: null | string;
  readonly name: string;
  readonly phone: null | string;
  readonly postalCode: null | string;
  readonly region: null | string;
  readonly taxIdentificationNumber: null | string;
  readonly website: null | string;
}

export interface CustomerMutationOutcome<Result> {
  readonly dataAccess: readonly DataAccessEventInput[];
  readonly result: Result;
}

const normalizeOptional = (value: string | undefined): null | string => {
  const normalized = value?.normalize('NFKC').trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
};

const invalid = (reason: string) => new CustomerValidationError({ reason });

export const normalizeCustomerFields = (
  input: CustomerFields,
): Effect.Effect<NormalizedCustomerFields, CustomerValidationError> =>
  // eslint-disable-next-line complexity -- Every optional company/address field has an explicit normalization rule.
  Effect.gen(function* normalizeCustomerInput() {
    const name = input.name.normalize('NFKC').trim();
    if (name.length === 0) {
      return yield* invalid('Customer name is required');
    }

    const registrationInput = normalizeOptional(input.companyRegistrationNumber);
    const companyRegistrationNumber =
      registrationInput === null
        ? null
        : registrationInput.toUpperCase().replaceAll(/[\s./_-]+/gu, '');
    if (
      companyRegistrationNumber !== null &&
      (!/^[A-Z0-9]{2,64}$/u.test(companyRegistrationNumber) ||
        companyRegistrationNumber.length > 64)
    ) {
      return yield* invalid('Company registration number is invalid');
    }

    const taxInput = normalizeOptional(input.taxIdentificationNumber);
    const taxIdentificationNumber =
      taxInput === null ? null : taxInput.toUpperCase().replaceAll(/\s+/gu, '');
    if (taxIdentificationNumber !== null && !/^[A-Z0-9./-]{1,64}$/u.test(taxIdentificationNumber)) {
      return yield* invalid('Tax identification number is invalid');
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

    const websiteInput = normalizeOptional(input.website);
    let website: null | string = null;
    if (websiteInput !== null) {
      try {
        const parsed = new URL(websiteInput);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return yield* invalid('Website must use HTTP or HTTPS');
        }
        website = parsed.href;
      } catch {
        return yield* invalid('Website URL is invalid');
      }
    }

    const addressLine1 = normalizeOptional(input.address?.addressLine1);
    const addressLine2 = normalizeOptional(input.address?.addressLine2);
    const city = normalizeOptional(input.address?.city);
    const region = normalizeOptional(input.address?.region);
    const postalCode = normalizeOptional(input.address?.postalCode);
    const countryInput = normalizeOptional(input.address?.countryCode);
    const countryCode = countryInput?.toUpperCase() ?? null;
    if (countryCode !== null && !/^[A-Z]{2}$/u.test(countryCode)) {
      return yield* invalid('Address country code must be ISO 3166-1 alpha-2');
    }
    if (
      countryCode === null &&
      [addressLine1, addressLine2, city, region, postalCode].some((value) => value !== null)
    ) {
      return yield* invalid('Address country code is required when an address is supplied');
    }

    return {
      addressLine1,
      addressLine2,
      city,
      companyRegistrationNumber,
      countryCode,
      email,
      name,
      phone,
      postalCode,
      region,
      taxIdentificationNumber,
      website,
    };
  });

export const customerRowToView = (row: CustomerRow): CustomerView => {
  const hasAddress = [
    row.addressLine1,
    row.addressLine2,
    row.city,
    row.region,
    row.postalCode,
    row.countryCode,
  ].some((value) => value !== null);
  return Object.freeze({
    address: hasAddress
      ? Object.freeze({
          addressLine1: row.addressLine1,
          addressLine2: row.addressLine2,
          city: row.city,
          countryCode: row.countryCode,
          postalCode: row.postalCode,
          region: row.region,
        })
      : null,
    companyRegistrationNumber: row.companyRegistrationNumber,
    createdAt: row.createdAt.toISOString(),
    customerId: row.customerId,
    email: row.email,
    name: row.name,
    phone: row.phone,
    taxIdentificationNumber: row.taxIdentificationNumber,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    website: row.website,
  });
};

const hashQuery = (query: string): string => createHash('sha256').update(query).digest('hex');
const targetReadEvidence = (customerId: string, resultCount: number): DataAccessEventInput => ({
  accessKind: 'read',
  queryHash: hashQuery('crm.customers.active-by-id.v1'),
  resultCount,
  servingModuleKey: 'crm.core',
  targetModuleKey: 'crm.core',
  targetResourceId: customerId,
  targetResourceType: 'crm.core.customer',
});
const registrationReadEvidence = (resultCount: number): DataAccessEventInput => ({
  accessKind: 'read',
  queryHash: hashQuery('crm.customers.active-registration-number-uniqueness.v1'),
  resultCount,
  servingModuleKey: 'crm.core',
});

const normalizedSortName = (name: string): string => name.normalize('NFKC').toLowerCase();

export const encodeCustomerCursor = (customer: Pick<CustomerView, 'customerId' | 'name'>): string =>
  `${Buffer.from(normalizedSortName(customer.name), 'utf-8').toString('base64url')}.${customer.customerId}`;

export const decodeCustomerCursor = (
  cursor: string,
): { readonly customerId: string; readonly normalizedName: string } | undefined => {
  const separator = cursor.lastIndexOf('.');
  if (separator <= 0) {
    return undefined;
  }
  const encodedName = cursor.slice(0, separator);
  const customerId = cursor.slice(separator + 1);
  const normalizedName = Buffer.from(encodedName, 'base64url').toString('utf-8');
  if (
    Buffer.from(normalizedName, 'utf-8').toString('base64url') !== encodedName ||
    !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(customerId)
  ) {
    return undefined;
  }
  return { customerId, normalizedName };
};

const readUnavailable = () =>
  new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Customer persistence is temporarily unavailable',
  });
const readNotFound = () =>
  new ReadHandlerNotFound({
    code: 'read_handler_not_found',
    reason: 'The requested Customer was not found',
  });

const mapCreateRepositoryError = (
  error: CustomerRepositoryConflict | CustomerRepositoryUnavailable,
) =>
  error._tag === 'CustomerRepositoryConflict'
    ? new CreateCustomerConflict({
        code: 'action_conflict',
        reason: 'An active Customer already uses this company registration number',
      })
    : new CreateCustomerUnavailable({
        code: 'customer_persistence_unavailable',
        reason: 'Customer persistence is temporarily unavailable',
      });

const mapEditRepositoryError = (
  error: CustomerRepositoryConflict | CustomerRepositoryUnavailable,
) =>
  error._tag === 'CustomerRepositoryConflict'
    ? new EditCustomerConflict({
        code: 'action_conflict',
        reason: 'An active Customer already uses this company registration number',
      })
    : new EditCustomerUnavailable({
        code: 'customer_persistence_unavailable',
        reason: 'Customer persistence is temporarily unavailable',
      });

export interface CustomerService {
  readonly createCustomer: (
    input: CreateCustomerPayload,
  ) => Effect.Effect<
    CustomerMutationOutcome<CreateCustomerResult>,
    CreateCustomerConflict | CreateCustomerRejected | CreateCustomerUnavailable
  >;
  readonly deleteCustomer: (
    input: DeleteCustomerPayload,
  ) => Effect.Effect<
    CustomerMutationOutcome<DeleteCustomerResult>,
    DeleteCustomerConflict | DeleteCustomerNotFound | DeleteCustomerUnavailable
  >;
  readonly editCustomer: (
    input: EditCustomerPayload,
  ) => Effect.Effect<
    CustomerMutationOutcome<EditCustomerResult>,
    EditCustomerConflict | EditCustomerNotFound | EditCustomerRejected | EditCustomerUnavailable
  >;
  readonly getCustomer: (
    customerId: string,
  ) => Effect.Effect<CustomerView, ReadHandlerNotFound | ReadHandlerUnavailable>;
  readonly listCustomers: (
    limit: number,
    cursor?: string,
  ) => Effect.Effect<
    Extract<CustomerDirectoryResponse, { readonly operation: 'list' }>,
    ReadHandlerNotFound | ReadHandlerUnavailable
  >;
}

export const makeCustomerService = (
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  now: () => Date = () => DateTime.toDateUtc(DateTime.nowUnsafe()),
): CustomerService => {
  const repository: CustomerRepository = makeCustomerRepository(transaction);

  const service: CustomerService = {
    createCustomer: (input) =>
      Effect.gen(function* createCustomer() {
        const normalized = yield* normalizeCustomerFields(input).pipe(
          Effect.mapError(
            (error) =>
              new CreateCustomerRejected({
                code: 'action_semantically_rejected',
                reason: error.reason,
              }),
          ),
        );
        const dataAccess: DataAccessEventInput[] = [];
        if (normalized.companyRegistrationNumber !== null) {
          const duplicate = yield* repository
            .findActiveByRegistrationNumber(tenantId, normalized.companyRegistrationNumber)
            .pipe(Effect.mapError(mapCreateRepositoryError));
          dataAccess.push(registrationReadEvidence(duplicate === undefined ? 0 : 1));
          if (duplicate !== undefined) {
            return yield* new CreateCustomerConflict({
              code: 'action_conflict',
              reason: 'An active Customer already uses this company registration number',
            });
          }
        }
        const created = yield* repository
          .create({ ...normalized, tenantId })
          .pipe(Effect.mapError(mapCreateRepositoryError));
        return { dataAccess, result: customerRowToView(created) };
      }),
    deleteCustomer: (input) =>
      Effect.gen(function* deleteCustomer() {
        const existing = yield* repository.findActiveById(tenantId, input.customerId).pipe(
          Effect.mapError(
            () =>
              new DeleteCustomerUnavailable({
                code: 'customer_persistence_unavailable',
                reason: 'Customer persistence is temporarily unavailable',
              }),
          ),
        );
        if (existing === undefined) {
          return yield* new DeleteCustomerNotFound({
            code: 'action_target_not_found',
            reason: 'The requested Customer was not found',
          });
        }
        if (existing.version !== input.expectedVersion) {
          return yield* new DeleteCustomerConflict({
            code: 'action_conflict',
            reason: 'The Customer version is stale',
          });
        }
        const deletedAt = now();
        const deleted = yield* repository
          .softDelete(tenantId, input.customerId, input.expectedVersion, deletedAt)
          .pipe(
            Effect.mapError(
              () =>
                new DeleteCustomerUnavailable({
                  code: 'customer_persistence_unavailable',
                  reason: 'Customer persistence is temporarily unavailable',
                }),
            ),
          );
        if (deleted === undefined) {
          return yield* new DeleteCustomerConflict({
            code: 'action_conflict',
            reason: 'The Customer changed concurrently',
          });
        }
        return {
          dataAccess: [targetReadEvidence(input.customerId, 1)],
          result: {
            customerId: deleted.customerId,
            deletedAt: deletedAt.toISOString(),
            version: deleted.version,
          },
        };
      }),
    editCustomer: (input) =>
      Effect.gen(function* editCustomer() {
        const existing = yield* repository.findActiveById(tenantId, input.customerId).pipe(
          Effect.mapError(
            () =>
              new EditCustomerUnavailable({
                code: 'customer_persistence_unavailable',
                reason: 'Customer persistence is temporarily unavailable',
              }),
          ),
        );
        if (existing === undefined) {
          return yield* new EditCustomerNotFound({
            code: 'action_target_not_found',
            reason: 'The requested Customer was not found',
          });
        }
        if (existing.version !== input.expectedVersion) {
          return yield* new EditCustomerConflict({
            code: 'action_conflict',
            reason: 'The Customer version is stale',
          });
        }
        const normalized = yield* normalizeCustomerFields(input).pipe(
          Effect.mapError(
            (error) =>
              new EditCustomerRejected({
                code: 'action_semantically_rejected',
                reason: error.reason,
              }),
          ),
        );
        const dataAccess: DataAccessEventInput[] = [targetReadEvidence(input.customerId, 1)];
        if (normalized.companyRegistrationNumber !== null) {
          const duplicate = yield* repository
            .findActiveByRegistrationNumber(
              tenantId,
              normalized.companyRegistrationNumber,
              input.customerId,
            )
            .pipe(Effect.mapError(mapEditRepositoryError));
          dataAccess.push(registrationReadEvidence(duplicate === undefined ? 0 : 1));
          if (duplicate !== undefined) {
            return yield* new EditCustomerConflict({
              code: 'action_conflict',
              reason: 'An active Customer already uses this company registration number',
            });
          }
        }
        const updated = yield* repository
          .update(tenantId, input.customerId, input.expectedVersion, normalized, now())
          .pipe(Effect.mapError(mapEditRepositoryError));
        if (updated === undefined) {
          return yield* new EditCustomerConflict({
            code: 'action_conflict',
            reason: 'The Customer changed concurrently',
          });
        }
        return { dataAccess, result: customerRowToView(updated) };
      }),
    getCustomer: (customerId) =>
      repository.findActiveById(tenantId, customerId).pipe(
        Effect.mapError(readUnavailable),
        Effect.flatMap((row) =>
          row === undefined ? Effect.fail(readNotFound()) : Effect.succeed(customerRowToView(row)),
        ),
      ),
    listCustomers: (limit, cursor) => {
      const decodedCursor = cursor === undefined ? undefined : decodeCustomerCursor(cursor);
      if (cursor !== undefined && decodedCursor === undefined) {
        return Effect.fail(readNotFound());
      }
      return repository.listActive(tenantId, limit, decodedCursor).pipe(
        Effect.mapError(readUnavailable),
        Effect.map((rows) => {
          const hasNext = rows.length > limit;
          const items = rows.slice(0, limit).map(customerRowToView);
          const last = items.at(-1);
          return {
            items,
            nextCursor: hasNext && last !== undefined ? encodeCustomerCursor(last) : null,
            operation: 'list' as const,
          };
        }),
      );
    },
  };
  return Object.freeze(service);
};
