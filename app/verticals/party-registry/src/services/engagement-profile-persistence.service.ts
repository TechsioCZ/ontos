// @generated-origin OntOS Codesmith Action Service v1
import { findPostgresFailure } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { DateTime, Effect, Option, Schema } from 'effect';

import type {
  OrganizationEngagementProfile,
  PersonEngagementProfile,
} from '../../shared/domain/engagement-profile.ts';
import {
  EngagementProfileConflict,
  EngagementProfilePersistenceUnavailable,
} from '../../shared/domain/engagement-profile.ts';
import type {
  CounterpartyRef,
  PartyRef,
} from '../../shared/party-registry-references.ts';
import type {
  OrganizationEngagementProfileRecord,
  PersonEngagementProfileRecord,
} from '../db/engagement-schema.ts';
import {
  organizationEngagementProfiles,
  personEngagementProfiles,
} from '../db/engagement-schema.ts';
import type { ContactsTransaction } from '../db/engagement-types.ts';

type ScopedTransaction = Pick<
  ContactsTransaction,
  'insert' | 'select' | 'update'
>;

const lookupResultSchema = <Value>(value: Schema.Schema<Value>) =>
  Schema.Union([
    Schema.TaggedStruct('found', { value }),
    Schema.TaggedStruct('not_found', {}),
  ]);

export type LookupResult<Value> = Schema.Schema.Type<
  ReturnType<typeof lookupResultSchema<Value>>
>;

const lifecycleResultSchema = <Value>(value: Schema.Schema<Value>) =>
  Schema.Union([
    lookupResultSchema(value),
    Schema.TaggedStruct('conflict', { value }),
  ]);

export type LifecycleResult<Value> = Schema.Schema.Type<
  ReturnType<typeof lifecycleResultSchema<Value>>
>;

const unavailable = (cause?: unknown) => {
  const error = new EngagementProfilePersistenceUnavailable({
    code: 'contacts_engagement_profile_persistence_unavailable',
    reason:
      'Contacts engagement profile persistence is temporarily unavailable',
  });
  error.cause = cause;
  return error;
};

const uniqueViolationSqlState = ['23', '505'].join('');
const engagementProfileConflictConstraints = [
  'contacts_organization_engagement_profiles_tenant_id_uk',
  'contacts_organization_engagement_profiles_counterparty_uk',
  'contacts_organization_engagement_profiles_party_uk',
  'contacts_person_engagement_profiles_tenant_id_uk',
  'contacts_person_engagement_profiles_party_counterparty_uk',
  'contacts_person_engagement_profiles_party_only_uk',
] as const;
const mutationFailure = (failure: EffectDrizzleQueryError) =>
  Option.isSome(
    findPostgresFailure(
      failure,
      ({ code, constraint }) =>
        code === uniqueViolationSqlState &&
        engagementProfileConflictConstraints.some(
          (approved) => approved === constraint
        )
    )
  )
    ? new EngagementProfileConflict({
        code: 'contacts_engagement_profile_already_exists',
        reason:
          'An engagement profile already exists for these canonical references',
      })
    : unavailable(failure);

const partyRef = (tenantId: string, resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});

const counterpartyRef = (
  tenantId: string,
  resourceId: string
): CounterpartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.counterparty',
  tenantId,
});

export const organizationEngagementProfileFromRecord = (
  row: OrganizationEngagementProfileRecord
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

const personDto = (
  row: PersonEngagementProfileRecord
): PersonEngagementProfile => ({
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
  refs: {
    readonly counterpartyRef?: CounterpartyRef;
    readonly partyRef: PartyRef;
  }
) =>
  refs.partyRef.tenantId === tenantId &&
  (refs.counterpartyRef === undefined ||
    refs.counterpartyRef.tenantId === tenantId)
    ? Effect.void
    : Effect.fail(
        new EngagementProfileConflict({
          code: 'contacts_party_counterparty_mismatch',
          reason:
            'Party and Counterparty references must belong to the trusted tenant',
        })
      );

const engagementProfilePersistence = <Value>(
  table:
    | typeof organizationEngagementProfiles
    | typeof personEngagementProfiles,
  toDto: (row: OrganizationEngagementProfileRecord) => Value
) => {
  const profilePredicate = (tenantId: string, profileId: string) =>
    and(eq(table.tenantId, tenantId), eq(table.engagementProfileId, profileId));

  return {
    create: (
      transaction: ScopedTransaction,
      input: {
        readonly counterpartyRef?: CounterpartyRef;
        readonly partyRef: PartyRef;
        readonly tenantId: string;
      }
    ) =>
      ensureReferencesBelongToTenant(input.tenantId, input).pipe(
        Effect.andThen(
          transaction
            .insert(table)
            .values({
              counterpartyResourceId: input.counterpartyRef?.resourceId ?? null,
              partyResourceId: input.partyRef.resourceId,
              tenantId: input.tenantId,
            })
            .returning()
            .pipe(Effect.mapError(mutationFailure))
        ),
        Effect.flatMap(([row]) =>
          row === undefined
            ? Effect.fail(unavailable())
            : Effect.succeed(toDto(row))
        )
      ),
    transition: Effect.fn('EngagementProfilePersistenceService.transition')(
      function* transitionProfile(
        transaction: ScopedTransaction,
        tenantId: string,
        profileId: string,
        state: 'active' | 'archived'
      ): Effect.fn.Return<
        LifecycleResult<Value>,
        EngagementProfilePersistenceUnavailable
      > {
        const predicate = profilePredicate(tenantId, profileId);
        const [current] = yield* transaction
          .select()
          .from(table)
          .where(predicate)
          .limit(1)
          .for('update')
          .pipe(Effect.mapError(unavailable));
        if (current === undefined) {
          return { _tag: 'not_found' } as const;
        }
        if ((state === 'archived') === (current.archivedAt !== null)) {
          return { _tag: 'conflict', value: toDto(current) } as const;
        }
        const now = yield* DateTime.nowAsDate;
        const [updated] = yield* transaction
          .update(table)
          .set({
            archivedAt: state === 'archived' ? now : null,
            updatedAt: now,
          })
          .where(predicate)
          .returning()
          .pipe(Effect.mapError(unavailable));
        if (updated === undefined) {
          return yield* unavailable();
        }
        return { _tag: 'found', value: toDto(updated) } as const;
      }
    ),
    find: (
      transaction: ScopedTransaction,
      tenantId: string,
      profileId: string
    ) =>
      transaction
        .select()
        .from(table)
        .where(profilePredicate(tenantId, profileId))
        .limit(1)
        .pipe(
          Effect.mapError(unavailable),
          Effect.map(([row]) =>
            row === undefined
              ? ({ _tag: 'not_found' } as const)
              : ({ _tag: 'found', value: toDto(row) } as const)
          )
        ),
  };
};

export const {
  create: createOrganizationEngagementProfile,
  transition: transitionOrganizationEngagementProfile,
  find: findOrganizationEngagementProfile,
} = engagementProfilePersistence(
  organizationEngagementProfiles,
  organizationEngagementProfileFromRecord
);

export const {
  create: createPersonEngagementProfile,
  transition: transitionPersonEngagementProfile,
  find: findPersonEngagementProfile,
} = engagementProfilePersistence(personEngagementProfiles, personDto);
