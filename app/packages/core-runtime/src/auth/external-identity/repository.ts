/* oxlint-disable effect-native/no-dependency-parameters -- Transaction-scoped repository factories intentionally receive trusted deployment seams explicitly; expires: 2027-03-31. */
import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { Context, DateTime, Effect, Option, Schema } from 'effect';

import {
  AuthBindingStatusSchema,
  AuthenticationNamespaceIdSchema,
  ExternalAuthenticationSubjectSchema,
  ReadPrincipalBindingResultSchema,
  ResolveExternalSubjectResultSchema,
} from '../external-identity-contracts.ts';
import type {
  AuthenticationNamespaceRegistration,
  ExternalAuthenticationSubject,
} from '../external-identity-contracts.ts';
import { principalAuthBindings, principals, tenants } from '../../db/schema.ts';
import type { BindingStatus } from '../../db/schema.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import {
  AuthenticationNamespaceRegistry,
  assertAuthenticationAdmission,
  assertExternalSubjectAdmission,
  authenticationObservationFromAdmission,
} from './verifier.ts';
import type {
  AuthenticationAdmissionMatch,
  AuthenticationNamespaceRegistryService,
  ExternalSubjectAdmissionMatch,
  VerifiedExternalIdentityAdmission,
} from './verifier.ts';
import { externalIdentityFailure } from './errors.ts';
import type { ExternalIdentityFailure } from './errors.ts';

export type ExternalUserSubject = ExternalAuthenticationSubject;
type ReadPrincipalBindingResult = Schema.Schema.Type<typeof ReadPrincipalBindingResultSchema>;
type ResolveExternalSubjectResult = Schema.Schema.Type<typeof ResolveExternalSubjectResultSchema>;

type ExternalIdentityAdmissionMatch =
  | Readonly<{ readonly expected: AuthenticationAdmissionMatch; readonly kind: 'authentication' }>
  | Readonly<{ readonly expected: ExternalSubjectAdmissionMatch; readonly kind: 'subject' }>;

/**
 * A capability is only accepted together with the receiver-owned operation
 * match used to consume it. The match is composition data, never a request
 * field and never derived from the capability's own observation.
 */
export interface ExternalIdentityAdmissionContext {
  readonly admission: VerifiedExternalIdentityAdmission;
  readonly match: ExternalIdentityAdmissionMatch;
}

const TenantStatusSchema = Schema.Literals(['active', 'archived', 'suspended']);
type TenantStatus = typeof TenantStatusSchema.Type;
const PrincipalStatusSchema = Schema.Literals(['active', 'disabled', 'archived']);
type PrincipalStatus = typeof PrincipalStatusSchema.Type;
const PrincipalKindSchema = Schema.Literals(['human', 'service', 'integration', 'agent', 'system']);
type PrincipalKind = typeof PrincipalKindSchema.Type;

const isTenantStatus = Schema.is(TenantStatusSchema);
const isBindingStatus = Schema.is(AuthBindingStatusSchema);
const isPrincipalStatus = Schema.is(PrincipalStatusSchema);
const isPrincipalKind = Schema.is(PrincipalKindSchema);

export interface ExternalIdentityBindingRecord {
  readonly authBindingId: string;
  readonly authenticationNamespaceId: string;
  readonly bindingRevision: number;
  readonly bindingStatus: BindingStatus;
  readonly createdByInvocationId: string | null;
  readonly lastTransitionRef: string | null;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly principalStatus: PrincipalStatus;
  readonly provider: string;
  readonly providerSubjectId: string;
  readonly revokedAt: Date | null;
  readonly subjectType: ExternalAuthenticationSubject['subjectType'];
  readonly tenantId: string;
  readonly tenantStatus: TenantStatus;
}

export interface ExternalIdentityRepositoryDependencies {
  /** Action-level exact Tenant/namespace provisioning check. */
  readonly authorizeNamespace?: (authenticationNamespaceId: string) => Effect.Effect<void, ExternalIdentityFailure>;
  /** Read-level exact Tenant/namespace provisioning or administrative check. */
  readonly authorizeReadNamespace?: (authenticationNamespaceId: string) => Effect.Effect<void, ExternalIdentityFailure>;
  /** Trusted deployment registration. It is never read from request payloads. */
  readonly registry?: AuthenticationNamespaceRegistryService;
}

export interface PrepareExternalIdentityInput {
  readonly admission?: ExternalIdentityAdmissionContext;
  readonly displayName?: string;
  readonly invocationId: string;
  readonly subject: ExternalUserSubject;
  readonly tenantId: string;
}

type PrepareExternalIdentityResult =
  | {
      readonly authBindingId: string;
      readonly bindingRevision: 1;
      readonly bindingStatus: 'pending';
      readonly outcome: 'RESERVED';
      readonly principalId: string;
    }
  | {
      readonly authBindingId: string;
      readonly bindingRevision: number;
      readonly bindingStatus: BindingStatus;
      readonly outcome: 'EXISTING';
      readonly principalId: string;
    };

export interface ActivateExternalIdentityInput {
  readonly admission?: ExternalIdentityAdmissionContext;
  readonly authBindingId: string;
  readonly expectedRevision: number;
  readonly invocationId: string;
  readonly tenantId: string;
}

export interface ActivateExternalIdentityResult {
  readonly authBindingId: string;
  readonly authenticationNamespaceId: string;
  readonly bindingRevision: number;
  readonly bindingStatus: 'active';
  readonly changed: boolean;
  readonly outcome: 'ACTIVATED';
  readonly principalId: string;
  readonly tenantId: string;
  readonly transitionRef: string;
}

export interface ChangeExternalIdentityStatusInput {
  readonly admission?: ExternalIdentityAdmissionContext;
  readonly authBindingId: string;
  readonly expectedRevision: number;
  readonly invocationId: string;
  readonly reason: string;
  readonly reconciliationRef?: string;
  readonly requestedStatus: Exclude<BindingStatus, 'pending'>;
  readonly tenantId: string;
}

export interface ChangeExternalIdentityStatusResult {
  readonly authBindingId: string;
  readonly authenticationNamespaceId: string;
  readonly bindingRevision: number;
  readonly bindingStatus: BindingStatus;
  readonly previousStatus: BindingStatus;
  readonly principalId: string;
  readonly tenantId: string;
  readonly transitionRef: string;
}

interface ReadPrincipalBindingInput {
  readonly authBindingId?: string;
  readonly authenticationNamespaceId?: string;
  readonly lookup: 'binding' | 'subject';
  readonly providerSubjectId?: string;
  readonly subjectType?: ExternalAuthenticationSubject['subjectType'];
  readonly tenantId: string;
}

export interface ExternalIdentityRepositoryService {
  readonly activate: (
    input: ActivateExternalIdentityInput,
  ) => Effect.Effect<ActivateExternalIdentityResult, ExternalIdentityFailure>;
  readonly changeStatus: (
    input: ChangeExternalIdentityStatusInput,
  ) => Effect.Effect<ChangeExternalIdentityStatusResult, ExternalIdentityFailure>;
  readonly prepare: (
    input: PrepareExternalIdentityInput,
  ) => Effect.Effect<PrepareExternalIdentityResult, ExternalIdentityFailure>;
  readonly read: (
    input: ReadPrincipalBindingInput,
  ) => Effect.Effect<ReadPrincipalBindingResult, ExternalIdentityFailure>;
  readonly resolve: (input: {
    readonly admission: ExternalIdentityAdmissionContext;
    readonly subject: ExternalUserSubject;
    readonly tenantId: string;
  }) => Effect.Effect<ResolveExternalSubjectResult, ExternalIdentityFailure>;
}

export class ExternalIdentityRepository extends Context.Service<
  ExternalIdentityRepository,
  ExternalIdentityRepositoryService
>()('@app/core-runtime/auth/external-identity/repository/ExternalIdentityRepository') {}

const persistenceFailure = (reason: string, cause?: unknown): ExternalIdentityFailure => {
  const failure = externalIdentityFailure('identity_unavailable', reason);
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
const conflict = (reason: string): ExternalIdentityFailure => externalIdentityFailure('identity_conflict', reason);
const invalid = (reason: string): ExternalIdentityFailure => externalIdentityFailure('identity_invalid', reason);
const unusable = (reason: string): ExternalIdentityFailure => externalIdentityFailure('identity_unusable', reason);
const ineligible = (reason: string): ExternalIdentityFailure => externalIdentityFailure('identity_ineligible', reason);
const notFound = (reason: string): ExternalIdentityFailure => externalIdentityFailure('identity_not_found', reason);
const bindingUnavailableReason = 'The external identity binding is unavailable';

const bindingSelection = {
  authBindingId: principalAuthBindings.principalAuthBindingId,
  authenticationNamespaceId: principalAuthBindings.authenticationNamespaceId,
  bindingRevision: principalAuthBindings.bindingRevision,
  bindingStatus: principalAuthBindings.status,
  createdByInvocationId: principalAuthBindings.createdByInvocationId,
  lastTransitionRef: principalAuthBindings.lastTransitionRef,
  principalId: principalAuthBindings.principalId,
  principalKind: principals.kind,
  principalStatus: principals.status,
  provider: principalAuthBindings.provider,
  providerSubjectId: principalAuthBindings.providerSubjectId,
  revokedAt: principalAuthBindings.revokedAt,
  subjectType: principalAuthBindings.subjectType,
  tenantId: principalAuthBindings.tenantId,
  tenantStatus: tenants.status,
};

const samePrincipal = () =>
  and(
    eq(principals.tenantId, principalAuthBindings.tenantId),
    eq(principals.principalId, principalAuthBindings.principalId),
  );

const sameBinding = (tenantId: string, authBindingId: string) =>
  and(eq(principalAuthBindings.tenantId, tenantId), eq(principalAuthBindings.principalAuthBindingId, authBindingId));

interface BindingSelectionRow {
  readonly authBindingId: string;
  readonly authenticationNamespaceId: string;
  readonly bindingRevision: number;
  readonly bindingStatus: string;
  readonly createdByInvocationId: string | null;
  readonly lastTransitionRef: string | null;
  readonly principalId: string;
  readonly principalKind: string;
  readonly principalStatus: string;
  readonly provider: string;
  readonly providerSubjectId: string;
  readonly revokedAt: Date | null;
  readonly subjectType: string;
  readonly tenantId: string;
  readonly tenantStatus: string;
}

const normalizeBinding = (record: BindingSelectionRow): ExternalIdentityBindingRecord | undefined => {
  if (
    !isBindingStatus(record.bindingStatus) ||
    !isPrincipalStatus(record.principalStatus) ||
    !isPrincipalKind(record.principalKind) ||
    (record.subjectType !== 'user' && record.subjectType !== 'api_key') ||
    !isTenantStatus(record.tenantStatus)
  ) {
    return undefined;
  }
  return {
    authBindingId: record.authBindingId,
    authenticationNamespaceId: record.authenticationNamespaceId,
    bindingRevision: record.bindingRevision,
    bindingStatus: record.bindingStatus,
    createdByInvocationId: record.createdByInvocationId,
    lastTransitionRef: record.lastTransitionRef,
    principalId: record.principalId,
    principalKind: record.principalKind,
    principalStatus: record.principalStatus,
    provider: record.provider,
    providerSubjectId: record.providerSubjectId,
    revokedAt: record.revokedAt,
    subjectType: record.subjectType,
    tenantId: record.tenantId,
    tenantStatus: record.tenantStatus,
  };
};

const registrationFrom = (
  dependencies: ExternalIdentityRepositoryDependencies,
  authenticationNamespaceId: string,
): Effect.Effect<AuthenticationNamespaceRegistration, ExternalIdentityFailure> => {
  const lookup = (
    registry: AuthenticationNamespaceRegistryService,
    decodedNamespaceId: Schema.Schema.Type<typeof AuthenticationNamespaceIdSchema>,
  ) =>
    registry
      .lookup(decodedNamespaceId)
      .pipe(
        Effect.flatMap((registration) =>
          Effect.fromOption(registration).pipe(
            Effect.mapError((cause) =>
              Object.assign(ineligible('The authentication namespace is not registered'), { cause }),
            ),
          ),
        ),
      );
  return Schema.decodeEffect(AuthenticationNamespaceIdSchema)(authenticationNamespaceId).pipe(
    Effect.mapError((cause) => Object.assign(invalid('The authentication namespace is malformed'), { cause })),
    Effect.flatMap((decodedNamespaceId) => {
      if (dependencies.registry !== undefined) {
        return lookup(dependencies.registry, decodedNamespaceId);
      }
      return Effect.serviceOption(
        // The registry is optional at the Context boundary so direct repository
        // users cannot silently substitute request-derived provider metadata.
        AuthenticationNamespaceRegistry,
      ).pipe(
        Effect.flatMap((registry) =>
          Option.isNone(registry)
            ? Effect.fail(persistenceFailure('The authentication namespace registry is not configured'))
            : lookup(registry.value, decodedNamespaceId),
        ),
      );
    }),
  );
};

const authorizeNamespace = (
  dependencies: ExternalIdentityRepositoryDependencies,
  authenticationNamespaceId: string,
): Effect.Effect<void, ExternalIdentityFailure> =>
  dependencies.authorizeNamespace === undefined
    ? Effect.void
    : dependencies.authorizeNamespace(authenticationNamespaceId);

const authorizeReadNamespace = (
  dependencies: ExternalIdentityRepositoryDependencies,
  authenticationNamespaceId: string,
): Effect.Effect<void, ExternalIdentityFailure> =>
  dependencies.authorizeReadNamespace === undefined
    ? Effect.void
    : dependencies.authorizeReadNamespace(authenticationNamespaceId);

const validateRegistration = (
  record: ExternalIdentityBindingRecord,
  registration: AuthenticationNamespaceRegistration,
): Effect.Effect<void, ExternalIdentityFailure> => {
  if (
    record.authenticationNamespaceId !== registration.authenticationNamespaceId ||
    record.provider !== registration.provider ||
    !registration.subjectTypes.includes(record.subjectType) ||
    record.principalKind !== registration.reservationPrincipalKind
  ) {
    return Effect.fail(ineligible('The binding does not match its trusted namespace registration'));
  }
  return Effect.void;
};

const validateCurrentBinding = (
  record: ExternalIdentityBindingRecord,
): Effect.Effect<void, ExternalIdentityFailure> => {
  if (
    record.bindingStatus !== 'active' ||
    record.revokedAt !== null ||
    record.principalStatus !== 'active' ||
    record.tenantStatus !== 'active'
  ) {
    return Effect.fail(unusable('The external identity binding is not current'));
  }
  return Effect.void;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- DB rows are decoded at this repository boundary.
const decodeSubject = (subject: unknown): Effect.Effect<ExternalUserSubject, ExternalIdentityFailure> =>
  Schema.decodeUnknownEffect(ExternalAuthenticationSubjectSchema)(subject).pipe(
    Effect.mapError((cause) => Object.assign(invalid('The external authentication subject is malformed'), { cause })),
  );

const requireSubjectAdmission = (
  admission: ExternalIdentityAdmissionContext | undefined,
  expected: ExternalUserSubject,
  tenantId: string,
): Effect.Effect<void, ExternalIdentityFailure> => {
  if (admission === undefined) {
    return Effect.fail(invalid('A trusted pre-binding subject admission is required'));
  }
  if (admission.match.kind !== 'subject') {
    return Effect.fail(invalid('A trusted pre-binding subject admission is required'));
  }
  const match = admission.match.expected;
  if (
    match.authenticationNamespaceId !== expected.authenticationNamespaceId ||
    match.providerSubjectId !== expected.providerSubjectId ||
    match.subjectType !== expected.subjectType ||
    match.tenantId !== tenantId
  ) {
    return Effect.fail(invalid('The pre-binding subject admission does not match the receiving operation'));
  }
  return assertExternalSubjectAdmission(admission.admission, match);
};

const loadByBinding = (
  transaction: Pick<ScopedTransactionExecutor, 'select'>,
  input: { readonly authBindingId: string; readonly forUpdate?: boolean; readonly tenantId: string },
): Effect.Effect<Option.Option<ExternalIdentityBindingRecord>, ExternalIdentityFailure> => {
  const query = transaction
    .select(bindingSelection)
    .from(principalAuthBindings)
    .innerJoin(principals, samePrincipal())
    .innerJoin(tenants, eq(tenants.tenantId, principalAuthBindings.tenantId))
    .where(sameBinding(input.tenantId, input.authBindingId))
    .limit(2);
  const selected = input.forUpdate === true ? query.for('update') : query;
  return selected.pipe(
    Effect.mapError((cause) => persistenceFailure('The external identity binding could not be read', cause)),
    Effect.flatMap((records) => {
      if (records.length > 1) {
        return Effect.fail(conflict('The external identity binding is ambiguous'));
      }
      const [record] = records;
      const normalized = record === undefined ? undefined : normalizeBinding(record);
      return normalized === undefined ? Effect.succeedNone : Effect.succeedSome(normalized);
    }),
  );
};

const loadBySubject = (
  transaction: Pick<ScopedTransactionExecutor, 'select'>,
  input: {
    readonly authenticationNamespaceId: string;
    readonly forUpdate?: boolean;
    readonly provider: string;
    readonly providerSubjectId: string;
    readonly subjectType: ExternalUserSubject['subjectType'];
    readonly tenantId: string;
  },
): Effect.Effect<Option.Option<ExternalIdentityBindingRecord>, ExternalIdentityFailure> => {
  const query = transaction
    .select(bindingSelection)
    .from(principalAuthBindings)
    .innerJoin(principals, samePrincipal())
    .innerJoin(tenants, eq(tenants.tenantId, principalAuthBindings.tenantId))
    .where(
      and(
        eq(principalAuthBindings.tenantId, input.tenantId),
        eq(principalAuthBindings.authenticationNamespaceId, input.authenticationNamespaceId),
        eq(principalAuthBindings.provider, input.provider),
        eq(principalAuthBindings.providerSubjectId, input.providerSubjectId),
        eq(principalAuthBindings.subjectType, input.subjectType),
      ),
    )
    .limit(2);
  const selected = input.forUpdate === true ? query.for('update') : query;
  return selected.pipe(
    Effect.mapError((cause) => persistenceFailure('The external identity binding could not be read', cause)),
    Effect.flatMap((records) => {
      if (records.length > 1) {
        return Effect.fail(conflict('The external identity subject mapping is ambiguous'));
      }
      const [record] = records;
      const normalized = record === undefined ? undefined : normalizeBinding(record);
      return normalized === undefined ? Effect.succeedNone : Effect.succeedSome(normalized);
    }),
  );
};

const ensureSubjectAllowed = (
  subject: ExternalUserSubject,
  registration: AuthenticationNamespaceRegistration,
): Effect.Effect<void, ExternalIdentityFailure> =>
  registration.subjectTypes.includes(subject.subjectType)
    ? Effect.void
    : Effect.fail(ineligible('The subject type is not enabled for the authentication namespace'));

const statusTransitionAllowed = (previous: BindingStatus, next: Exclude<BindingStatus, 'pending'>): boolean =>
  (previous === 'pending' && next === 'revoked') ||
  (previous === 'active' && (next === 'disabled' || next === 'revoked')) ||
  (previous === 'disabled' && (next === 'active' || next === 'revoked'));

const validateReactivation = (
  binding: ExternalIdentityBindingRecord,
  input: ChangeExternalIdentityStatusInput,
): Effect.Effect<void, ExternalIdentityFailure> => {
  if (binding.principalStatus !== 'active' || binding.tenantStatus !== 'active') {
    return Effect.fail(unusable('The disabled external identity Principal or Tenant is not active'));
  }
  if (input.reconciliationRef === undefined || input.reconciliationRef.trim().length === 0) {
    return Effect.fail(invalid('Reactivation requires a reconciliation reference'));
  }
  return decodeSubject({
    authenticationNamespaceId: binding.authenticationNamespaceId,
    providerSubjectId: binding.providerSubjectId,
    subjectType: binding.subjectType,
  }).pipe(Effect.flatMap((subject) => requireSubjectAdmission(input.admission, subject, binding.tenantId)));
};

const prepare = (
  transaction: ScopedTransactionExecutor,
  dependencies: ExternalIdentityRepositoryDependencies,
): ExternalIdentityRepositoryService['prepare'] =>
  Effect.fn('ExternalIdentityRepository.prepare')(function* prepareExternalIdentity(
    input: PrepareExternalIdentityInput,
  ) {
    const subject = yield* decodeSubject(input.subject);
    const registration = yield* registrationFrom(dependencies, subject.authenticationNamespaceId);
    yield* ensureSubjectAllowed(subject, registration);
    yield* authorizeNamespace(dependencies, subject.authenticationNamespaceId);
    if (registration.requiresOperationAdmission || input.admission !== undefined) {
      yield* requireSubjectAdmission(input.admission, subject, input.tenantId);
    }

    const insertedPrincipal = yield* transaction
      .insert(principals)
      .values({
        displayName: input.displayName ?? 'External principal',
        kind: registration.reservationPrincipalKind,
        status: 'active',
        tenantId: input.tenantId,
      })
      .returning({ principalId: principals.principalId })
      .pipe(Effect.mapError((cause) => persistenceFailure('The Principal could not be reserved', cause)));
    const [principal] = insertedPrincipal;
    if (principal === undefined) {
      return yield* persistenceFailure('The Principal reservation returned no row');
    }

    const insertedBinding = yield* transaction
      .insert(principalAuthBindings)
      .values({
        authenticationNamespaceId: subject.authenticationNamespaceId,
        createdByInvocationId: input.invocationId,
        lastTransitionRef: input.invocationId,
        principalId: principal.principalId,
        provider: registration.provider,
        providerSubjectId: subject.providerSubjectId,
        status: 'pending',
        subjectType: subject.subjectType,
        tenantId: input.tenantId,
      })
      .onConflictDoNothing({
        target: [
          principalAuthBindings.tenantId,
          principalAuthBindings.authenticationNamespaceId,
          principalAuthBindings.subjectType,
          principalAuthBindings.providerSubjectId,
        ],
      })
      .returning({
        authBindingId: principalAuthBindings.principalAuthBindingId,
        bindingRevision: principalAuthBindings.bindingRevision,
        status: principalAuthBindings.status,
      })
      .pipe(
        Effect.mapError((cause) =>
          persistenceFailure('The external identity reservation could not be persisted', cause),
        ),
      );
    const [binding] = insertedBinding;
    if (binding !== undefined) {
      if (binding.bindingRevision !== 1 || binding.status !== 'pending') {
        return yield* persistenceFailure('The new external identity reservation has an invalid initial state');
      }
      return {
        authBindingId: binding.authBindingId,
        bindingRevision: 1 as const,
        bindingStatus: 'pending' as const,
        outcome: 'RESERVED' as const,
        principalId: principal.principalId,
      };
    }

    // The unique K constraint serialized a concurrent winner. Remove the
    // losing transaction's unbound Principal before resolving that winner.
    yield* transaction
      .delete(principals)
      .where(and(eq(principals.tenantId, input.tenantId), eq(principals.principalId, principal.principalId)))
      .pipe(
        Effect.mapError((cause) =>
          persistenceFailure('The losing Principal reservation could not be rolled back', cause),
        ),
      );
    const existing = yield* loadBySubject(transaction, {
      authenticationNamespaceId: subject.authenticationNamespaceId,
      provider: registration.provider,
      providerSubjectId: subject.providerSubjectId,
      subjectType: subject.subjectType,
      tenantId: input.tenantId,
    });
    if (Option.isNone(existing)) {
      return yield* conflict('The winning external identity reservation could not be resolved');
    }
    yield* validateRegistration(existing.value, registration);
    return {
      authBindingId: existing.value.authBindingId,
      bindingRevision: existing.value.bindingRevision,
      bindingStatus: existing.value.bindingStatus,
      outcome: 'EXISTING' as const,
      principalId: existing.value.principalId,
    };
  });

const activate = (
  transaction: ScopedTransactionExecutor,
  dependencies: ExternalIdentityRepositoryDependencies,
): ExternalIdentityRepositoryService['activate'] =>
  Effect.fn('ExternalIdentityRepository.activate')(function* activateExternalIdentity(
    input: ActivateExternalIdentityInput,
  ) {
    const loaded = yield* loadByBinding(transaction, {
      authBindingId: input.authBindingId,
      forUpdate: true,
      tenantId: input.tenantId,
    });
    if (Option.isNone(loaded)) {
      return yield* notFound(bindingUnavailableReason);
    }
    const binding = loaded.value;
    const registration = yield* registrationFrom(dependencies, binding.authenticationNamespaceId);
    yield* validateRegistration(binding, registration);
    yield* authorizeNamespace(dependencies, binding.authenticationNamespaceId);
    if (binding.bindingRevision !== input.expectedRevision) {
      return yield* conflict('The external identity binding revision is stale');
    }
    if (binding.bindingStatus === 'active') {
      yield* validateCurrentBinding(binding);
      const subject = yield* decodeSubject({
        authenticationNamespaceId: binding.authenticationNamespaceId,
        providerSubjectId: binding.providerSubjectId,
        subjectType: binding.subjectType,
      });
      if (registration.requiresOperationAdmission || input.admission !== undefined) {
        yield* requireSubjectAdmission(input.admission, subject, input.tenantId);
      }
      // The row lock plus the exact expected revision above is the no-op CAS:
      // a repeat activation proves the current binding and cannot emit a new transition.
      return {
        authBindingId: input.authBindingId,
        authenticationNamespaceId: binding.authenticationNamespaceId,
        bindingRevision: binding.bindingRevision,
        bindingStatus: 'active' as const,
        changed: false,
        outcome: 'ACTIVATED' as const,
        principalId: binding.principalId,
        tenantId: input.tenantId,
        transitionRef: binding.lastTransitionRef ?? binding.authBindingId,
      };
    }
    if (binding.bindingStatus !== 'pending') {
      return yield* unusable('Only a pending external identity binding can be activated');
    }
    if (binding.principalStatus !== 'active' || binding.tenantStatus !== 'active' || binding.revokedAt !== null) {
      return yield* unusable('The pending external identity Principal or Tenant is not active');
    }
    const subject = yield* decodeSubject({
      authenticationNamespaceId: binding.authenticationNamespaceId,
      providerSubjectId: binding.providerSubjectId,
      subjectType: binding.subjectType,
    });
    if (registration.requiresOperationAdmission || input.admission !== undefined) {
      yield* requireSubjectAdmission(input.admission, subject, input.tenantId);
    }
    const updatedAt = DateTime.toDateUtc(DateTime.nowUnsafe());
    const updated = yield* transaction
      .update(principalAuthBindings)
      .set({
        bindingRevision: input.expectedRevision + 1,
        lastTransitionRef: input.invocationId,
        status: 'active',
        updatedAt,
      })
      .where(
        and(
          eq(principalAuthBindings.tenantId, input.tenantId),
          eq(principalAuthBindings.principalAuthBindingId, input.authBindingId),
          eq(principalAuthBindings.status, 'pending'),
          eq(principalAuthBindings.bindingRevision, input.expectedRevision),
        ),
      )
      .returning({ bindingRevision: principalAuthBindings.bindingRevision, status: principalAuthBindings.status })
      .pipe(
        Effect.mapError((cause) => persistenceFailure('The external identity binding could not be activated', cause)),
      );
    const [result] = updated;
    if (result === undefined) {
      return yield* conflict('The external identity binding changed concurrently');
    }
    return {
      authBindingId: input.authBindingId,
      authenticationNamespaceId: binding.authenticationNamespaceId,
      bindingRevision: result.bindingRevision,
      bindingStatus: 'active' as const,
      changed: true,
      outcome: 'ACTIVATED' as const,
      principalId: binding.principalId,
      tenantId: input.tenantId,
      transitionRef: input.invocationId,
    };
  });

const changeStatus = (
  transaction: ScopedTransactionExecutor,
  dependencies: ExternalIdentityRepositoryDependencies,
): ExternalIdentityRepositoryService['changeStatus'] =>
  Effect.fn('ExternalIdentityRepository.changeStatus')(function* changeExternalIdentityStatus(
    input: ChangeExternalIdentityStatusInput,
  ) {
    const loaded = yield* loadByBinding(transaction, {
      authBindingId: input.authBindingId,
      forUpdate: true,
      tenantId: input.tenantId,
    });
    if (Option.isNone(loaded)) {
      return yield* notFound(bindingUnavailableReason);
    }
    const binding = loaded.value;
    const registration = yield* registrationFrom(dependencies, binding.authenticationNamespaceId);
    yield* validateRegistration(binding, registration);
    if (binding.bindingRevision !== input.expectedRevision) {
      return yield* conflict('The external identity binding revision is stale');
    }

    if (input.requestedStatus === binding.bindingStatus) {
      return {
        authBindingId: binding.authBindingId,
        authenticationNamespaceId: binding.authenticationNamespaceId,
        bindingRevision: binding.bindingRevision,
        bindingStatus: binding.bindingStatus,
        previousStatus: binding.bindingStatus,
        principalId: binding.principalId,
        tenantId: binding.tenantId,
        transitionRef: binding.lastTransitionRef ?? binding.authBindingId,
      };
    }

    if (!statusTransitionAllowed(binding.bindingStatus, input.requestedStatus)) {
      return yield* conflict('The external identity binding transition is not supported');
    }
    if (binding.bindingStatus === 'disabled' && input.requestedStatus === 'active') {
      yield* validateReactivation(binding, input);
    }
    const updatedAt = DateTime.toDateUtc(DateTime.nowUnsafe());
    const updated = yield* transaction
      .update(principalAuthBindings)
      .set({
        bindingRevision: input.expectedRevision + 1,
        lastTransitionRef: input.invocationId,
        revokedAt: input.requestedStatus === 'revoked' ? updatedAt : null,
        status: input.requestedStatus,
        updatedAt,
      })
      .where(
        and(
          eq(principalAuthBindings.tenantId, input.tenantId),
          eq(principalAuthBindings.principalAuthBindingId, input.authBindingId),
          eq(principalAuthBindings.status, binding.bindingStatus),
          eq(principalAuthBindings.bindingRevision, input.expectedRevision),
        ),
      )
      .returning({ bindingRevision: principalAuthBindings.bindingRevision, status: principalAuthBindings.status })
      .pipe(Effect.mapError((cause) => persistenceFailure('The binding status could not be changed', cause)));
    const [result] = updated;
    if (result === undefined) {
      return yield* conflict('The external identity binding changed concurrently');
    }
    return {
      authBindingId: binding.authBindingId,
      authenticationNamespaceId: binding.authenticationNamespaceId,
      bindingRevision: result.bindingRevision,
      bindingStatus: result.status,
      previousStatus: binding.bindingStatus,
      principalId: binding.principalId,
      tenantId: binding.tenantId,
      transitionRef: input.invocationId,
    };
  });

const toReadResult = (binding: ExternalIdentityBindingRecord) => ({
  authBindingId: binding.authBindingId,
  authenticationNamespaceId: binding.authenticationNamespaceId,
  bindingRevision: binding.bindingRevision,
  bindingStatus: binding.bindingStatus,
  originalInvocationId: binding.createdByInvocationId,
  outcome: 'FOUND',
  principalId: binding.principalId,
  principalStatus: binding.principalStatus,
  tenantStatus: binding.tenantStatus,
});

const read = (
  transaction: ScopedTransactionExecutor,
  dependencies: ExternalIdentityRepositoryDependencies,
): ExternalIdentityRepositoryService['read'] =>
  Effect.fn('ExternalIdentityRepository.read')(function* readPrincipalBinding(input: ReadPrincipalBindingInput) {
    let binding: Option.Option<ExternalIdentityBindingRecord>;
    if (input.lookup === 'binding') {
      binding = yield* loadByBinding(transaction, {
        authBindingId: input.authBindingId ?? '',
        tenantId: input.tenantId,
      });
    } else {
      const namespaceId = input.authenticationNamespaceId ?? '';
      // Authorize the caller against the supplied namespace before querying the
      // subject tuple. Otherwise a missing subject leaks a different result
      // from an existing subject that the caller cannot read.
      yield* authorizeReadNamespace(dependencies, namespaceId);
      const registration = yield* registrationFrom(dependencies, namespaceId);
      const subjectType = input.subjectType ?? 'user';
      binding = yield* loadBySubject(transaction, {
        authenticationNamespaceId: namespaceId,
        provider: registration.provider,
        providerSubjectId: input.providerSubjectId ?? '',
        subjectType,
        tenantId: input.tenantId,
      });
    }
    if (Option.isNone(binding)) {
      return { outcome: 'NOT_FOUND' as const };
    }
    // Binding identifiers are opaque. Normalize an inaccessible binding to
    // the same result as an absent one so the lookup cannot disclose whether
    // another namespace owns that identifier.
    const canReadBinding = yield* authorizeReadNamespace(dependencies, binding.value.authenticationNamespaceId).pipe(
      Effect.as(true),
      Effect.catchIf(
        (failure) => failure.code === 'identity_forbidden',
        () => Effect.succeed(false),
      ),
    );
    if (!canReadBinding) {
      return { outcome: 'NOT_FOUND' as const };
    }
    const registration = yield* registrationFrom(dependencies, binding.value.authenticationNamespaceId);
    yield* validateRegistration(binding.value, registration);
    return yield* Schema.decodeUnknownEffect(ReadPrincipalBindingResultSchema)(toReadResult(binding.value)).pipe(
      Effect.mapError((cause) => persistenceFailure('The external identity binding result is malformed', cause)),
    );
  });

const resolve = (
  transaction: ScopedTransactionExecutor,
  dependencies: ExternalIdentityRepositoryDependencies,
): ExternalIdentityRepositoryService['resolve'] =>
  Effect.fn('ExternalIdentityRepository.resolve')(function* resolveExternalSubject(input) {
    if (input.admission.match.kind !== 'authentication') {
      return yield* invalid('A trusted bound authentication admission is required');
    }
    const subject = yield* decodeSubject(input.subject);
    const { expected } = input.admission.match;
    if (
      expected.tenantId !== input.tenantId ||
      expected.authenticationNamespaceId !== subject.authenticationNamespaceId
    ) {
      return yield* invalid('The authentication namespace does not match the authentication admission');
    }
    yield* assertAuthenticationAdmission(input.admission.admission, expected);
    const observation = yield* authenticationObservationFromAdmission(input.admission.admission);
    const registration = yield* registrationFrom(dependencies, observation.authenticationNamespaceId);
    yield* ensureSubjectAllowed(subject, registration);
    const loaded = yield* loadByBinding(transaction, {
      authBindingId: observation.authBindingId,
      tenantId: input.tenantId,
    });
    if (Option.isNone(loaded)) {
      return yield* notFound('The verified external subject has no Core binding');
    }
    const binding = loaded.value;
    yield* validateRegistration(binding, registration);
    if (
      binding.providerSubjectId !== subject.providerSubjectId ||
      binding.subjectType !== subject.subjectType ||
      binding.authenticationNamespaceId !== subject.authenticationNamespaceId ||
      binding.principalId !== observation.principalId ||
      binding.bindingRevision !== observation.bindingRevision
    ) {
      return yield* invalid('The authentication admission does not match the current Core binding');
    }
    yield* validateCurrentBinding(binding);
    return yield* Schema.decodeEffect(ResolveExternalSubjectResultSchema)({
      authBindingId: binding.authBindingId,
      authenticationNamespaceId: binding.authenticationNamespaceId,
      bindingRevision: binding.bindingRevision,
      bindingStatus: 'active' as const,
      outcome: 'RESOLVED' as const,
      principalId: binding.principalId,
      tenantId: binding.tenantId,
    }).pipe(
      Effect.mapError((cause) => persistenceFailure('The resolved external identity result is malformed', cause)),
    );
  });

export const externalIdentityRepositoryFromTransaction = (
  transaction: ScopedTransactionExecutor,
  dependencies: ExternalIdentityRepositoryDependencies = {},
): ExternalIdentityRepositoryService =>
  Object.freeze({
    activate: activate(transaction, dependencies),
    changeStatus: changeStatus(transaction, dependencies),
    prepare: prepare(transaction, dependencies),
    read: read(transaction, dependencies),
    resolve: resolve(transaction, dependencies),
  });

export const externalIdentityQueryHash = (subject: ExternalUserSubject): string =>
  createHash('sha256')
    .update(`${subject.authenticationNamespaceId}\u0000${subject.subjectType}\u0000${subject.providerSubjectId}`)
    .digest('hex');

export interface ExternalIdentityBindingSubjectLookupInput {
  readonly authBindingId: string;
  readonly authenticationNamespaceId: string;
  readonly tenantId: string;
}

/** Reads the immutable provider subject from a trusted binding reference. */
export const externalIdentitySubjectForBinding = Effect.fn('Repository.externalIdentitySubjectForBinding')(
  function* externalIdentitySubjectForBindingEffect(
    transaction: Pick<ScopedTransactionExecutor, 'select'>,
    input: ExternalIdentityBindingSubjectLookupInput,
  ) {
    const loaded = yield* loadByBinding(transaction, {
      authBindingId: input.authBindingId,
      tenantId: input.tenantId,
    });
    if (Option.isNone(loaded)) {
      return yield* notFound(bindingUnavailableReason);
    }
    if (loaded.value.authenticationNamespaceId !== input.authenticationNamespaceId) {
      return yield* invalid('The external identity namespace does not match the binding');
    }
    return yield* Schema.decodeEffect(ExternalAuthenticationSubjectSchema)({
      authenticationNamespaceId: loaded.value.authenticationNamespaceId,
      providerSubjectId: loaded.value.providerSubjectId,
      subjectType: loaded.value.subjectType,
    }).pipe(Effect.mapError((cause) => persistenceFailure('The binding subject is malformed', cause)));
  },
);
