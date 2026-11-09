import { getVerticalRuntimeActions, getVerticalRuntimeOutboxWorkers } from '@app/core-runtime';
import { Effect, Result } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  ModuleEntrypointAccess,
  ModuleEntrypointDescriptor,
} from '../../../../packages/core-runtime/src/modules/module-entrypoint.ts';
import {
  checkModuleEntrypoint,
  makeModuleStateSnapshot,
} from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import type { ModuleStateDecision } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { getVerticalRuntimeReads } from '../../../../packages/core-runtime/src/modules/runtime-registration.ts';
import { TENANT_MODULE_STATES } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import type { TenantModuleState } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import { currentPaymentRead } from '../../src/api/current-payment.read.ts';
import { paymentAuthorizationValidationRead } from '../../src/api/payment-authorization-validation.read.ts';
import { paymentHistoryRead } from '../../src/api/payment-history.read.ts';
import { paymentMethodApplicabilityRead } from '../../src/api/payment-method-applicability.read.ts';
import { paymentReconciliationDebtRead } from '../../src/api/payment-reconciliation-debt.read.ts';
import { paymentManifest } from '../../vertical.manifest.ts';
import { paymentRegistration } from '../../vertical.registration.ts';

/**
 * #1153 TECH-02 owner acceptance: every native Payment entrypoint registered with Core declares the
 * access class DESIGN §2 assigns it, and the existing Core Module State gate decides each class
 * exactly as the #1153 matrix states. The expectations below are written out literally from #1153;
 * they are not derived from the Core implementation they verify.
 */

type AccessClass = Exclude<ModuleEntrypointAccess, 'background'>;
interface ExpectedEntrypoint {
  readonly access: AccessClass;
  readonly accessKey: string;
  readonly entrypointKey: string;
  readonly role: 'action' | 'api';
}

const action = (slug: string, accessKey: string): ExpectedEntrypoint => ({
  access: 'write',
  accessKey,
  entrypointKey: `payment.core.${slug}`,
  role: 'action',
});
const read = (slug: string, accessKey: string, access: AccessClass = 'read'): ExpectedEntrypoint => ({
  access,
  accessKey,
  entrypointKey: `payment.core.api.${slug}`,
  role: 'api',
});

/** DESIGN §2 entrypoint inventory (A1–A11, R1–R5). */
const DESIGN_INVENTORY: readonly ExpectedEntrypoint[] = [
  action('configure-payment-method-enablement', 'payment.core.method-enablement.configure'),
  action('configure-payment-source-authority', 'payment.core.source-authority.configure'),
  action('create-payment', 'payment.core.payment.create'),
  action('start-payment-collection', 'payment.core.collection.start'),
  action('issue-payment-authorization', 'payment.core.authorization.issue'),
  action('request-payment-cancellation', 'payment.core.cancellation.request'),
  action('request-payment-refund', 'payment.core.refund.request'),
  action('accept-payment-observation', 'payment.core.observation.accept'),
  action('record-payment-local-evidence', 'payment.core.local-evidence.record'),
  action('request-payment-operation-recovery', 'payment.core.operation-recovery.request'),
  action('record-payment-reconciliation-decision', 'payment.core.reconciliation.decide'),
  read('payment-method-applicability', 'payment.core.applicability.read'),
  read('current-payment', 'payment.core.payment.read'),
  read('payment-authorization-validation', 'payment.core.authorization.validate'),
  read('payment-reconciliation-debt', 'payment.core.reconciliation.read'),
  read('payment-history', 'payment.core.history.read', 'historical_read'),
];

type MatrixState = TenantModuleState | 'missing';
type Decision = ModuleStateDecision;

/** The #1153 "TECH-02 — Entrypoint classification and lifecycle matrix", column by column. */
const ISSUE_1153_MATRIX = {
  active: { background: 'allow', historical_read: 'allow', read: 'allow', write: 'allow' },
  archived: { background: 'deny', historical_read: 'allow', read: 'deny', write: 'deny' },
  deprecated: { background: 'deny', historical_read: 'allow', read: 'allow', write: 'deny' },
  inactive: { background: 'deny', historical_read: 'allow', read: 'deny', write: 'deny' },
  missing: { background: 'deny', historical_read: 'deny', read: 'deny', write: 'deny' },
  quarantined: { background: 'deny', historical_read: 'deny', read: 'deny', write: 'deny' },
  read_only: { background: 'deny', historical_read: 'allow', read: 'allow', write: 'deny' },
  suspended: { background: 'deny', historical_read: 'allow', read: 'deny', write: 'deny' },
} as const satisfies Readonly<Record<MatrixState, Readonly<Record<ModuleEntrypointAccess, Decision>>>>;
const MATRIX_STATES: readonly MatrixState[] = [...TENANT_MODULE_STATES, 'missing'];

const registeredEntrypoints = (): readonly ModuleEntrypointDescriptor[] => [
  ...getVerticalRuntimeActions(paymentRegistration).map((registered) => registered.descriptor.entrypoint),
  ...getVerticalRuntimeReads(paymentRegistration).map((registered) => registered.descriptor.entrypoint),
];

/**
 * Core exposes only the safe read descriptor projection; the owner-declared read registrations carry
 * the access declaration and Selling Legal Entity scope. They are the very values the registration holds.
 */
const ownerReads = [
  currentPaymentRead,
  paymentAuthorizationValidationRead,
  paymentHistoryRead,
  paymentMethodApplicabilityRead,
  paymentReconciliationDebtRead,
] as const;

const registeredAccessKeys = (): ReadonlyMap<string, string | undefined> =>
  new Map([
    ...getVerticalRuntimeActions(paymentRegistration).map(
      (registered) =>
        [registered.descriptor.entrypoint.entrypointKey, registered.descriptor.accessDeclaration?.key] as const,
    ),
    ...ownerReads.map(
      (registered) =>
        [registered.descriptor.entrypoint.entrypointKey, registered.descriptor.accessDeclaration?.key] as const,
    ),
  ]);

/** The real Core gate for one Tenant: `missing` is a Tenant with no Payment module state row at all. */
const coreGateDecision = (state: MatrixState, entrypoint: ModuleEntrypointDescriptor) => {
  const entrypoints = registeredEntrypoints();
  const records = state === 'missing' ? [] : [{ moduleKey: 'payment.core', state }];
  return checkModuleEntrypoint(
    makeModuleStateSnapshot('11111111-1111-4111-8111-111111111111', entrypoints, records),
    entrypoint,
  ).pipe(
    Effect.result,
    Effect.map((result): Decision => (Result.isSuccess(result) ? 'allow' : 'deny')),
  );
};

const byKey = (entries: readonly { readonly entrypointKey: string }[]) =>
  new Set(entries.map((entry) => entry.entrypointKey));

describe('#1153 TECH-02 Payment entrypoint classification', () => {
  it('#1153 every registered payment.core entrypoint declares the DESIGN §2 role and access class', () => {
    const registered = registeredEntrypoints();
    expect(byKey(registered)).toEqual(byKey(DESIGN_INVENTORY));
    const accessKeys = registeredAccessKeys();
    for (const expected of DESIGN_INVENTORY) {
      const entrypoint = registered.find((candidate) => candidate.entrypointKey === expected.entrypointKey);
      expect({
        access: entrypoint?.access,
        accessKey: accessKeys.get(expected.entrypointKey),
        entrypointKey: entrypoint?.entrypointKey,
        moduleKey: entrypoint?.moduleKey,
        role: entrypoint?.role,
        scope: entrypoint?.scope,
      }).toEqual({ ...expected, moduleKey: 'payment.core', scope: 'tenant' });
    }
  });

  it('#1153 every Action is a governed write with required idempotency and a Selling Legal Entity scope', () => {
    for (const registered of getVerticalRuntimeActions(paymentRegistration)) {
      expect(registered.descriptor.entrypoint.access).toBe('write');
      expect(registered.descriptor.idempotency).toBe('required');
      expect(registered.descriptor.legalEntityScope).toBe('required');
      expect(registered.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    }
    expect(byKey(ownerReads.map((registered) => registered.descriptor.entrypoint))).toEqual(
      byKey(getVerticalRuntimeReads(paymentRegistration).map((registered) => registered.descriptor.entrypoint)),
    );
    for (const registered of ownerReads) {
      expect(registered.descriptor.legalEntityScope).toBe('required');
      expect(registered.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    }
  });

  it('#1153 Payment declares no background entrypoint: no worker, no background access, no consumed event', () => {
    expect(getVerticalRuntimeOutboxWorkers(paymentRegistration)).toEqual([]);
    expect(registeredEntrypoints().filter((entrypoint) => entrypoint.role === 'worker')).toEqual([]);
    expect(registeredEntrypoints().filter((entrypoint) => entrypoint.access === 'background')).toEqual([]);
    expect(paymentManifest.publicSurface.events).toEqual([]);
  });

  it('#1153 historical_read is declared only for the explicit immutable payment-history projection', () => {
    expect(
      registeredEntrypoints()
        .filter((entrypoint) => entrypoint.access === 'historical_read')
        .map((entrypoint) => entrypoint.entrypointKey),
    ).toEqual(['payment.core.api.payment-history']);
  });
});

describe('#1153 TECH-02 Module State matrix through the Core gate', () => {
  it.effect('#1153 every registered entrypoint gets exactly the #1153 decision for its class in every state', () =>
    Effect.gen(function* moduleStateMatrix() {
      const observed: [MatrixState, string, Decision][] = [];
      const expected: [MatrixState, string, Decision][] = [];
      for (const state of MATRIX_STATES) {
        for (const entrypoint of registeredEntrypoints()) {
          const declared = DESIGN_INVENTORY.find((entry) => entry.entrypointKey === entrypoint.entrypointKey);
          observed.push([state, entrypoint.entrypointKey, yield* coreGateDecision(state, entrypoint)]);
          expected.push([state, entrypoint.entrypointKey, ISSUE_1153_MATRIX[state][declared?.access ?? 'background']]);
        }
      }
      expect(observed).toEqual(expected);
      expect(observed).toHaveLength(MATRIX_STATES.length * DESIGN_INVENTORY.length);
    }),
  );

  it.effect(
    '#1153 suspended Payment denies callback acceptance, refund and recovery while payment-history is allowed',
    () =>
      Effect.gen(function* suspendedPayment() {
        const decisions = new Map<string, Decision>();
        for (const entrypoint of registeredEntrypoints()) {
          decisions.set(entrypoint.entrypointKey, yield* coreGateDecision('suspended', entrypoint));
        }
        expect({
          callback: decisions.get('payment.core.accept-payment-observation'),
          history: decisions.get('payment.core.api.payment-history'),
          localEvidence: decisions.get('payment.core.record-payment-local-evidence'),
          recovery: decisions.get('payment.core.request-payment-operation-recovery'),
          refund: decisions.get('payment.core.request-payment-refund'),
        }).toEqual({ callback: 'deny', history: 'allow', localEvidence: 'deny', recovery: 'deny', refund: 'deny' });
        // Every other Current read and every write stays denied; history is the only allowed surface.
        expect([...decisions].filter(([, decision]) => decision === 'allow').map(([key]) => key)).toEqual([
          'payment.core.api.payment-history',
        ]);
      }),
  );

  it.effect('#1153 quarantine and a missing module state permit no Payment-owned entrypoint at all', () =>
    Effect.gen(function* quarantinedPayment() {
      for (const state of ['quarantined', 'missing'] as const) {
        for (const entrypoint of registeredEntrypoints()) {
          expect([state, entrypoint.entrypointKey, yield* coreGateDecision(state, entrypoint)]).toEqual([
            state,
            entrypoint.entrypointKey,
            'deny',
          ]);
        }
      }
    }),
  );
});
