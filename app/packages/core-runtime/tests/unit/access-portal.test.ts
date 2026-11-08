import { Cause, Effect, Exit, Match, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { ActionPostAttemptHook } from '../../src/actions/definition.ts';
import { ActionHandlerExecutionError } from '../../src/actions/errors.ts';
import {
  isVerifiedGatewayPrincipalContext,
  readVerifiedGatewayActor,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import {
  CapabilityKeySchema,
  CatalogDigestSchema,
  CatalogSnapshotIdSchema,
  ModuleKeySchema,
} from '../../src/access/ids.ts';
import type { CatalogSnapshotEntry, RecordSelector } from '../../src/access/model.ts';
import { accessPortalRefusal, compilePortalRole, portalRoleRelease } from '../../src/access/portal/portal-access.ts';
import { portalPrincipalInLegalEntity } from '../../src/access/portal/portal-principal.ts';
import {
  AccessPortalProjection,
  reconcileAccessPortalAfterAttempt,
} from '../../src/access/portal/portal-projection.ts';
import { decodeAccessPortalRole, defineAccessPortalRole } from '../../src/access/portal/portal-role.ts';
import type { OperationalScope } from '../../src/operations/context.ts';

/*
 * A portal role is the fixed role a module declares for the people its portal serves, and Core alone turns it
 * into access (`access/portal`). This suite holds the pure halves to their promises: a module declares only its
 * own capabilities, the role is pinned to the newest release that carries all of them and opens each one in run
 * mode only, a person admitted mid-request is named into the company without losing what verified it, and an
 * owner Action reconciles exactly when its attempt may have committed.
 */
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenant = uid(1);
const company = uid(2);
const otherCompany = uid(3);
const person = uid(4);
const REVISION = 'c'.repeat(64);

const role = defineAccessPortalRole({
  capabilities: ['shop.portal.profile.read', 'shop.portal.order.repeat'],
  key: 'shop.portal.customer',
  moduleKey: 'shop.portal',
  name: 'Zákazník',
});

const entry = (key: string, selectors: readonly RecordSelector[] = []): CatalogSnapshotEntry => ({
  key: CapabilityKeySchema.make(key),
  kind: 'action',
  modes: ['run', 'propose'],
  moduleKey: ModuleKeySchema.make('shop.portal'),
  placement: { group: 'portal', level: 'basic' },
  risk: 'sensitive',
  selectors: [...selectors],
});

/** One catalog row as Core reads it: an entry of one published release. */
const row = (release: number, publishedAt: string, value: CatalogSnapshotEntry) => ({
  catalogSnapshotId: CatalogSnapshotIdSchema.make(uid(100 + release)),
  digest: CatalogDigestSchema.make(String(release).repeat(64)),
  entryJson: value,
  publishedAt,
});

describe('portal role declarations', () => {
  it('admits a role of its own module and freezes it', () => {
    expect(role.capabilities).toEqual(['shop.portal.profile.read', 'shop.portal.order.repeat']);
    expect(Object.isFrozen(role)).toBe(true);
  });

  it('refuses another module’s capability, another module’s key, and an empty or repeated role', () => {
    for (const candidate of [
      { ...role, capabilities: ['billing.invoices.invoice.read'] },
      { ...role, key: 'billing.customer' },
      { ...role, capabilities: [] },
      { ...role, capabilities: ['shop.portal.profile.read', 'shop.portal.profile.read'] },
      { ...role, name: '' },
    ]) {
      expect(Result.isFailure(decodeAccessPortalRole(candidate))).toBe(true);
    }
  });
});

describe('portal role release and cells', () => {
  it('pins the newest release that carries every capability, never a newer one that lacks one', () => {
    const rows = [
      row(1, '2026-11-01T00:00:00Z', entry('shop.portal.profile.read')),
      row(1, '2026-11-01T00:00:00Z', entry('shop.portal.order.repeat')),
      row(2, '2026-11-03T00:00:00Z', entry('shop.portal.profile.read')),
      row(2, '2026-11-03T00:00:00Z', entry('shop.portal.order.repeat')),
      // The newest release dropped a capability of the role, so the role cannot be pinned to it.
      row(3, '2026-11-04T00:00:00Z', entry('shop.portal.profile.read')),
    ];
    const pinned = Result.getOrThrow(portalRoleRelease(role, rows));
    expect(pinned.id).toBe(uid(102));
    expect(pinned.entries.map(({ key }) => key).toSorted()).toEqual([...role.capabilities].toSorted());
  });

  it('refuses a role no published release carries whole', () => {
    const released = portalRoleRelease(role, [row(1, '2026-11-01T00:00:00Z', entry('shop.portal.profile.read'))]);
    expect(Result.isFailure(released) && released.failure.code).toBe('access_portal_role_unreleased');
  });

  it('opens every capability in run mode only, at the widest selector it declares', () => {
    const rows = [
      row(1, '2026-11-01T00:00:00Z', entry('shop.portal.profile.read', ['assigned', 'all'])),
      row(1, '2026-11-01T00:00:00Z', entry('shop.portal.order.repeat')),
    ];
    const cells = Result.getOrThrow(compilePortalRole(role, Result.getOrThrow(portalRoleRelease(role, rows))));
    expect(cells.map(({ capabilityKey, mode }) => `${capabilityKey}:${mode}`).toSorted()).toEqual([
      'shop.portal.order.repeat:run',
      'shop.portal.profile.read:run',
    ]);
    const profileRead = cells.find(({ capabilityKey }) => capabilityKey === 'shop.portal.profile.read');
    expect(
      profileRead === undefined
        ? undefined
        : Match.value(profileRead.selector).pipe(
            Match.tag('all', () => 'all'),
            Match.orElse(() => 'narrower'),
          ),
    ).toBe('all');
  });
});

describe('a portal principal named into a company', () => {
  const session = {
    authBindingId: uid(70),
    authContextRef: 'portal-session',
    authMethod: 'session' as const,
    principalId: person,
    tenantId: tenant,
  };
  const sessionOf = (legalEntityId?: string) =>
    Schema.decodeSync(TrustedPrincipalContextSchema)(
      legalEntityId === undefined ? session : { ...session, legalEntityId },
    );
  const actor = { appId: 'shop-portal', buildMarker: 'shop-portal@1', principalId: uid(71) };

  it('keeps the verified provenance of a tenant assertion it names into the company', () => {
    const verified = trustVerifiedGatewayPrincipalContext(sessionOf(), REVISION, undefined, actor);
    const named = Result.getOrThrow(portalPrincipalInLegalEntity(verified, company));
    expect(named.legalEntityId).toBe(company);
    expect(named.principalId).toBe(person);
    expect(isVerifiedGatewayPrincipalContext(named)).toBe(true);
    expect(readVerifiedGatewayActor(named)).toEqual(actor);
  });

  it('refuses a principal no gateway verified, and one that already acts in another company', () => {
    const unverified = portalPrincipalInLegalEntity(sessionOf(), company);
    expect(Result.isFailure(unverified) && unverified.failure.code).toBe('access_portal_scope_mismatch');
    const elsewhere = portalPrincipalInLegalEntity(
      trustVerifiedGatewayPrincipalContext(sessionOf(otherCompany), REVISION),
      company,
    );
    expect(Result.isFailure(elsewhere) && elsewhere.failure.code).toBe('access_portal_scope_mismatch');
  });
});

describe('the post-attempt reconcile of an owner Action', () => {
  const scope = {
    ...Schema.decodeSync(TrustedPrincipalContextSchema)({
      authBindingId: uid(70),
      authContextRef: 'portal-session',
      authMethod: 'session',
      principalId: person,
      tenantId: tenant,
    }),
    correlationId: 'access-portal',
  } satisfies OperationalScope;
  const hook: ActionPostAttemptHook<string, string, { readonly _tag: 'Rejected' }, AccessPortalProjection> =
    reconcileAccessPortalAfterAttempt();
  const settle = (
    outcome: Parameters<typeof hook>[0]['outcome'],
    project: (projected: OperationalScope) => Effect.Effect<void, ReturnType<typeof accessPortalRefusal>>,
  ) =>
    Effect.gen(function* settleAttempt() {
      const projected: OperationalScope[] = [];
      const exit = yield* hook({
        actionInvocationId: uid(80),
        compositionRevision: REVISION,
        outcome,
        payload: 'payload',
        scope,
      }).pipe(
        Effect.provideService(AccessPortalProjection, {
          project: (projectedScope) =>
            Effect.sync(() => projected.push(projectedScope)).pipe(Effect.andThen(project(projectedScope))),
        }),
        Effect.exit,
      );
      return { exit, projected };
    });

  it.effect('reconciles the request tenant whenever the attempt may have committed', () =>
    Effect.gen(function* reconcilesCommitted() {
      for (const outcome of [
        { _tag: 'Committed' as const, result: 'done' },
        { _tag: 'AlreadyCommitted' as const },
        { _tag: 'Indeterminate' as const },
      ]) {
        const { exit, projected } = yield* settle(outcome, () => Effect.void);
        expect(exit).toStrictEqual(Exit.succeed({ _tag: 'Settled' }));
        expect(projected).toEqual([scope]);
      }
    }),
  );

  it.effect('leaves the engine alone when nothing committed', () =>
    Effect.gen(function* settlesUncommitted() {
      for (const outcome of [
        { _tag: 'DefinitelyUncommitted' as const },
        { _tag: 'CommittedRejection' as const, rejection: { _tag: 'Rejected' as const } },
        { _tag: 'Interrupted' as const },
      ]) {
        const { exit, projected } = yield* settle(outcome, () => Effect.void);
        expect(exit).toStrictEqual(Exit.succeed({ _tag: 'Settled' }));
        expect(projected).toEqual([]);
      }
    }),
  );

  it.effect('fails the settlement when the committed access cannot be projected, so the caller retries', () =>
    Effect.gen(function* failsUnprojected() {
      const { exit } = yield* settle({ _tag: 'Committed', result: 'done' }, () =>
        Effect.fail(accessPortalRefusal('access_portal_unavailable', 'engine down')),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(Schema.is(ActionHandlerExecutionError)(failure)).toBe(true);
    }),
  );
});
