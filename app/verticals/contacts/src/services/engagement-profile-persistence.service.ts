// @generated-origin OntOS Codesmith Action Service v1
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
import type { CounterpartyRef, PartyRef } from '../../shared/party-registry-references.ts';
import type {
  OrganizationEngagementProfile,
  PersonEngagementProfile,
} from '../../shared/domain/engagement-profile.ts';
import {
  EngagementProfileConflict,
  EngagementProfilePersistenceUnavailable,
} from '../../shared/domain/engagement-profile.ts';
import { organizationEngagementProfiles, personEngagementProfiles } from '../db/schema.ts';
import type {
  OrganizationEngagementProfileRecord,
  PersonEngagementProfileRecord,
} from '../db/schema.ts';
import type { ContactsTransaction } from '../db/types.ts';

type ScopedTransaction = Pick<ContactsTransaction, 'insert' | 'select' | 'update'>;

export type LookupResult<Value> =
  | Readonly<{ readonly _tag: 'found'; readonly value: Value }>
  | Readonly<{ readonly _tag: 'not_found' }>;

export type LifecycleResult<Value> =
  | LookupResult<Value>
  | Readonly<{ readonly _tag: 'conflict'; readonly value: Value }>;

const unavailable = () =>
  new EngagementProfilePersistenceUnavailable({
    code: 'contacts_engagement_profile_persistence_unavailable',
    reason: 'Contacts engagement profile persistence is temporarily unavailable',
  });

const decodeDatabaseFailure = Schema.decodeUnknownOption(
  Schema.Struct({
    cause: Schema.optionalKey(Schema.Unknown),
    code: Schema.optionalKey(Schema.String),
    constraint: Schema.optionalKey(Schema.String),
  }),
);

// eslint-disable-next-line anti-slop/no-unknown-parameters -- PostgreSQL driver failures enter through this parser boundary.
const isEngagementUniquenessFailure = (failure: unknown): boolean => {
  let current = failure;
  for (let depth = 0; depth < 8; depth += 1) {
    const parsed = decodeDatabaseFailure(current);
    if (Option.isNone(parsed)) {
      return false;
    }
    const driverFailure = parsed.value;
    if (
      driverFailure.code === '23505' &&
      driverFailure.constraint?.startsWith('contacts_') === true &&
      driverFailure.constraint.endsWith('_uk')
    ) {
      return true;
    }
    current = driverFailure.cause;
  }
  return false;
};

// eslint-disable-next-line anti-slop/no-unknown-parameters -- The driver failure is parsed before classification and never escapes this persistence boundary.
const mutationFailure = (failure: unknown) =>
  isEngagementUniquenessFailure(failure)
    ? new EngagementProfileConflict({
        code: 'contacts_engagement_profile_already_exists',
        reason: 'An engagement profile already exists for these canonical references',
      })
    : unavailable();

const attempt = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: unavailable, try: operation });
const mutationAttempt = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: mutationFailure, try: operation });

const partyRef = (tenantId: string, resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});

const counterpartyRef = (tenantId: string, resourceId: string): CounterpartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.counterparty',
  tenantId,
});

export const organizationEngagementProfileFromRecord = (
  row: OrganizationEngagementProfileRecord,
): OrganizationEngagementProfile => ({
  archivedAt: row.archivedAt?.toISOString() ?? null,
  counterpartyRef:
    row.counterpartyResourceId === null
      ? null
      : counterpartyRef(row.tenantId, row.counterpartyResourceId),
  createdAt: row.createdAt.toISOString(),
  partyRef: partyRef(row.tenantId, row.partyResourceId),
  profileRef: {
    moduleId: 'contacts.core',
    resourceId: row.engagementProfileId,
    resourceType: 'contacts.core.organization-engagement-profile',
    tenantId: row.tenantId,
  },
  updatedAt: row.updatedAt.toISOString(),
});

const personDto = (row: PersonEngagementProfileRecord): PersonEngagementProfile => ({
  archivedAt: row.archivedAt?.toISOString() ?? null,
  counterpartyRef:
    row.counterpartyResourceId === null
      ? null
      : counterpartyRef(row.tenantId, row.counterpartyResourceId),
  createdAt: row.createdAt.toISOString(),
  partyRef: partyRef(row.tenantId, row.partyResourceId),
  profileRef: {
    moduleId: 'contacts.core',
    resourceId: row.engagementProfileId,
    resourceType: 'contacts.core.person-engagement-profile',
    tenantId: row.tenantId,
  },
  updatedAt: row.updatedAt.toISOString(),
});

export const ensureReferencesBelongToTenant = (
  tenantId: string,
  refs: { readonly counterpartyRef?: CounterpartyRef; readonly partyRef: PartyRef },
) =>
  refs.partyRef.tenantId === tenantId &&
  (refs.counterpartyRef === undefined || refs.counterpartyRef.tenantId === tenantId)
    ? Effect.void
    : Effect.fail(
        new EngagementProfileConflict({
          code: 'contacts_party_counterparty_mismatch',
          reason: 'Party and Counterparty references must belong to the trusted tenant',
        }),
      );

export const createOrganizationEngagementProfile = (
  transaction: ScopedTransaction,
  tenantId: string,
  refs: { readonly counterpartyRef?: CounterpartyRef; readonly partyRef: PartyRef },
) =>
  ensureReferencesBelongToTenant(tenantId, refs).pipe(
    Effect.andThen(
      mutationAttempt(() =>
        transaction
          .insert(organizationEngagementProfiles)
          .values({
            counterpartyResourceId: refs.counterpartyRef?.resourceId ?? null,
            partyResourceId: refs.partyRef.resourceId,
            tenantId,
          })
          .returning(),
      ),
    ),
    Effect.flatMap(([row]) =>
      row === undefined
        ? Effect.fail(unavailable())
        : Effect.succeed(organizationEngagementProfileFromRecord(row)),
    ),
  );

export const createPersonEngagementProfile = (
  transaction: ScopedTransaction,
  tenantId: string,
  refs: { readonly counterpartyRef?: CounterpartyRef; readonly partyRef: PartyRef },
) =>
  ensureReferencesBelongToTenant(tenantId, refs).pipe(
    Effect.andThen(
      mutationAttempt(() =>
        transaction
          .insert(personEngagementProfiles)
          .values({
            counterpartyResourceId: refs.counterpartyRef?.resourceId ?? null,
            partyResourceId: refs.partyRef.resourceId,
            tenantId,
          })
          .returning(),
      ),
    ),
    Effect.flatMap(([row]) =>
      row === undefined ? Effect.fail(unavailable()) : Effect.succeed(personDto(row)),
    ),
  );

const transition = <
  Row extends OrganizationEngagementProfileRecord | PersonEngagementProfileRecord,
  Value,
>(
  transaction: ScopedTransaction,
  table: typeof organizationEngagementProfiles | typeof personEngagementProfiles,
  tenantId: string,
  profileId: string,
  requestedState: 'active' | 'archived',
  toDto: (row: Row) => Value,
): Effect.Effect<LifecycleResult<Value>, EngagementProfilePersistenceUnavailable> =>
  Effect.gen(function* transitionProfile() {
    const [current] = yield* attempt(() =>
      transaction
        .select()
        .from(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.engagementProfileId, profileId)))
        .limit(1)
        .for('update'),
    );
    if (current === undefined) {
      return { _tag: 'not_found' } as const;
    }
    // SAFETY: the selected owner-local table and row mapper are paired by the two wrappers below.
    const currentRow = current as Row;
    if ((requestedState === 'archived') === (currentRow.archivedAt !== null)) {
      return { _tag: 'conflict', value: toDto(currentRow) } as const;
    }
    const now = yield* DateTime.nowAsDate;
    const [updated] = yield* attempt(() =>
      transaction
        .update(table)
        .set({ archivedAt: requestedState === 'archived' ? now : null, updatedAt: now })
        .where(and(eq(table.tenantId, tenantId), eq(table.engagementProfileId, profileId)))
        .returning(),
    );
    if (updated === undefined) {
      return yield* unavailable();
    }
    // SAFETY: returning() uses the same owner-local table and mapper as the selected current row.
    const updatedRow = updated as Row;
    return { _tag: 'found', value: toDto(updatedRow) } as const;
  });

export const transitionOrganizationEngagementProfile = (
  transaction: ScopedTransaction,
  tenantId: string,
  profileId: string,
  state: 'active' | 'archived',
) =>
  transition(
    transaction,
    organizationEngagementProfiles,
    tenantId,
    profileId,
    state,
    organizationEngagementProfileFromRecord,
  );

export const transitionPersonEngagementProfile = (
  transaction: ScopedTransaction,
  tenantId: string,
  profileId: string,
  state: 'active' | 'archived',
) => transition(transaction, personEngagementProfiles, tenantId, profileId, state, personDto);

export const findOrganizationEngagementProfile = (
  transaction: ScopedTransaction,
  tenantId: string,
  profileId: string,
) =>
  attempt(() =>
    transaction
      .select()
      .from(organizationEngagementProfiles)
      .where(
        and(
          eq(organizationEngagementProfiles.tenantId, tenantId),
          eq(organizationEngagementProfiles.engagementProfileId, profileId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.map(([row]) =>
      row === undefined
        ? ({ _tag: 'not_found' } as const)
        : ({ _tag: 'found', value: organizationEngagementProfileFromRecord(row) } as const),
    ),
  );

export const findPersonEngagementProfile = (
  transaction: ScopedTransaction,
  tenantId: string,
  profileId: string,
) =>
  attempt(() =>
    transaction
      .select()
      .from(personEngagementProfiles)
      .where(
        and(
          eq(personEngagementProfiles.tenantId, tenantId),
          eq(personEngagementProfiles.engagementProfileId, profileId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.map(([row]) =>
      row === undefined
        ? ({ _tag: 'not_found' } as const)
        : ({ _tag: 'found', value: personDto(row) } as const),
    ),
  );
