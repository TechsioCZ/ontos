// @generated-origin OntOS Codesmith Action Service v1
import { findPostgresFailure } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Duration, Effect, Option, Schema } from 'effect';
import type { CounterpartyRef, PartyRef } from '../../shared/party-registry-references.ts';
import type {
  OrganizationEngagementProfile,
  PersonEngagementProfile,
} from '../../shared/domain/engagement-profile.ts';
import {
  EngagementProfileConflict,
  EngagementProfilePersistenceUnavailable,
} from '../../shared/domain/engagement-profile.ts';
import {
  organizationEngagementProfiles,
  personEngagementProfiles,
} from '../db/engagement-schema.ts';
import type {
  OrganizationEngagementProfileRecord,
  PersonEngagementProfileRecord,
} from '../db/engagement-schema.ts';
import type { ContactsTransaction } from '../db/engagement-types.ts';

type ScopedTransaction = Pick<ContactsTransaction, 'insert' | 'select' | 'update'>;

const lookupResultSchema = <Value>(value: Schema.Schema<Value>) =>
  Schema.Union([Schema.TaggedStruct('found', { value }), Schema.TaggedStruct('not_found', {})]);

export type LookupResult<Value> = Schema.Schema.Type<ReturnType<typeof lookupResultSchema<Value>>>;

const lifecycleResultSchema = <Value>(value: Schema.Schema<Value>) =>
  Schema.Union([lookupResultSchema(value), Schema.TaggedStruct('conflict', { value })]);

export type LifecycleResult<Value> = Schema.Schema.Type<
  ReturnType<typeof lifecycleResultSchema<Value>>
>;

const unavailable = (cause?: unknown) => {
  const error = new EngagementProfilePersistenceUnavailable({
    code: 'contacts_engagement_profile_persistence_unavailable',
    reason: 'Contacts engagement profile persistence is temporarily unavailable',
  });
  error.cause = cause;
  return error;
};

const uniqueViolationSqlState = ['23', '505'].join('');
const isEngagementUniquenessFailure = ({
  code,
  constraint,
}: Readonly<{ readonly code: string; readonly constraint?: string }>) =>
  code === uniqueViolationSqlState &&
  constraint?.startsWith('contacts_') === true &&
  constraint.endsWith('_uk');
const mutationFailure = <Failure>(failure: Failure) =>
  Option.isSome(findPostgresFailure(failure, isEngagementUniquenessFailure))
    ? new EngagementProfileConflict({
        code: 'contacts_engagement_profile_already_exists',
        reason: 'An engagement profile already exists for these canonical references',
      })
    : unavailable(failure);

const PERSISTENCE_TIMEOUT = Duration.seconds(30);
const attempt = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: unavailable, try: operation }).pipe(
    Effect.timeoutOrElse({
      duration: PERSISTENCE_TIMEOUT,
      orElse: () => Effect.fail(unavailable()),
    }),
  );
const mutationAttempt = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: mutationFailure, try: operation }).pipe(
    Effect.timeoutOrElse({
      duration: PERSISTENCE_TIMEOUT,
      orElse: () => Effect.fail(unavailable()),
    }),
  );

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
    moduleId: 'party.registry',
    resourceId: row.engagementProfileId,
    resourceType: 'party.registry.organization-engagement-profile',
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
    moduleId: 'party.registry',
    resourceId: row.engagementProfileId,
    resourceType: 'party.registry.person-engagement-profile',
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
  input: {
    readonly counterpartyRef?: CounterpartyRef;
    readonly partyRef: PartyRef;
    readonly tenantId: string;
  },
) =>
  ensureReferencesBelongToTenant(input.tenantId, input).pipe(
    Effect.andThen(
      mutationAttempt(() =>
        transaction
          .insert(organizationEngagementProfiles)
          .values({
            counterpartyResourceId: input.counterpartyRef?.resourceId ?? null,
            partyResourceId: input.partyRef.resourceId,
            tenantId: input.tenantId,
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
  input: {
    readonly counterpartyRef?: CounterpartyRef;
    readonly partyRef: PartyRef;
    readonly tenantId: string;
  },
) =>
  ensureReferencesBelongToTenant(input.tenantId, input).pipe(
    Effect.andThen(
      mutationAttempt(() =>
        transaction
          .insert(personEngagementProfiles)
          .values({
            counterpartyResourceId: input.counterpartyRef?.resourceId ?? null,
            partyResourceId: input.partyRef.resourceId,
            tenantId: input.tenantId,
          })
          .returning(),
      ),
    ),
    Effect.flatMap(([row]) =>
      row === undefined ? Effect.fail(unavailable()) : Effect.succeed(personDto(row)),
    ),
  );

const transition = Effect.fn('EngagementProfilePersistenceService.transition')(
  function* transitionProfile<Row extends { readonly archivedAt: Date | null }, Value>(
    loadCurrent: () => PromiseLike<readonly Row[]>,
    updateCurrent: (now: Date) => PromiseLike<readonly Row[]>,
    requestedState: 'active' | 'archived',
    toDto: (row: Row) => Value,
  ): Effect.fn.Return<LifecycleResult<Value>, EngagementProfilePersistenceUnavailable> {
    const [current] = yield* attempt(loadCurrent);
    if (current === undefined) {
      return { _tag: 'not_found' } as const;
    }
    if ((requestedState === 'archived') === (current.archivedAt !== null)) {
      return { _tag: 'conflict', value: toDto(current) } as const;
    }
    const now = yield* DateTime.nowAsDate;
    const [updated] = yield* attempt(() => updateCurrent(now));
    if (updated === undefined) {
      return yield* unavailable();
    }
    return { _tag: 'found', value: toDto(updated) } as const;
  },
);

export const transitionOrganizationEngagementProfile = (
  transaction: ScopedTransaction,
  tenantId: string,
  profileId: string,
  state: 'active' | 'archived',
) =>
  transition(
    () =>
      transaction
        .select()
        .from(organizationEngagementProfiles)
        .where(
          and(
            eq(organizationEngagementProfiles.tenantId, tenantId),
            eq(organizationEngagementProfiles.engagementProfileId, profileId),
          ),
        )
        .limit(1)
        .for('update'),
    (now) =>
      transaction
        .update(organizationEngagementProfiles)
        .set({ archivedAt: state === 'archived' ? now : null, updatedAt: now })
        .where(
          and(
            eq(organizationEngagementProfiles.tenantId, tenantId),
            eq(organizationEngagementProfiles.engagementProfileId, profileId),
          ),
        )
        .returning(),
    state,
    organizationEngagementProfileFromRecord,
  );

export const transitionPersonEngagementProfile = (
  transaction: ScopedTransaction,
  tenantId: string,
  profileId: string,
  state: 'active' | 'archived',
) =>
  transition(
    () =>
      transaction
        .select()
        .from(personEngagementProfiles)
        .where(
          and(
            eq(personEngagementProfiles.tenantId, tenantId),
            eq(personEngagementProfiles.engagementProfileId, profileId),
          ),
        )
        .limit(1)
        .for('update'),
    (now) =>
      transaction
        .update(personEngagementProfiles)
        .set({ archivedAt: state === 'archived' ? now : null, updatedAt: now })
        .where(
          and(
            eq(personEngagementProfiles.tenantId, tenantId),
            eq(personEngagementProfiles.engagementProfileId, profileId),
          ),
        )
        .returning(),
    state,
    personDto,
  );

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
