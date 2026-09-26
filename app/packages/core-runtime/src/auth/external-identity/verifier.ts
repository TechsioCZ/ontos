import { Clock, Context, DateTime, Effect, Option, Result, Schema } from 'effect';

import {
  AuthenticationAdmissionObservationSchema,
  AuthenticationNamespaceRegistrationSchema,
  ExternalAuthenticationSubjectSchema,
  ExternalSubjectAdmissionObservationSchema,
  PrincipalIdSchema,
} from '../external-identity-contracts.ts';
import type {
  AuthBindingIdSchema,
  AuthenticationNamespaceIdSchema,
  AuthenticationAdmissionObservation,
  ExternalAuthenticationSubject,
  AuthenticationNamespaceRegistration,
  ExternalSubjectAdmissionObservation,
  ProviderSubjectIdSchema,
  TenantIdSchema,
} from '../external-identity-contracts.ts';
import { externalIdentityFailure } from './errors.ts';
import type { ExternalIdentityFailure } from './errors.ts';
import { TrustedAdmissionObservation } from './trusted-admission-observation.ts';
import type { TrustedAuthenticationAdmissionServiceContract } from './trusted-authentication-admission-service.ts';
import type { TrustedExternalSubjectAdmissionServiceContract } from './trusted-external-subject-admission-service.ts';

export { externalIdentityFailure } from './errors.ts';
export type { ExternalIdentityFailure } from './errors.ts';
export { TrustedAuthenticationAdmissionService } from './trusted-authentication-admission-service.ts';
export type { TrustedAuthenticationAdmissionServiceContract } from './trusted-authentication-admission-service.ts';
export { TrustedExternalSubjectAdmissionService } from './trusted-external-subject-admission-service.ts';
export type { TrustedExternalSubjectAdmissionServiceContract } from './trusted-external-subject-admission-service.ts';
export { TrustedAdmissionObservation } from './trusted-admission-observation.ts';
export type { TrustedAdmissionObservationService } from './trusted-admission-observation.ts';

type AuthenticationNamespaceId = Schema.Schema.Type<typeof AuthenticationNamespaceIdSchema>;

/**
 * Authentication namespace registrations are deployment data. Core only
 * consumes a validated registration; it never derives one from a request.
 */
export interface AuthenticationNamespaceRegistryService {
  readonly lookup: (
    authenticationNamespaceId: AuthenticationNamespaceId,
  ) => Effect.Effect<Option.Option<AuthenticationNamespaceRegistration>, ExternalIdentityFailure>;
}

export class AuthenticationNamespaceRegistry extends Context.Service<
  AuthenticationNamespaceRegistry,
  AuthenticationNamespaceRegistryService
>()('@app/core-runtime/auth/external-identity/verifier/AuthenticationNamespaceRegistry') {}

const invalid = (reason: string): ExternalIdentityFailure => externalIdentityFailure('identity_invalid', reason);
const invalidWithCause = (reason: string, cause: unknown): ExternalIdentityFailure =>
  Object.defineProperty(invalid(reason), 'cause', { configurable: true, value: cause });
const unavailable = (reason: string): ExternalIdentityFailure =>
  externalIdentityFailure('identity_unavailable', reason);

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const AuthenticationNamespaceRegistrationListSchema = Schema.Array(AuthenticationNamespaceRegistrationSchema).check(
  Schema.makeFilter((registrations) => {
    const issues: Schema.FilterIssue[] = [];
    if (!unique(registrations.map(({ authenticationNamespaceId }) => authenticationNamespaceId))) {
      issues.push({ issue: 'Authentication namespace registrations must have unique IDs', path: [] });
    }
    for (const [index, registration] of registrations.entries()) {
      if (!unique(registration.subjectTypes)) {
        issues.push({ issue: 'An authentication namespace cannot repeat a subject type', path: [index] });
      }
      if (!unique(registration.allowedAudiences)) {
        issues.push({ issue: 'An authentication namespace cannot repeat an audience', path: [index] });
      }
      if (!unique(registration.trustedAttesterPrincipalIds)) {
        issues.push({ issue: 'An authentication namespace cannot repeat an attester', path: [index] });
      }
    }
    return issues;
  }),
);

const decodeRegistrations = (
  registrations: readonly AuthenticationNamespaceRegistration[],
): readonly AuthenticationNamespaceRegistration[] =>
  Object.freeze(
    Result.getOrThrow(
      Schema.decodeResult(AuthenticationNamespaceRegistrationListSchema, { onExcessProperty: 'error' })(registrations),
    ).map((registration) =>
      Object.freeze({
        ...registration,
        allowedAudiences: Object.freeze([...registration.allowedAudiences]),
        subjectTypes: Object.freeze([...registration.subjectTypes]),
        trustedAttesterPrincipalIds: Object.freeze([...registration.trustedAttesterPrincipalIds]),
      }),
    ),
  );

/**
 * Builds the registry from trusted composition data. Invalid deployment data
 * fails during layer construction; request fields never reach this function.
 */
export const makeAuthenticationNamespaceRegistry = (
  registrations: readonly AuthenticationNamespaceRegistration[],
): AuthenticationNamespaceRegistryService => {
  const entries = new Map<string, AuthenticationNamespaceRegistration>(
    decodeRegistrations(registrations).map((registration) => [registration.authenticationNamespaceId, registration]),
  );
  return {
    lookup: (authenticationNamespaceId) => Effect.succeed(Option.fromNullishOr(entries.get(authenticationNamespaceId))),
  };
};

/** Effect wrapper for composition roots that want typed startup failure. */
export const makeAuthenticationNamespaceRegistryEffect = (
  registrations: readonly AuthenticationNamespaceRegistration[],
): Effect.Effect<AuthenticationNamespaceRegistryService, ExternalIdentityFailure> =>
  Effect.try({
    catch: (cause) =>
      Object.defineProperty(unavailable('Authentication namespace registration is invalid'), 'cause', {
        configurable: true,
        value: cause,
      }),
    try: () => makeAuthenticationNamespaceRegistry(registrations),
  });

const subjectAdmissionMarker: unique symbol = Symbol('@app/core-runtime/external-identity/subject-admission');
const authenticationAdmissionMarker: unique symbol = Symbol(
  '@app/core-runtime/external-identity/authentication-admission',
);

/** A pre-binding subject proof. It contains no fabricated Core identity IDs. */
export interface VerifiedExternalSubjectAdmission {
  readonly [subjectAdmissionMarker]: true;
}

/** A bound receiving-operation proof. It is never an authorization lease. */
export interface VerifiedAuthenticationAdmission {
  readonly [authenticationAdmissionMarker]: true;
}

/** Union used by code that accepts either the pre-binding or bound seam. */
export type VerifiedExternalIdentityAdmission = VerifiedAuthenticationAdmission | VerifiedExternalSubjectAdmission;

interface SubjectAdmissionPayload {
  readonly clock: AdmissionClock;
  consumed: boolean;
  readonly maxAdmissionWindowMillis: number;
  readonly observation: ExternalSubjectAdmissionObservation;
}

interface AuthenticationAdmissionPayload {
  readonly clock: AdmissionClock;
  consumed: boolean;
  readonly maxAdmissionWindowMillis: number;
  readonly observation: AuthenticationAdmissionObservation;
}

// These weak maps are the capability store. Entries are reachable only while the
// opaque capability is reachable and cannot be supplied by a wire caller.
// oxlint-disable-next-line effect-native/no-unmanaged-mutable-state -- WeakMap entries are transient capability metadata.
const subjectAdmissions = new WeakMap<object, SubjectAdmissionPayload>();
// oxlint-disable-next-line effect-native/no-unmanaged-mutable-state -- WeakMap entries are transient capability metadata.
const authenticationAdmissions = new WeakMap<object, AuthenticationAdmissionPayload>();

const freezeObservation = <Observation extends object>(observation: Observation): Observation =>
  Object.freeze({ ...observation });

const makeTrustedExternalSubjectAdmission = (
  observation: ExternalSubjectAdmissionObservation,
  timing: { readonly clock: AdmissionClock; readonly maxAdmissionWindowMillis: number },
): VerifiedExternalSubjectAdmission => {
  const admission: VerifiedExternalSubjectAdmission = Object.freeze({ [subjectAdmissionMarker]: true as const });
  subjectAdmissions.set(admission, {
    clock: timing.clock,
    consumed: false,
    maxAdmissionWindowMillis: timing.maxAdmissionWindowMillis,
    observation: freezeObservation(observation),
  });
  return admission;
};

const makeTrustedAuthenticationAdmission = (
  observation: AuthenticationAdmissionObservation,
  timing: { readonly clock: AdmissionClock; readonly maxAdmissionWindowMillis: number },
): VerifiedAuthenticationAdmission => {
  const admission: VerifiedAuthenticationAdmission = Object.freeze({
    [authenticationAdmissionMarker]: true as const,
  });
  authenticationAdmissions.set(admission, {
    clock: timing.clock,
    consumed: false,
    maxAdmissionWindowMillis: timing.maxAdmissionWindowMillis,
    observation: freezeObservation(observation),
  });
  return admission;
};

// Capability checks intentionally accept unknown values so forged/plain objects are rejected.
// oxlint-disable-next-line anti-slop/no-unknown-parameters, effect-native/no-refinement-outside-schema, anti-slop/no-runtime-typeof -- WeakMap membership is the non-schema trust invariant.
const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;
// oxlint-disable-next-line anti-slop/no-unknown-parameters, effect-native/no-refinement-outside-schema -- Private WeakMap membership proves the capability.
const isTrustedSubjectAdmission = (value: unknown): value is VerifiedExternalSubjectAdmission =>
  isObject(value) && subjectAdmissions.has(value);
// oxlint-disable-next-line anti-slop/no-unknown-parameters, effect-native/no-refinement-outside-schema -- Private WeakMap membership proves the capability.
const isTrustedAuthenticationAdmission = (value: unknown): value is VerifiedAuthenticationAdmission =>
  isObject(value) && authenticationAdmissions.has(value);

export interface ExternalSubjectAdmissionMatch {
  readonly audience: string;
  readonly authContextRef: string;
  readonly authenticationNamespaceId: Schema.Schema.Type<typeof AuthenticationNamespaceIdSchema>;
  readonly nonce: string;
  readonly operationRef: string;
  readonly providerSubjectId: Schema.Schema.Type<typeof ProviderSubjectIdSchema>;
  readonly subjectType: ExternalAuthenticationSubject['subjectType'];
  readonly tenantId: Schema.Schema.Type<typeof TenantIdSchema>;
}

export interface AuthenticationAdmissionMatch {
  readonly audience: string;
  readonly authBindingId: Schema.Schema.Type<typeof AuthBindingIdSchema>;
  readonly authContextRef: string;
  readonly authenticationNamespaceId: Schema.Schema.Type<typeof AuthenticationNamespaceIdSchema>;
  readonly bindingRevision: number;
  readonly nonce: string;
  readonly operationRef: string;
  readonly principalId: Schema.Schema.Type<typeof PrincipalIdSchema>;
  readonly tenantId: Schema.Schema.Type<typeof TenantIdSchema>;
}

const matchesSubject = (
  observation: ExternalSubjectAdmissionObservation,
  expected: ExternalSubjectAdmissionMatch,
): boolean =>
  observation.authenticationNamespaceId === expected.authenticationNamespaceId &&
  observation.audience === expected.audience &&
  observation.authContextRef === expected.authContextRef &&
  observation.nonce === expected.nonce &&
  observation.operationRef === expected.operationRef &&
  observation.providerSubjectId === expected.providerSubjectId &&
  observation.subjectType === expected.subjectType &&
  observation.tenantId === expected.tenantId;

const matchesAuthentication = (
  observation: AuthenticationAdmissionObservation,
  expected: AuthenticationAdmissionMatch,
): boolean =>
  observation.authenticationNamespaceId === expected.authenticationNamespaceId &&
  observation.audience === expected.audience &&
  observation.authBindingId === expected.authBindingId &&
  observation.authContextRef === expected.authContextRef &&
  observation.bindingRevision === expected.bindingRevision &&
  observation.nonce === expected.nonce &&
  observation.operationRef === expected.operationRef &&
  observation.principalId === expected.principalId &&
  observation.tenantId === expected.tenantId;

const isFresh = <Observation extends { readonly expiresAt: DateTime.Utc; readonly observedAt: DateTime.Utc }>(
  observation: Observation,
  now: DateTime.Utc,
  maxAdmissionWindowMillis: number,
): boolean => {
  const observedAt = DateTime.toEpochMillis(observation.observedAt);
  const expiresAt = DateTime.toEpochMillis(observation.expiresAt);
  const current = DateTime.toEpochMillis(now);
  return !(
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(current) ||
    expiresAt <= observedAt ||
    current < observedAt ||
    current >= expiresAt ||
    expiresAt - observedAt > maxAdmissionWindowMillis
  );
};

interface ConsumableAdmissionPayload {
  readonly clock: AdmissionClock;
  consumed: boolean;
  readonly maxAdmissionWindowMillis: number;
  readonly observation: {
    readonly expiresAt: DateTime.Utc;
    readonly observedAt: DateTime.Utc;
  };
}

const consumeForAssertion = <Payload extends ConsumableAdmissionPayload>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Capability assertions must reject wire/plain values before WeakMap lookup.
  admission: unknown,
  admissions: WeakMap<object, Payload>,
  matches: (payload: Payload) => boolean,
  requiredReason: string,
  mismatchReason: string,
): Effect.Effect<void, ExternalIdentityFailure> =>
  // Membership, matching, freshness and the consume transition all execute on
  // the same post-clock synchronous step. This makes a returned Effect safe to
  // reuse and makes concurrent assertions resolve to exactly one success.
  Effect.suspend(() => {
    if (!isObject(admission)) {
      return Effect.fail(invalid(requiredReason));
    }
    const payload = admissions.get(admission);
    if (payload === undefined) {
      return Effect.fail(invalid(requiredReason));
    }
    return payload.clock().pipe(
      Effect.flatMap((now) =>
        Effect.suspend(() => {
          if (payload.consumed) {
            return Effect.fail(invalid('The authentication admission has already been consumed'));
          }
          if (!matches(payload)) {
            return Effect.fail(invalid(mismatchReason));
          }
          if (!isFresh(payload.observation, now, payload.maxAdmissionWindowMillis)) {
            return Effect.fail(invalid('The authentication admission is expired or outside its bounded deadline'));
          }
          payload.consumed = true;
          return Effect.void;
        }),
      ),
    );
  });

const SUBJECT_ADMISSION_REQUIRED_REASON = 'A trusted pre-binding subject admission is required';
const AUTHENTICATION_ADMISSION_REQUIRED_REASON = 'A trusted authentication admission is required';

/** Validates and consumes the operation-bound pre-binding capability. */
export const assertExternalSubjectAdmission = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Rejecting unknown values is required for non-forgeable capabilities.
  admission: unknown,
  expected: ExternalSubjectAdmissionMatch,
): Effect.Effect<void, ExternalIdentityFailure> =>
  consumeForAssertion(
    admission,
    subjectAdmissions,
    (payload) => matchesSubject(payload.observation, expected),
    SUBJECT_ADMISSION_REQUIRED_REASON,
    'The pre-binding subject admission does not match the receiving operation',
  );

/** Validates and consumes the operation-bound, already-bound capability. */
export const assertAuthenticationAdmission = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Rejecting unknown values is required for non-forgeable capabilities.
  admission: unknown,
  expected: AuthenticationAdmissionMatch,
): Effect.Effect<void, ExternalIdentityFailure> =>
  consumeForAssertion(
    admission,
    authenticationAdmissions,
    (payload) => matchesAuthentication(payload.observation, expected),
    AUTHENTICATION_ADMISSION_REQUIRED_REASON,
    'The authentication admission does not match the receiving operation',
  );

export const externalSubjectFromAdmission = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Accessors reject wire/plain values before exposing subject data.
  admission: unknown,
): Effect.Effect<ExternalAuthenticationSubject, ExternalIdentityFailure> => {
  if (!isTrustedSubjectAdmission(admission)) {
    return Effect.fail(invalid(SUBJECT_ADMISSION_REQUIRED_REASON));
  }
  const payload = subjectAdmissions.get(admission);
  if (payload === undefined) {
    return Effect.fail(invalid(SUBJECT_ADMISSION_REQUIRED_REASON));
  }
  return Effect.succeed({
    authenticationNamespaceId: payload.observation.authenticationNamespaceId,
    providerSubjectId: payload.observation.providerSubjectId,
    subjectType: payload.observation.subjectType,
  });
};

export const authenticationObservationFromAdmission = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Accessors reject wire/plain values before exposing observations.
  admission: unknown,
): Effect.Effect<AuthenticationAdmissionObservation, ExternalIdentityFailure> => {
  if (!isTrustedAuthenticationAdmission(admission)) {
    return Effect.fail(invalid(AUTHENTICATION_ADMISSION_REQUIRED_REASON));
  }
  const payload = authenticationAdmissions.get(admission);
  if (payload === undefined) {
    return Effect.fail(invalid(AUTHENTICATION_ADMISSION_REQUIRED_REASON));
  }
  return Effect.succeed(payload.observation);
};

export type AdmissionClock = () => Effect.Effect<DateTime.Utc>;

const validateFreshness = <Observation extends { readonly expiresAt: DateTime.Utc; readonly observedAt: DateTime.Utc }>(
  observation: Observation,
  now: DateTime.Utc,
  maxAdmissionWindowMillis: number,
): Effect.Effect<void, ExternalIdentityFailure> =>
  isFresh(observation, now, maxAdmissionWindowMillis)
    ? Effect.void
    : Effect.fail(invalid('The authentication admission is expired or outside its bounded deadline'));

const decodeAdmissionWindow = (maxAdmissionWindowMillis: number): Effect.Effect<number, ExternalIdentityFailure> =>
  Schema.decodeEffect(Schema.Finite.check(Schema.isGreaterThan(0)))(maxAdmissionWindowMillis).pipe(
    Effect.mapError((cause) => invalidWithCause('The admission deadline bound is malformed', cause)),
  );

export type ExternalSubjectAdmissionRequest = ExternalSubjectAdmissionMatch;

export interface AuthenticationAdmissionRequest extends Omit<AuthenticationAdmissionMatch, 'bindingRevision'> {
  readonly subjectType: ExternalAuthenticationSubject['subjectType'];
}

/** Pure deployment configuration; registry, observation and clock are Context services. */
export interface TrustedAdmissionServiceConfiguration {
  readonly attesterPrincipalId: string;
  readonly maxAdmissionWindowMillis: number;
}

const decodeAttesterPrincipalId = (
  attesterPrincipalId: string,
): Effect.Effect<Schema.Schema.Type<typeof PrincipalIdSchema>, ExternalIdentityFailure> =>
  Schema.decodeEffect(PrincipalIdSchema)(attesterPrincipalId).pipe(
    Effect.mapError((cause) => invalidWithCause('The trusted attester principal is malformed', cause)),
  );

type RegistryLookup = AuthenticationNamespaceRegistryService['lookup'];

const lookupRegistration = (
  lookup: RegistryLookup,
  namespaceId: AuthenticationNamespaceId,
): Effect.Effect<AuthenticationNamespaceRegistration, ExternalIdentityFailure> =>
  lookup(namespaceId).pipe(
    Effect.flatMap((registration) =>
      Effect.fromOption(registration, () => invalid('The authentication namespace is not registered')),
    ),
  );

const validateTrustedRequest = (
  registration: AuthenticationNamespaceRegistration,
  attesterPrincipalId: Schema.Schema.Type<typeof PrincipalIdSchema>,
  expectedNamespaceId: AuthenticationNamespaceId,
  expectedAudience: string,
  expectedSubjectType: ExternalAuthenticationSubject['subjectType'],
): Effect.Effect<void, ExternalIdentityFailure> => {
  if (registration.authenticationNamespaceId !== expectedNamespaceId) {
    return Effect.fail(invalid('The registered authentication namespace does not match the request'));
  }
  if (!registration.trustedAttesterPrincipalIds.includes(attesterPrincipalId)) {
    return Effect.fail(invalid('The attester is not trusted for the authentication namespace'));
  }
  if (!registration.allowedAudiences.includes(expectedAudience)) {
    return Effect.fail(invalid('The audience is not trusted for the authentication namespace'));
  }
  if (!registration.subjectTypes.includes(expectedSubjectType)) {
    return Effect.fail(invalid('The subject type is not trusted for the authentication namespace'));
  }
  return Effect.void;
};

const decodeObservation = <Observation>(
  schema: Schema.ConstraintDecoder<Observation>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Provider wire observations are decoded at this boundary.
  value: unknown,
): Effect.Effect<Observation, ExternalIdentityFailure> =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(value).pipe(
    Effect.mapError((cause) => invalidWithCause('The authentication admission observation is malformed', cause)),
  );

export const makeTrustedExternalSubjectAdmissionService = (
  options: TrustedAdmissionServiceConfiguration,
): TrustedExternalSubjectAdmissionServiceContract => {
  const admit = Effect.fn('TrustedExternalSubjectAdmissionService.admit')(function* admitSubject(
    input: ExternalSubjectAdmissionRequest,
  ) {
    const attesterPrincipalId = yield* decodeAttesterPrincipalId(options.attesterPrincipalId);
    const request = yield* Schema.decodeEffect(ExternalAuthenticationSubjectSchema)({
      authenticationNamespaceId: input.authenticationNamespaceId,
      providerSubjectId: input.providerSubjectId,
      subjectType: input.subjectType,
    }).pipe(Effect.mapError((cause) => invalidWithCause('The external subject is malformed', cause)));
    const registryOption = yield* Effect.serviceOption(AuthenticationNamespaceRegistry);
    if (Option.isNone(registryOption)) {
      return yield* unavailable('The authentication namespace registry is not configured');
    }
    const registration = yield* lookupRegistration(registryOption.value.lookup, request.authenticationNamespaceId);
    yield* validateTrustedRequest(
      registration,
      attesterPrincipalId,
      request.authenticationNamespaceId,
      input.audience,
      request.subjectType,
    );
    const maxAdmissionWindowMillis = yield* decodeAdmissionWindow(options.maxAdmissionWindowMillis);
    // The owner observation must be obtained before receiver-time freshness validation.
    const observationServiceOption = yield* Effect.serviceOption(TrustedAdmissionObservation);
    if (Option.isNone(observationServiceOption)) {
      return yield* unavailable('The trusted admission observation service is not configured');
    }
    const observation = yield* observationServiceOption.value.observeExternalSubject(input);
    const decoded = yield* decodeObservation(ExternalSubjectAdmissionObservationSchema, observation);
    const receiverClock = yield* Clock.Clock;
    const clock: AdmissionClock = () => receiverClock.currentTimeMillis.pipe(Effect.map(DateTime.makeUnsafe));
    const now = yield* clock();
    yield* validateFreshness(decoded, now, maxAdmissionWindowMillis);
    if (!matchesSubject(decoded, input)) {
      return yield* invalid('The pre-binding subject observation does not match the request');
    }
    return makeTrustedExternalSubjectAdmission(decoded, { clock, maxAdmissionWindowMillis });
  });
  return { admit };
};

export const makeTrustedAuthenticationAdmissionService = (
  options: TrustedAdmissionServiceConfiguration,
): TrustedAuthenticationAdmissionServiceContract => {
  const verify = Effect.fn('TrustedAuthenticationAdmissionService.verify')(function* verifyAuthentication(
    input: AuthenticationAdmissionRequest,
  ) {
    const attesterPrincipalId = yield* decodeAttesterPrincipalId(options.attesterPrincipalId);
    // Preserve malformed attester diagnostics before looking up the requested namespace.
    const registryOption = yield* Effect.serviceOption(AuthenticationNamespaceRegistry);
    if (Option.isNone(registryOption)) {
      return yield* unavailable('The authentication namespace registry is not configured');
    }
    const registration = yield* lookupRegistration(registryOption.value.lookup, input.authenticationNamespaceId);
    yield* validateTrustedRequest(
      registration,
      attesterPrincipalId,
      input.authenticationNamespaceId,
      input.audience,
      input.subjectType,
    );
    const maxAdmissionWindowMillis = yield* decodeAdmissionWindow(options.maxAdmissionWindowMillis);
    const observationServiceOption = yield* Effect.serviceOption(TrustedAdmissionObservation);
    if (Option.isNone(observationServiceOption)) {
      return yield* unavailable('The trusted admission observation service is not configured');
    }
    const observation = yield* observationServiceOption.value.observeAuthentication(input);
    const decoded = yield* decodeObservation(AuthenticationAdmissionObservationSchema, observation);
    // Re-read the receiver clock after owner observation so delayed provider work cannot extend the proof.
    const receiverClock = yield* Clock.Clock;
    const clock: AdmissionClock = () => receiverClock.currentTimeMillis.pipe(Effect.map(DateTime.makeUnsafe));
    const now = yield* clock();
    yield* validateFreshness(decoded, now, maxAdmissionWindowMillis);
    if (
      !matchesAuthentication(decoded, {
        ...input,
        bindingRevision: decoded.bindingRevision,
      })
    ) {
      return yield* invalid('The authentication observation does not match the request');
    }
    return makeTrustedAuthenticationAdmission(decoded, { clock, maxAdmissionWindowMillis });
  });
  return { verify };
};

// These predicates check private WeakMap membership, not a caller-visible wire shape.
// oxlint-disable-next-line anti-slop/no-unknown-parameters, effect-native/no-refinement-outside-schema -- Capability membership is intentionally outside wire schemas.
export const isVerifiedAuthenticationAdmission = (value: unknown): value is VerifiedAuthenticationAdmission =>
  isTrustedAuthenticationAdmission(value);

// oxlint-disable-next-line anti-slop/no-unknown-parameters, effect-native/no-refinement-outside-schema -- Capability membership is intentionally outside wire schemas.
export const isVerifiedExternalSubjectAdmission = (value: unknown): value is VerifiedExternalSubjectAdmission =>
  isTrustedSubjectAdmission(value);
