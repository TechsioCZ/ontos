import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  providerAccountBindingConflict,
  providerAccountBindingNotFound,
} from '../../shared/actions/configure-provider-account-binding.ts';
import type {
  ProviderAccountBindingConflictError,
  ProviderAccountBindingNotFoundError,
} from '../../shared/actions/configure-provider-account-binding.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import {
  GatewayCredentialRevisionViewSchema,
  GatewayCredentialSecretRefSchema,
  GatewayHttpsUrlSchema,
  GatewayMerchantIdentitySchema,
  GatewayProviderAccountBindingViewSchema,
} from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayCredentialRevisionView,
  GatewayCredentialSecretRef,
  GatewayHttpsUrl,
  GatewayMerchantIdentity,
  GatewayProviderAccountBindingView,
  GatewayProviderAccountRef,
} from '../../shared/domain/psp-configuration.ts';
import type { GatewayEnvironment } from '../../shared/domain/psp-vocabulary.ts';
import {
  pspCredentialRevisions,
  pspProviderAccountBindingRevisions,
  pspProviderAccountBindings,
} from '../database/schema.ts';

/**
 * Action-side persistence of Provider Account Bindings and their Credential Revisions (#1155), over the
 * Core-installed `ScopedTransactionExecutor`. Every change happens under the binding's row lock and appends
 * one immutable binding revision. The database is the backstop: identity columns are insert-once, one
 * Current binding per (Tenant, Selling Legal Entity, family, environment), and at commit every binding names
 * an ACTIVE credential revision of itself. A secret reference is read only for execution targets; it never
 * reaches a view, a result or an error.
 */

/** A binding as stored, without its credential material. */
export interface ProviderAccountBindingRecord {
  readonly configuredAt: DateTime.Utc;
  readonly currentCredentialRevision: number;
  readonly notificationUrl: GatewayHttpsUrl;
  readonly view: GatewayProviderAccountBindingView;
}

/** The binding with its current credential revision, for execution and notification capture only. */
export interface ProviderAccountBindingTargetRecord {
  readonly binding: ProviderAccountBindingRecord;
  readonly credential: GatewayCredentialRevisionView;
  readonly credentialSecretRef: GatewayCredentialSecretRef;
}

export interface CreateProviderAccountBindingInput {
  readonly environment: GatewayEnvironment;
  readonly merchantIdentity: GatewayMerchantIdentity;
  readonly notificationUrl: GatewayHttpsUrl;
  readonly provenance: PaymentExecutionProvenance;
  readonly reason: string;
  /** The Current binding to retire for new intents; required exactly when one exists. */
  readonly replaces: Option.Option<{
    readonly expectedRevision: number;
    readonly providerAccountRef: GatewayProviderAccountRef;
  }>;
  readonly secretRef: GatewayCredentialSecretRef;
}

export interface CreateProviderAccountBindingOutcome {
  readonly binding: ProviderAccountBindingRecord;
  readonly credential: GatewayCredentialRevisionView;
  readonly replaced: Option.Option<ProviderAccountBindingRecord>;
}

export interface RetireProviderAccountBindingInput {
  readonly expectedRevision: number;
  readonly provenance: PaymentExecutionProvenance;
  readonly providerAccountRef: GatewayProviderAccountRef;
  readonly reason: string;
}

export interface RetireProviderAccountBindingOutcome {
  readonly binding: ProviderAccountBindingRecord;
  readonly credential: GatewayCredentialRevisionView;
}

export interface RotateProviderCredentialInput {
  readonly expectedRevision: number;
  readonly provenance: PaymentExecutionProvenance;
  readonly providerAccountRef: GatewayProviderAccountRef;
  readonly reason: string;
  readonly secretRef: GatewayCredentialSecretRef;
}

export interface RotateProviderCredentialOutcome {
  readonly binding: ProviderAccountBindingRecord;
  readonly credential: GatewayCredentialRevisionView;
  readonly retired: GatewayCredentialRevisionView;
}

export type PspBindingPersistenceFailure =
  | PaymentUnavailable
  | ProviderAccountBindingConflictError
  | ProviderAccountBindingNotFoundError;

export interface PspBindingPersistence {
  readonly createBinding: (
    input: CreateProviderAccountBindingInput,
  ) => Effect.Effect<CreateProviderAccountBindingOutcome, PspBindingPersistenceFailure>;
  /**
   * The exact binding with this ref and environment in the transaction's scope (Current or retired), with its
   * current credential revision. None when it does not exist there; another environment never matches.
   */
  readonly readBindingTarget: (query: {
    readonly environment: GatewayEnvironment;
    readonly providerAccountRef: GatewayProviderAccountRef;
  }) => Effect.Effect<Option.Option<ProviderAccountBindingTargetRecord>, PaymentUnavailable>;
  readonly retireBinding: (
    input: RetireProviderAccountBindingInput,
  ) => Effect.Effect<RetireProviderAccountBindingOutcome, PspBindingPersistenceFailure>;
  readonly rotateCredential: (
    input: RotateProviderCredentialInput,
  ) => Effect.Effect<RotateProviderCredentialOutcome, PspBindingPersistenceFailure>;
}

type BindingRow = typeof pspProviderAccountBindings.$inferSelect;
type CredentialRow = typeof pspCredentialRevisions.$inferSelect;

const readFailure = (cause: unknown) => paymentUnavailable('Provider Account Binding could not be read', cause);
const writeFailure = (cause: unknown) => paymentUnavailable('Provider Account Binding could not be written', cause);
const storedFailure = (cause: unknown) =>
  paymentUnavailable('A stored Provider Account Binding does not match its contract', cause);

const decodeBindingView = Schema.decodeUnknownEffect(GatewayProviderAccountBindingViewSchema);
const decodeCredentialView = Schema.decodeUnknownEffect(GatewayCredentialRevisionViewSchema);
const decodeNotificationUrl = Schema.decodeUnknownEffect(GatewayHttpsUrlSchema);
const decodeSecretRef = Schema.decodeUnknownEffect(GatewayCredentialSecretRefSchema);
const encodeMerchantIdentity = Schema.encodeEffect(GatewayMerchantIdentitySchema);

const bindingRecordOf = Effect.fn('PspBindingPersistence.bindingRecordOf')(function* bindingRecordOf(row: BindingRow) {
  const [view, notificationUrl] = yield* Effect.all(
    [
      decodeBindingView({
        bindingId: row.bindingId,
        environment: row.environment,
        merchantIdentity: row.merchantIdentity,
        providerAccountRef: row.providerAccountRef,
        providerFamily: row.providerFamily,
        revision: row.revision,
        status: row.status,
      }),
      decodeNotificationUrl(row.notificationUrl),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError(storedFailure));
  return {
    configuredAt: DateTime.fromDateUnsafe(row.configuredAt),
    currentCredentialRevision: row.currentCredentialRevision,
    notificationUrl,
    view,
  } satisfies ProviderAccountBindingRecord;
});

const credentialViewOf = (row: CredentialRow) =>
  decodeCredentialView({ bindingId: row.bindingId, credentialRevision: row.revision, status: row.status }).pipe(
    Effect.mapError(storedFailure),
  );

/** The later of now and the previous configuration time: the database refuses a configuration moving back. */
const configurationTime = (previous: Option.Option<Date>) =>
  DateTime.now.pipe(
    Effect.map((now) => {
      const at = DateTime.toDateUtc(now);
      return Option.match(previous, {
        onNone: () => at,
        onSome: (before) => (before.getTime() > at.getTime() ? before : at),
      });
    }),
  );

const requireRevision = (row: BindingRow, expectedRevision: number) =>
  row.revision === expectedRevision
    ? Effect.void
    : Effect.fail(
        providerAccountBindingConflict(
          'gateway_binding_revision_conflict',
          `The binding is at revision ${row.revision}, not ${expectedRevision}`,
        ),
      );

/** Construction is private to a Core-owned transaction; handlers receive only these closed methods. */
export const pspBindingPersistenceForTransaction = (transaction: ScopedTransactionExecutor): PspBindingPersistence => {
  const ownerScope = Effect.suspend(() => {
    const { legalEntityId, tenantId } = transaction.scope;
    return legalEntityId === undefined
      ? Effect.fail(paymentUnavailable('A verified Selling Legal Entity scope is required'))
      : Effect.succeed({ legalEntityId, tenantId });
  });

  const lockByRef = Effect.fn('PspBindingPersistence.lockByRef')(function* lockByRef(
    providerAccountRef: GatewayProviderAccountRef,
  ) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .select()
      .from(pspProviderAccountBindings)
      .where(
        and(
          eq(pspProviderAccountBindings.tenantId, scope.tenantId),
          eq(pspProviderAccountBindings.legalEntityId, scope.legalEntityId),
          eq(pspProviderAccountBindings.providerAccountRef, providerAccountRef),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(readFailure));
    return (
      row ?? (yield* providerAccountBindingNotFound('No Provider Account Binding with this ref exists in this scope'))
    );
  });

  const lockCurrent = Effect.fn('PspBindingPersistence.lockCurrent')(function* lockCurrent(
    providerFamily: GatewayMerchantIdentity['_tag'],
    environment: GatewayEnvironment,
  ) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .select()
      .from(pspProviderAccountBindings)
      .where(
        and(
          eq(pspProviderAccountBindings.tenantId, scope.tenantId),
          eq(pspProviderAccountBindings.legalEntityId, scope.legalEntityId),
          eq(pspProviderAccountBindings.providerFamily, providerFamily),
          eq(pspProviderAccountBindings.environment, environment),
          eq(pspProviderAccountBindings.status, 'CURRENT'),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(readFailure));
    return Option.fromNullishOr(row);
  });

  const lockActiveCredential = Effect.fn('PspBindingPersistence.lockActiveCredential')(function* lockActiveCredential(
    binding: BindingRow,
  ) {
    const [row] = yield* transaction
      .select()
      .from(pspCredentialRevisions)
      .where(
        and(
          eq(pspCredentialRevisions.tenantId, binding.tenantId),
          eq(pspCredentialRevisions.legalEntityId, binding.legalEntityId),
          eq(pspCredentialRevisions.bindingId, binding.bindingId),
          eq(pspCredentialRevisions.revision, binding.currentCredentialRevision),
          eq(pspCredentialRevisions.status, 'ACTIVE'),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(readFailure));
    return row ?? (yield* paymentUnavailable('The binding has no ACTIVE credential revision for its current revision'));
  });

  const appendBindingRevision = Effect.fn('PspBindingPersistence.appendBindingRevision')(
    function* appendBindingRevision(row: BindingRow) {
      yield* transaction
        .insert(pspProviderAccountBindingRevisions)
        .values({
          actionInvocationId: row.actionInvocationId,
          actorPrincipalId: row.actorPrincipalId,
          bindingId: row.bindingId,
          compositionRevision: row.compositionRevision,
          currentCredentialRevision: row.currentCredentialRevision,
          legalEntityId: row.legalEntityId,
          notificationUrl: row.notificationUrl,
          reason: row.reason,
          recordedAt: row.configuredAt,
          revision: row.revision,
          status: row.status,
          tenantId: row.tenantId,
        })
        .pipe(Effect.mapError(writeFailure));
    },
  );

  /** Retires a locked Current binding for new intents; its identity and credential stay as they are. */
  const retireLocked = Effect.fn('PspBindingPersistence.retireLocked')(function* retireLocked(
    row: BindingRow,
    input: { readonly provenance: PaymentExecutionProvenance; readonly reason: string },
  ) {
    const configuredAt = yield* configurationTime(Option.some(row.configuredAt));
    const [updated] = yield* transaction
      .update(pspProviderAccountBindings)
      .set({
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        compositionRevision: input.provenance.compositionRevision,
        configuredAt,
        reason: input.reason,
        revision: row.revision + 1,
        status: 'RETIRED_FOR_NEW_INTENTS',
      })
      .where(
        and(
          eq(pspProviderAccountBindings.tenantId, row.tenantId),
          eq(pspProviderAccountBindings.legalEntityId, row.legalEntityId),
          eq(pspProviderAccountBindings.bindingId, row.bindingId),
          eq(pspProviderAccountBindings.revision, row.revision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (updated === undefined) {
      return yield* paymentUnavailable('The locked Provider Account Binding was not updated');
    }
    yield* appendBindingRevision(updated);
    return updated;
  });

  const insertCredential = Effect.fn('PspBindingPersistence.insertCredential')(function* insertCredential(
    binding: BindingRow,
    input: {
      readonly provenance: PaymentExecutionProvenance;
      readonly recordedAt: Date;
      readonly revision: number;
      readonly secretRef: GatewayCredentialSecretRef;
    },
  ) {
    const [row] = yield* transaction
      .insert(pspCredentialRevisions)
      .values({
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        bindingId: binding.bindingId,
        compositionRevision: input.provenance.compositionRevision,
        legalEntityId: binding.legalEntityId,
        recordedAt: input.recordedAt,
        revision: input.revision,
        secretRef: input.secretRef,
        status: 'ACTIVE',
        tenantId: binding.tenantId,
      })
      .returning()
      .pipe(Effect.mapError(writeFailure));
    return row ?? (yield* paymentUnavailable('The credential revision was not inserted'));
  });

  /**
   * Inserts the new Current binding with a fresh `pab_` ref and its credential revision 1. A concurrent Current
   * binding of the same family and environment makes the insert a no-op (partial unique key), reported as a
   * conflict; nothing is written then.
   */
  const insertBinding = Effect.fn('PspBindingPersistence.insertBinding')(function* insertBinding(
    input: CreateProviderAccountBindingInput,
  ) {
    const scope = yield* ownerScope;
    const [merchantIdentity, configuredAt] = yield* Effect.all(
      [
        encodeMerchantIdentity(input.merchantIdentity).pipe(Effect.mapError(writeFailure)),
        configurationTime(Option.none()),
      ],
      { concurrency: 1 },
    );
    const [row] = yield* transaction
      .insert(pspProviderAccountBindings)
      .values({
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        compositionRevision: input.provenance.compositionRevision,
        configuredAt,
        currentCredentialRevision: 1,
        environment: input.environment,
        legalEntityId: scope.legalEntityId,
        merchantIdentity,
        notificationUrl: input.notificationUrl,
        providerAccountRef: sql`'pab_' || replace(gen_random_uuid()::text, '-', '')`,
        providerFamily: input.merchantIdentity._tag,
        reason: input.reason,
        revision: 1,
        status: 'CURRENT',
        tenantId: scope.tenantId,
      })
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (row === undefined) {
      return yield* providerAccountBindingConflict(
        'gateway_binding_current_exists',
        'Another Current binding of this family and environment was configured concurrently',
      );
    }
    yield* appendBindingRevision(row);
    const credential = yield* insertCredential(row, {
      provenance: input.provenance,
      recordedAt: configuredAt,
      revision: 1,
      secretRef: input.secretRef,
    });
    return { credential, row };
  });

  const createBinding = Effect.fn('PspBindingPersistence.createBinding')(function* createBinding(
    input: CreateProviderAccountBindingInput,
  ) {
    const current = yield* lockCurrent(input.merchantIdentity._tag, input.environment);
    const replaced = yield* Option.match(current, {
      onNone: () =>
        Option.match(input.replaces, {
          onNone: () => Effect.succeedNone,
          onSome: () =>
            Effect.fail(
              providerAccountBindingConflict(
                'gateway_binding_replacement_mismatch',
                'The family and environment have no Current binding to replace',
              ),
            ),
        }),
      onSome: (row) =>
        Option.match(input.replaces, {
          onNone: () =>
            Effect.fail(
              providerAccountBindingConflict(
                'gateway_binding_current_exists',
                'The family and environment already have a Current binding; name it in replaces',
              ),
            ),
          onSome: (replaces) =>
            replaces.providerAccountRef === row.providerAccountRef
              ? requireRevision(row, replaces.expectedRevision).pipe(
                  Effect.andThen(retireLocked(row, input)),
                  Effect.map(Option.some),
                )
              : Effect.fail(
                  providerAccountBindingConflict(
                    'gateway_binding_replacement_mismatch',
                    'replaces does not name the Current binding of this family and environment',
                  ),
                ),
        }),
    });
    const created = yield* insertBinding(input);
    const [binding, credential, replacedRecord] = yield* Effect.all(
      [
        bindingRecordOf(created.row),
        credentialViewOf(created.credential),
        Effect.transposeOption(replaced.pipe(Option.map(bindingRecordOf))),
      ],
      { concurrency: 1 },
    );
    return { binding, credential, replaced: replacedRecord } satisfies CreateProviderAccountBindingOutcome;
  });

  const retireBinding = Effect.fn('PspBindingPersistence.retireBinding')(function* retireBinding(
    input: RetireProviderAccountBindingInput,
  ) {
    const row = yield* lockByRef(input.providerAccountRef);
    yield* requireRevision(row, input.expectedRevision);
    if (row.status !== 'CURRENT') {
      return yield* providerAccountBindingConflict(
        'gateway_binding_not_current',
        'The binding is already retired for new intents',
      );
    }
    const retired = yield* retireLocked(row, input);
    const credential = yield* lockActiveCredential(retired);
    const [binding, credentialView] = yield* Effect.all([bindingRecordOf(retired), credentialViewOf(credential)], {
      concurrency: 1,
    });
    return { binding, credential: credentialView } satisfies RetireProviderAccountBindingOutcome;
  });

  /**
   * Retires revision n and appends revision n+1 as ACTIVE, then moves the binding to it. Dispatches recorded
   * under revision n keep that number as audit; resolution always uses the binding's current ACTIVE revision.
   */
  const rotateCredential = Effect.fn('PspBindingPersistence.rotateCredential')(function* rotateCredential(
    input: RotateProviderCredentialInput,
  ) {
    const row = yield* lockByRef(input.providerAccountRef);
    yield* requireRevision(row, input.expectedRevision);
    const active = yield* lockActiveCredential(row);
    if (active.secretRef === input.secretRef) {
      return yield* providerAccountBindingConflict(
        'gateway_credential_unchanged',
        'The binding already uses this credential reference',
      );
    }
    const configuredAt = yield* configurationTime(Option.some(row.configuredAt));
    const [retiredCredential] = yield* transaction
      .update(pspCredentialRevisions)
      .set({
        retiredAt: configuredAt,
        retiredByActionInvocationId: input.provenance.actionInvocationId,
        status: 'RETIRED',
      })
      .where(
        and(
          eq(pspCredentialRevisions.tenantId, active.tenantId),
          eq(pspCredentialRevisions.legalEntityId, active.legalEntityId),
          eq(pspCredentialRevisions.credentialRevisionId, active.credentialRevisionId),
          eq(pspCredentialRevisions.status, 'ACTIVE'),
        ),
      )
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (retiredCredential === undefined) {
      return yield* paymentUnavailable('The locked credential revision was not retired');
    }
    const nextRevision = active.revision + 1;
    const credential = yield* insertCredential(row, {
      provenance: input.provenance,
      recordedAt: configuredAt,
      revision: nextRevision,
      secretRef: input.secretRef,
    });
    const [updated] = yield* transaction
      .update(pspProviderAccountBindings)
      .set({
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        compositionRevision: input.provenance.compositionRevision,
        configuredAt,
        currentCredentialRevision: nextRevision,
        reason: input.reason,
        revision: row.revision + 1,
      })
      .where(
        and(
          eq(pspProviderAccountBindings.tenantId, row.tenantId),
          eq(pspProviderAccountBindings.legalEntityId, row.legalEntityId),
          eq(pspProviderAccountBindings.bindingId, row.bindingId),
          eq(pspProviderAccountBindings.revision, row.revision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (updated === undefined) {
      return yield* paymentUnavailable('The locked Provider Account Binding was not updated');
    }
    yield* appendBindingRevision(updated);
    const [binding, credentialView, retiredView] = yield* Effect.all(
      [bindingRecordOf(updated), credentialViewOf(credential), credentialViewOf(retiredCredential)],
      { concurrency: 1 },
    );
    return {
      binding,
      credential: credentialView,
      retired: retiredView,
    } satisfies RotateProviderCredentialOutcome;
  });

  const readBindingTarget = Effect.fn('PspBindingPersistence.readBindingTarget')(function* readBindingTarget(query: {
    readonly environment: GatewayEnvironment;
    readonly providerAccountRef: GatewayProviderAccountRef;
  }) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .select({ binding: pspProviderAccountBindings, credential: pspCredentialRevisions })
      .from(pspProviderAccountBindings)
      .innerJoin(
        pspCredentialRevisions,
        and(
          eq(pspCredentialRevisions.tenantId, pspProviderAccountBindings.tenantId),
          eq(pspCredentialRevisions.legalEntityId, pspProviderAccountBindings.legalEntityId),
          eq(pspCredentialRevisions.bindingId, pspProviderAccountBindings.bindingId),
          eq(pspCredentialRevisions.revision, pspProviderAccountBindings.currentCredentialRevision),
        ),
      )
      .where(
        and(
          eq(pspProviderAccountBindings.tenantId, scope.tenantId),
          eq(pspProviderAccountBindings.legalEntityId, scope.legalEntityId),
          eq(pspProviderAccountBindings.providerAccountRef, query.providerAccountRef),
          eq(pspProviderAccountBindings.environment, query.environment),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    if (row === undefined) {
      return Option.none<ProviderAccountBindingTargetRecord>();
    }
    const [binding, credential, credentialSecretRef] = yield* Effect.all(
      [
        bindingRecordOf(row.binding),
        credentialViewOf(row.credential),
        decodeSecretRef(row.credential.secretRef).pipe(Effect.mapError(storedFailure)),
      ],
      { concurrency: 1 },
    );
    return Option.some({ binding, credential, credentialSecretRef } satisfies ProviderAccountBindingTargetRecord);
  });

  return Object.freeze({ createBinding, readBindingTarget, retireBinding, rotateCredential });
};
