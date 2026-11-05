import type { OperationalScope } from '@app/core-runtime';
import { HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import type { AccessDecision } from '@app/core-runtime/access/decision/contract';
import type { TestGateAnswer } from '@app/core-runtime/access/enforcement';
import { makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  GrantIncarnationIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
} from '@app/core-runtime/access/ids';
import type { RoleId } from '@app/core-runtime/access/ids';
import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  AccessExplainBffService,
  AccessExplainDirectoryAnswers,
  AccessExplainPublishedCapability,
  AccessExplainReleaseReader,
  AccessExplainRoleLabelReader,
} from '../../api/access-admin/explain.ts';
import {
  accessExplainCatalogUnavailable,
  accessExplainDeclarations,
  makeAccessExplainBff,
  noStoreExplain,
  publishedDeclaration,
  releaseReader,
  selectableCompaniesOf,
} from '../../api/access-admin/explain.ts';
import type { AccessAdminSessionService } from '../../api/access-admin/session.ts';
import type { ExplainAccessPayload } from '../../shared/access-admin-api.ts';
import {
  AccessAdminForbiddenProblemSchema,
  AccessAdminUnprocessableProblemSchema,
  AccessAdminUnavailableProblemSchema,
  AccessCapabilityKeySchema,
  AccessCompanyIdSchema,
  AccessHumanIdSchema,
  AccessModuleKeySchema,
  AccessRecordKeySchema,
} from '../../shared/access-admin-api.ts';
import { shellTestScope } from '../support/access-decision-double.ts';

/*
 * What "Proč?" must never do, in one suite: disagree with the gate, name people it may not name, answer a
 * 503 as a denial (or the reverse), reveal that a record or a person exists, or let the browser supply
 * authority. The gate is the scripted double, so every assertion is about this BFF's own conduct.
 */

const TENANT = '10000000-0000-4000-8000-000000000001';
const COMPANY = '20000000-0000-4000-8000-000000000001';
const OTHER_COMPANY = AccessCompanyIdSchema.make('20000000-0000-4000-8000-000000000002');
const PERSON = '30000000-0000-4000-8000-000000000001';
const MEMBER = AccessHumanIdSchema.make('30000000-0000-4000-8000-000000000002');
const STRANGER = AccessHumanIdSchema.make('30000000-0000-4000-8000-000000000003');
const NOBODY = AccessHumanIdSchema.make('30000000-0000-4000-8000-0000000000a1');
const ASSIGNER = '30000000-0000-4000-8000-0000000000ff';
const ROLE = RoleIdSchema.make('40000000-0000-4000-8000-000000000001');
const ROLE_NAME = 'Finanční správce';
const GRANT_INCARNATION = '70000000-0000-4000-8000-000000000001';
const PAY_KEY = 'core.finance.invoice.pay';
const PRICES_KEY = 'core.pricing.price.purchase-costs-read';
const UPDATE_KEY = 'core.finance.invoice.update';
const SURFACE_KEY = accessExplainDeclarations.read.key;
const AUTHORITY_KEY = accessExplainDeclarations.readAuthority.key;
const SUBJECT_KEY = accessExplainDeclarations.readSubject.key;

const scope = shellTestScope({ principalId: PERSON, tenantId: TENANT });
const tenantSession: AccessAdminSessionService = { requireTenantContext: () => Effect.succeed(scope) };

type Evidence = NonNullable<TestGateAnswer['evidence']>[number];

/** One authority witness, as the engine returns it: the explained person's own grant. */
const evidenceOf = (input: { readonly deadline?: Date; readonly mode?: 'propose' | 'run' } = {}): Evidence => {
  const mode = input.mode ?? 'run';
  const base: Evidence = {
    assignedAt: new Date('2026-11-01T09:00:00.000Z'),
    assignedBy: PrincipalIdSchema.make(ASSIGNER),
    mode,
    roleId: ROLE,
    roleRevisionId: RoleRevisionIdSchema.make('50000000-0000-4000-8000-000000000001'),
    selector: 'all',
    side: 'principal',
    witness: {
      assignmentIncarnationId: AssignmentIncarnationIdSchema.make('60000000-0000-4000-8000-000000000001'),
      capabilityKey: CapabilityKeySchema.make(PAY_KEY),
      grantIncarnationId: GrantIncarnationIdSchema.make(GRANT_INCARNATION),
      holderId: { _tag: 'Principal', principalId: PrincipalIdSchema.make(PERSON) },
      mode,
      purpose: 'requester',
      scopeId: AccessScopeIdSchema.make('80000000-0000-4000-8000-000000000001'),
    },
  };
  return input.deadline === undefined ? base : { ...base, deadline: input.deadline };
};

/** The declaration projection the release publishes for one capability (O1). */
const capability = (
  key: string,
  overrides: {
    readonly ephemeral?: true;
    readonly fieldClass?: string;
    readonly kind?: 'action' | 'admin' | 'export' | 'field_read' | 'read';
    readonly modes?: readonly ('approve' | 'propose' | 'run')[];
    readonly parentKey?: string;
    readonly risk?: 'critical' | 'routine' | 'sensitive';
    readonly selectors?: readonly ('all' | 'assigned' | 'entrusted' | 'team')[];
  } = {},
): AccessExplainPublishedCapability => {
  const base: AccessExplainPublishedCapability['declaration'] = {
    key,
    kind: overrides.kind ?? 'action',
    modes: overrides.modes ?? ['propose', 'run'],
    placement: { group: 'finance', level: 'extended' },
    risk: overrides.risk ?? 'sensitive',
    selectors: overrides.selectors ?? [],
  };
  // The module that owns the key, exactly as the release states it (O27): a projection whose key does
  // not belong to its module is refused by Core's own owner rules. The Shell app's own module key carries
  // a hyphen, not a dot, so it is named rather than sliced out of the key.
  const moduleKey = key.startsWith('shell-super-app.') ? 'shell-super-app' : key.split('.').slice(0, 2).join('.');
  const stated = overrides.ephemeral === undefined ? base : { ...base, ephemeral: overrides.ephemeral };
  const publishedEntry = {
    declaration: overrides.fieldClass === undefined ? stated : { ...stated, fieldClass: overrides.fieldClass },
    moduleKey,
  };
  // Only a field group names a parent (O87); every other kind carries none.
  return overrides.parentKey === undefined ? publishedEntry : { ...publishedEntry, parentKey: overrides.parentKey };
};

/** The entries a release published, in the only form the surface decides: no tenant, no scope. */
const published = (entries: readonly AccessExplainPublishedCapability[]) => entries;

type CatalogFake = readonly AccessExplainPublishedCapability[] | 'unreadable';

const catalogOf = (result: CatalogFake) => {
  const labelReads: OperationalScope[] = [];
  const counts = { releaseReads: 0 };
  const readRelease: AccessExplainReleaseReader = () => {
    counts.releaseReads += 1;
    return result === 'unreadable'
      ? Effect.fail(accessExplainCatalogUnavailable('the release store did not answer'))
      : Effect.succeed(result);
  };
  const readRoleLabels: AccessExplainRoleLabelReader = (asked) => {
    labelReads.push(asked);
    return Effect.succeed(new Map<RoleId, string>([[ROLE, ROLE_NAME]]));
  };
  return { labelReads, readRelease, readRoleLabels, releaseReads: counts };
};

const directoryOf = (input: {
  readonly members?: readonly string[] | 'unavailable';
  readonly people?: readonly { readonly displayName: string; readonly principalId: string }[] | 'unavailable';
}) => {
  const asks: { readonly capabilityKey: string; readonly mode: 'propose' | 'run' }[] = [];
  const memberAsks: string[] = [];
  const answers: AccessExplainDirectoryAnswers = {
    grantableBy: (ask) => {
      asks.push({ capabilityKey: ask.capabilityKey, mode: ask.mode });
      return input.people === undefined || input.people === 'unavailable'
        ? Effect.fail({ _tag: 'AccessExplainDirectoryUnavailable' as const, reason: 'no role directory' })
        : Effect.succeed(input.people);
    },
    isTenantMember: ({ principalId }) => {
      memberAsks.push(principalId);
      return input.members === 'unavailable'
        ? Effect.fail({ _tag: 'AccessExplainDirectoryUnavailable' as const, reason: 'memberships unreadable' })
        : Effect.succeed((input.members ?? []).includes(principalId));
    },
  };
  return { answers, asks, memberAsks };
};

/** One company question about a company-owned capability, which is what a business screen asks. */
const question = (overrides: Partial<ExplainAccessPayload> = {}): ExplainAccessPayload => ({
  capabilityKey: AccessCapabilityKeySchema.make(PAY_KEY),
  mode: 'run',
  scope: { kind: 'company', legalEntityId: AccessCompanyIdSchema.make(COMPANY) },
  ...overrides,
});

const tenantQuestion = (capabilityKey: string): ExplainAccessPayload => ({
  capabilityKey: AccessCapabilityKeySchema.make(capabilityKey),
  mode: 'run',
  scope: { kind: 'tenant' },
});

const gateFor = (answers: Record<string, TestGateAnswer>) =>
  makeTestAccessDecision({ answers, legalEntityIds: [LegalEntityIdSchema.make(COMPANY)] });

/** One fully composed surface with the gate, the release, the session and an optional directory. */
const bffOf = (input: {
  readonly answers: Record<string, TestGateAnswer>;
  readonly catalog: CatalogFake;
  readonly directory?: ReturnType<typeof directoryOf>;
  readonly gate?: ReturnType<typeof gateFor>;
}) => {
  const gate = input.gate ?? gateFor(input.answers);
  const catalog = catalogOf(input.catalog);
  const base = {
    decide: gate.decide,
    readRelease: catalog.readRelease,
    readRoleLabels: catalog.readRoleLabels,
    requireTenantContext: tenantSession.requireTenantContext,
    selectableLegalEntities: selectableCompaniesOf(gate),
  };
  const bff: AccessExplainBffService =
    input.directory === undefined
      ? makeAccessExplainBff(base)
      : makeAccessExplainBff({
          ...base,
          grantableBy: input.directory.answers.grantableBy,
          isTenantMember: input.directory.answers.isTenantMember,
        });
  return { bff, catalog, directory: input.directory, gate };
};

it.effect('refuses a person who may not ask "Proč?" with 403 and reads nobody', () =>
  Effect.gen(function* refusesTheSurface() {
    const { bff, catalog, gate } = bffOf({
      answers: { [SURFACE_KEY]: { outcome: 'DENIED' } },
      catalog: published([capability(PAY_KEY)]),
    });

    const failure = yield* Effect.flip(bff.explain(new Headers(), question()));

    expect(Schema.is(AccessAdminForbiddenProblemSchema)(failure)).toBe(true);
    expect(gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([SURFACE_KEY]);
    expect({ labels: catalog.labelReads, releases: catalog.releaseReads.releaseReads }).toEqual({
      labels: [],
      releases: 0,
    });
  }),
);

it.effect('answers a retryable 503 when the gate cannot decide the surface', () =>
  Effect.gen(function* surfaceUnavailable() {
    const { bff, catalog } = bffOf({
      answers: { [SURFACE_KEY]: { outcome: 'UNAVAILABLE' } },
      catalog: published([capability(PAY_KEY)]),
    });

    const failure = yield* Effect.flip(bff.explain(new Headers(), question()));

    expect(Schema.is(AccessAdminUnavailableProblemSchema)(failure)).toBe(true);
    expect({ labels: catalog.labelReads, releases: catalog.releaseReads.releaseReads }).toEqual({
      labels: [],
      releases: 0,
    });
  }),
);

it.effect('explains an allowed action with its role and deadline but without assigner identity', () =>
  Effect.gen(function* explainsAllowed() {
    const deadline = new Date('2027-01-31T23:59:59.000Z');
    const directory = directoryOf({ people: [{ displayName: 'Jana Nováková', principalId: PERSON }] });
    const { bff, catalog } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'ALLOWED' },
        [PAY_KEY]: { admissionDeadline: deadline, evidence: [evidenceOf({ deadline })], outcome: 'ALLOWED' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
      directory,
    });

    const response = yield* bff.explain(new Headers(), question());

    expect(response.outcome).toBe('ALLOWED');
    expect(response.reasonCodes).toEqual(['allow.granted']);
    expect(response.authorityMetadata).toBe('included');
    // The role name below is real only because an answer that may show authority read the tenant's labels,
    // once, for the asker's own scope.
    expect(catalog.labelReads.map((asked) => asked.principalId)).toEqual([PERSON]);
    expect(response.authority).toEqual([
      {
        capabilityKey: PAY_KEY,
        deadline: DateTime.fromDateUnsafe(deadline),
        mode: 'run',
        roleId: ROLE,
        roleName: ROLE_NAME,
        selector: 'all',
      },
    ]);
    // The witness, the assigner and the grant incarnation stay server-side: an explanation is not a
    // provenance dump, and none of them may reach a browser.
    const [firstAuthority] = response.authority;
    expect({
      assigned: Object.hasOwn(firstAuthority ?? {}, 'assignedAt'),
      assigner: Object.hasOwn(firstAuthority ?? {}, 'assignedBy'),
    }).toEqual({
      assigned: false,
      assigner: false,
    });
    expect(JSON.stringify(response)).not.toContain(GRANT_INCARNATION);
    expect(JSON.stringify(response)).not.toContain(ASSIGNER);
    expect(response.grantableBy).toEqual([{ displayName: 'Jana Nováková', principalId: PERSON }]);
    expect(directory.asks).toEqual([{ capabilityKey: PAY_KEY, mode: 'run' }]);
    expect(response.admissionDeadline).toEqual(DateTime.fromDateUnsafe(deadline));
  }),
);

it.effect('answers an unreadable authority-metadata decision as a retryable 503 that names no role', () =>
  Effect.gen(function* unavailableMetadataIsRetry() {
    const { bff, catalog } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'UNAVAILABLE' },
        [PAY_KEY]: { outcome: 'ALLOWED' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
      directory: directoryOf({ people: [{ displayName: 'Jana Nováková', principalId: PERSON }] }),
    });

    const refusal = yield* Effect.flip(bff.explain(new Headers(), question()));

    expect(refusal.status).toBe(503);
    expect(catalog.labelReads).toEqual([]);
  }),
);

it.effect('answers a denial as an explanation and never as a forbidden problem', () =>
  Effect.gen(function* explainsDenial() {
    const directory = directoryOf({ people: [{ displayName: 'Jana Nováková', principalId: PERSON }] });
    const { bff, catalog } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'DENIED' },
        [PAY_KEY]: { outcome: 'DENIED', reasons: ['deny.amount_exceeds_ceiling'] },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
      directory,
    });

    const response = yield* bff.explain(new Headers(), question({ amount: { currency: 'CZK', minor: 25_000_000 } }));

    expect(response).toMatchObject({
      authority: [],
      authorityMetadata: 'withheld',
      grantableBy: [],
      outcome: 'DENIED',
      reasonCodes: ['deny.amount_exceeds_ceiling'],
    });
    expect(directory.asks).toEqual([]);
    // A withheld answer shows nothing about authority, so the tenant's role names are never read for it:
    // the release is the only read this question needed.
    expect({ labels: catalog.labelReads, releases: catalog.releaseReads.releaseReads }).toEqual({
      labels: [],
      releases: 1,
    });
  }),
);

it.effect('keeps an unavailable engine a retryable 503 and never a denial', () =>
  Effect.gen(function* subjectUnavailable() {
    const { bff } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'ALLOWED' },
        [PAY_KEY]: { outcome: 'UNAVAILABLE' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
    });

    const failure = yield* Effect.flip(bff.explain(new Headers(), question()));

    expect(Schema.is(AccessAdminUnavailableProblemSchema)(failure)).toBe(true);
  }),
);

it.effect('keeps an unreadable release a retryable 503 and never an empty catalog', () =>
  Effect.gen(function* releaseUnreadable() {
    const { bff, gate } = bffOf({
      answers: { [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: 'unreadable',
    });

    const failure = yield* Effect.flip(bff.explain(new Headers(), question()));

    expect(Schema.is(AccessAdminUnavailableProblemSchema)(failure)).toBe(true);
    expect(gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([SURFACE_KEY]);
  }),
);

it.effect('answers an unpublished capability with deny.declaration_missing without asking the gate', () =>
  Effect.gen(function* unpublishedCapability() {
    const { bff, gate } = bffOf({
      answers: { [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: published([]),
    });

    const response = yield* bff.explain(new Headers(), question());

    expect(response).toEqual({
      authority: [],
      authorityMetadata: 'withheld',
      grantableBy: [],
      outcome: 'DENIED',
      reasonCodes: ['deny.declaration_missing'],
    });
    // Impossible to use as an existence oracle: the asked key never reaches the gate.
    expect(gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([SURFACE_KEY]);
  }),
);

it.effect('hands the released declaration and the asked facts to the gate, and nothing else', () =>
  Effect.gen(function* usesReleasedDeclaration() {
    const { bff, gate } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'DENIED' },
        [PAY_KEY]: { evidence: [evidenceOf({ mode: 'propose' })], outcome: 'NEEDS_APPROVAL' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
    });

    const response = yield* bff.explain(
      new Headers(),
      question({
        amount: { currency: 'CZK', minor: 1500 },
        mode: 'propose',
        target: {
          moduleKey: AccessModuleKeySchema.make('core.finance'),
          recordKey: AccessRecordKeySchema.make('invoice-42'),
        },
      }),
    );

    const [, subject] = gate.askedDecisions;
    expect(subject?.carrier.accessDeclaration).toMatchObject({
      key: PAY_KEY,
      kind: 'action',
      modes: ['propose', 'run'],
      risk: 'sensitive',
      selectors: [],
    });
    expect(subject?.amount).toEqual({ currency: 'CZK', minor: 1500 });
    // The seam decides `run` or `approve`; a proposal question is the same decision (O56, O63).
    expect(subject?.mode).toBeUndefined();
    expect(subject?.legalEntityScope).toBe('required');
    expect({ moduleKey: subject?.target?.moduleKey, recordKey: subject?.target?.recordKey }).toEqual({
      moduleKey: 'core.finance',
      recordKey: 'invoice-42',
    });
    // A field parent read is never accepted from a request: the gate is asked without one.
    expect(Object.hasOwn(subject ?? {}, 'parentRead')).toBe(false);
    expect(response.outcome).toBe('NEEDS_APPROVAL');
  }),
);

it.effect('asks a company-owned capability in the company context and its metadata in the tenant one', () =>
  Effect.gen(function* asksInCompanyContext() {
    const { bff, gate } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'ALLOWED' },
        [PAY_KEY]: { evidence: [evidenceOf()], outcome: 'ALLOWED' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
    });

    yield* bff.explain(new Headers(), question());

    const [surface, subject, authority] = gate.askedDecisions;
    expect({ legalEntityScope: surface?.legalEntityScope }).toEqual({ legalEntityScope: 'optional' });
    expect({ legalEntityId: subject?.scope.legalEntityId, legalEntityScope: subject?.legalEntityScope }).toEqual({
      legalEntityId: COMPANY,
      legalEntityScope: 'required',
    });
    // The metadata question is administration, so it stays in the tenant context (O28).
    expect({
      hasCompany: Object.hasOwn(authority?.scope ?? {}, 'legalEntityId'),
      legalEntityScope: authority?.legalEntityScope,
    }).toEqual({ hasCompany: false, legalEntityScope: 'optional' });
  }),
);

it.effect('refuses a company the person may not select without asking about the capability', () =>
  Effect.gen(function* refusesForeignCompany() {
    const { bff, gate } = bffOf({
      answers: { [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: published([capability(PAY_KEY)]),
    });

    const failure = yield* Effect.flip(
      bff.explain(new Headers(), question({ scope: { kind: 'company', legalEntityId: OTHER_COMPANY } })),
    );

    expect(Schema.is(AccessAdminForbiddenProblemSchema)(failure)).toBe(true);
    expect(gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([SURFACE_KEY]);
  }),
);

it.effect('answers an unreadable company list as a retryable 503', () =>
  Effect.gen(function* unreadableCompanies() {
    const { bff } = bffOf({
      answers: { [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: published([capability(PAY_KEY)]),
      gate: {
        ...gateFor({ [SURFACE_KEY]: { outcome: 'ALLOWED' } }),
        selectableLegalEntities: makeTestAccessDecision({ unavailable: true }).selectableLegalEntities,
      },
    });

    const failure = yield* Effect.flip(bff.explain(new Headers(), question()));

    expect(Schema.is(AccessAdminUnavailableProblemSchema)(failure)).toBe(true);
  }),
);

it.effect('refuses a question whose scope domain the release does not support', () =>
  Effect.gen(function* refusesScopeDomain() {
    const { bff, gate } = bffOf({
      answers: { [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: published([
        capability(PAY_KEY),
        capability(AUTHORITY_KEY, { kind: 'admin', modes: ['run'], risk: 'critical' }),
      ]),
    });

    const companyQuestionForCompanyCapability = yield* Effect.flip(bff.explain(new Headers(), tenantQuestion(PAY_KEY)));
    const adminCapabilityAsCompany = yield* Effect.flip(
      bff.explain(new Headers(), question({ capabilityKey: AccessCapabilityKeySchema.make(AUTHORITY_KEY) })),
    );

    expect(Schema.is(AccessAdminUnprocessableProblemSchema)(companyQuestionForCompanyCapability)).toBe(true);
    expect(Schema.is(AccessAdminUnprocessableProblemSchema)(adminCapabilityAsCompany)).toBe(true);
    expect(gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([
      SURFACE_KEY,
      SURFACE_KEY,
    ]);
  }),
);

const PARENT_KEY = 'core.pricing.price-group.read';

/** One field capability of the pricing module, with the parent the release names for it (O87). */
const fieldCapability = (parentKey?: string, selectors?: readonly ('all' | 'assigned' | 'entrusted' | 'team')[]) => {
  const base = { fieldClass: 'purchase_prices', kind: 'field_read' as const, modes: ['run'] as const };
  const withParent = parentKey === undefined ? base : { ...base, parentKey };
  return capability(PRICES_KEY, selectors === undefined ? withParent : { ...withParent, selectors });
};

const fieldQuestion = () =>
  question({
    capabilityKey: AccessCapabilityKeySchema.make(PRICES_KEY),
    target: {
      moduleKey: AccessModuleKeySchema.make('core.pricing'),
      recordKey: AccessRecordKeySchema.make('price-group-7'),
    },
  });

it.effect('rides the parent read the release names, with no record when the parent is scope-wide', () =>
  Effect.gen(function* ridesScopeWideParent() {
    const { bff, gate } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'DENIED' },
        [PRICES_KEY]: { evidence: [evidenceOf()], outcome: 'ALLOWED' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([fieldCapability(PARENT_KEY), capability(PARENT_KEY, { kind: 'read', modes: ['run'] })]),
    });

    const response = yield* bff.explain(new Headers(), fieldQuestion());

    const [, subject] = gate.askedDecisions;
    expect(subject?.parentRead?.capability.capabilityKey).toBe(PARENT_KEY);
    // A scope-wide parent capability names no record (O74): it is decided scope-wide in the same scope.
    expect(Object.hasOwn(subject?.parentRead ?? {}, 'target')).toBe(false);
    expect(response.outcome).toBe('ALLOWED');
    expect(response.fieldClass).toBe('purchase_prices');
  }),
);

it.effect('holds the parent read to the same hypothetical amount as the field it carries', () =>
  Effect.gen(function* parentCarriesAmount() {
    const { bff, gate } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'DENIED' },
        [PRICES_KEY]: { evidence: [evidenceOf()], outcome: 'ALLOWED' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([fieldCapability(PARENT_KEY), capability(PARENT_KEY, { kind: 'read', modes: ['run'] })]),
    });

    yield* bff.explain(new Headers(), { ...fieldQuestion(), amount: { currency: 'CZK', minor: 1500 } });

    const [, subject] = gate.askedDecisions;
    // An amount-capped parent is decided against the amount the asker named, as the Action runtime does.
    expect(subject?.parentRead?.amount).toEqual({ currency: 'CZK', minor: 1500 });
    expect(subject?.amount).toEqual({ currency: 'CZK', minor: 1500 });
  }),
);

it.effect('names the same record for a record-scoped parent and repeats its refusal', () =>
  Effect.gen(function* namesTheSameRecord() {
    const { bff, gate } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'DENIED' },
        [PRICES_KEY]: { outcome: 'DENIED', reasons: ['deny.parent_read_required'] },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([
        fieldCapability(PARENT_KEY, ['all']),
        capability(PARENT_KEY, { kind: 'read', modes: ['run'], selectors: ['all'] }),
      ]),
    });

    const response = yield* bff.explain(new Headers(), fieldQuestion());

    const [, subject] = gate.askedDecisions;
    expect({
      moduleKey: subject?.parentRead?.target?.moduleKey,
      recordKey: subject?.parentRead?.target?.recordKey,
    }).toEqual({ moduleKey: 'core.pricing', recordKey: 'price-group-7' });
    expect(response.outcome).toBe('DENIED');
    expect(response.reasonCodes).toEqual(['deny.parent_read_required']);
    // The field's own record question and the parent's answer never expose the record back to the caller.
    expect(JSON.stringify(response)).not.toContain('price-group-7');
  }),
);

it.effect('preserves the company-admin surface admission reason instead of returning 503', () =>
  Effect.gen(function* surfaceAdmissionReason() {
    const pageKey = 'shell-super-app.access-roles.view';
    const { bff, catalog } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'DENIED' },
        [pageKey]: { outcome: 'ALLOWED', reasons: ['structural.access_admin_any'] },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(pageKey, { kind: 'admin', modes: ['run'] })]),
    });

    const response = yield* bff.explain(new Headers(), tenantQuestion(pageKey));

    expect(response.outcome).toBe('ALLOWED');
    expect(response.reasonCodes).toEqual(['structural.access_admin_any']);
    expect(catalog.labelReads).toEqual([]);
  }),
);

it.effect('answers a structurally justified denial with its own reason instead of failing closed', () =>
  Effect.gen(function* structuralReason() {
    // The reason vocabulary is Core's, so a decision the engine justifies structurally (`structural.owner`)
    // is a reason an explanation can show — never the 503 the surface answers for a code it cannot render.
    const { bff } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'DENIED' },
        [PAY_KEY]: { outcome: 'DENIED', reasons: ['structural.owner', 'deny.insufficient_grant'] },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
    });

    const response = yield* bff.explain(new Headers(), question());

    expect(response.outcome).toBe('DENIED');
    // The gate's own order, and both codes survive the round trip unchanged.
    expect(response.reasonCodes).toEqual(['structural.owner', 'deny.insufficient_grant']);
  }),
);

it.effect('answers a field group whose parent the release does not contain as retryable unavailability', () =>
  Effect.gen(function* unprovableParent() {
    const missing = bffOf({
      answers: { [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: published([fieldCapability(PARENT_KEY)]),
    });
    const nameless = bffOf({
      answers: { [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: published([fieldCapability()]),
    });

    const absentParent = yield* Effect.flip(missing.bff.explain(new Headers(), fieldQuestion()));
    const withoutParent = yield* Effect.flip(nameless.bff.explain(new Headers(), fieldQuestion()));

    expect(Schema.is(AccessAdminUnavailableProblemSchema)(absentParent)).toBe(true);
    expect(Schema.is(AccessAdminUnavailableProblemSchema)(withoutParent)).toBe(true);
    // A broken catalog is never a denial, and the field question is never asked without its parent.
    expect(missing.gate.askedDecisions).toHaveLength(1);
    expect(nameless.gate.askedDecisions).toHaveLength(1);
  }),
);

it.effect('says unknown rather than nobody when this composition binds no directory', () =>
  Effect.gen(function* unknownWithoutDirectory() {
    const { bff } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'ALLOWED' },
        [PAY_KEY]: { evidence: [evidenceOf()], outcome: 'ALLOWED' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
    });

    const response = yield* bff.explain(new Headers(), question());

    expect(response.authorityMetadata).toBe('unavailable');
    // The explained person's own grants stay visible; only the people who could grant them are unknown.
    expect(response.authority).toHaveLength(1);
    expect(response.grantableBy).toEqual([]);
  }),
);

it.effect('says unknown when the directory cannot answer', () =>
  Effect.gen(function* unknownWhenDirectoryFails() {
    const directory = directoryOf({ people: 'unavailable' });
    const { bff } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'ALLOWED' },
        [PAY_KEY]: { outcome: 'DENIED' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
      directory,
    });

    const response = yield* bff.explain(new Headers(), question());

    expect(response).toMatchObject({ authorityMetadata: 'unavailable', grantableBy: [], outcome: 'DENIED' });
    expect(directory.asks).toHaveLength(1);
  }),
);

it.effect('decides the ephemeral proof the release states and never one this surface infers', () =>
  Effect.sync(() => {
    const ephemeral = publishedDeclaration(
      capability(PAY_KEY, { ephemeral: true, kind: 'action', modes: ['run'], risk: 'sensitive' }),
    );
    // `pay` is a dangerous verb, so it can never be routine: the routine case needs a safe verb.
    const routineRunOnly = publishedDeclaration(
      capability(UPDATE_KEY, { kind: 'action', modes: ['run'], risk: 'routine' }),
    );
    const proposable = publishedDeclaration(capability(PAY_KEY, { kind: 'action', modes: ['run', 'propose'] }));

    expect(ephemeral?.ephemeral).toBe(true);
    expect(routineRunOnly).toBeDefined();
    expect(routineRunOnly?.ephemeral).toBeUndefined();
    expect(proposable).toBeDefined();
    expect(proposable?.ephemeral).toBeUndefined();
    // The same projection without the stated proof is not a declaration at all: a run-only sensitive action
    // is only valid as an ephemeral one (O42), so a release that omits it is a broken catalog and this
    // surface refuses to repair it by guessing.
    expect(publishedDeclaration(capability(PAY_KEY, { kind: 'action', modes: ['run'], risk: 'sensitive' }))).toBe(
      undefined,
    );
  }),
);

it.effect('refuses a released projection that Core’s declaration schema would not accept', () =>
  Effect.sync(() => {
    // A plain `read` cannot carry a field class (O19, D14), so this projection is no declaration.
    const broken = publishedDeclaration(capability(PAY_KEY, { fieldClass: 'salaries', kind: 'read', modes: ['run'] }));
    // The key must belong to its own module (O27), so a foreign projection is no declaration either.
    const foreign = publishedDeclaration({ ...capability(PAY_KEY), moduleKey: 'core.pricing' });

    expect({ broken: broken === undefined, foreign: foreign === undefined }).toEqual({ broken: true, foreign: true });
  }),
);

it.effect('explains a member’s access for an administrator and asks the metadata question about the asker', () =>
  Effect.gen(function* explainsForMember() {
    const directory = directoryOf({ members: [PERSON, String(MEMBER)] });
    const { bff, gate } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'DENIED' },
        [PAY_KEY]: { outcome: 'DENIED', reasons: ['deny.insufficient_grant'] },
        [SUBJECT_KEY]: { outcome: 'ALLOWED' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
      directory,
    });

    const response = yield* bff.explain(new Headers(), question({ subjectPrincipalId: MEMBER }));

    expect(response.outcome).toBe('DENIED');
    expect(directory.memberAsks).toEqual([String(MEMBER)]);
    // The subject's question is asked as the subject, in the asker's tenant, and the metadata question
    // stays the asker's own: who may see authority does not change because they asked on someone's behalf.
    const [surface, subjectCapability, subjectInCompany, subjectQuestion, authorityQuestion] = gate.askedDecisions;
    expect({ key: surface?.carrier.accessDeclaration?.key, principal: surface?.scope.principalId }).toEqual({
      key: SURFACE_KEY,
      principal: PERSON,
    });
    expect(subjectCapability?.carrier.accessDeclaration?.key).toBe(SUBJECT_KEY);
    // Someone else's access in a company is that company's data, so the company admits the asker too (O88).
    expect(subjectInCompany).toMatchObject({
      carrier: { accessDeclaration: { key: SUBJECT_KEY } },
      legalEntityScope: 'required',
      scope: { legalEntityId: COMPANY, principalId: PERSON },
    });
    expect({
      key: subjectQuestion?.carrier.accessDeclaration?.key,
      principal: subjectQuestion?.scope.principalId,
      tenant: subjectQuestion?.scope.tenantId,
    }).toEqual({ key: PAY_KEY, principal: String(MEMBER), tenant: TENANT });
    expect({
      key: authorityQuestion?.carrier.accessDeclaration?.key,
      principal: authorityQuestion?.scope.principalId,
    }).toEqual({ key: AUTHORITY_KEY, principal: PERSON });
    // O86: the subject's row records who asked, and only that row does (the question about the asker's own
    // authority to see metadata is asked for the asker, never on their behalf).
    expect({
      authority: authorityQuestion?.onBehalfOfPrincipalId ?? null,
      subject: subjectQuestion?.onBehalfOfPrincipalId ?? null,
      surface: surface?.onBehalfOfPrincipalId ?? null,
    }).toEqual({ authority: null, subject: PERSON, surface: null });
  }),
);

it.effect('refuses another person’s access without the subject capability', () =>
  Effect.gen(function* refusesSubjectWithoutCapability() {
    const directory = directoryOf({ members: [PERSON, String(MEMBER)] });
    const { bff, catalog, gate } = bffOf({
      answers: { [SUBJECT_KEY]: { outcome: 'DENIED' }, [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: published([capability(PAY_KEY)]),
      directory,
    });

    const failure = yield* Effect.flip(bff.explain(new Headers(), question({ subjectPrincipalId: MEMBER })));

    expect(Schema.is(AccessAdminForbiddenProblemSchema)(failure)).toBe(true);
    expect({ labels: catalog.labelReads, releases: catalog.releaseReads.releaseReads }).toEqual({
      labels: [],
      releases: 0,
    });
    expect(directory.memberAsks).toEqual([]);
    expect(gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([
      SURFACE_KEY,
      SUBJECT_KEY,
    ]);
  }),
);

it.effect('answers a person of another tenant exactly like a person who does not exist', () =>
  Effect.gen(function* answersStrangersIdentically() {
    const directory = directoryOf({ members: [PERSON] });
    const { bff, catalog } = bffOf({
      answers: { [SUBJECT_KEY]: { outcome: 'ALLOWED' }, [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: published([capability(PAY_KEY)]),
      directory,
    });

    const stranger = yield* Effect.flip(bff.explain(new Headers(), question({ subjectPrincipalId: STRANGER })));
    const nobody = yield* Effect.flip(bff.explain(new Headers(), question({ subjectPrincipalId: NOBODY })));

    expect(stranger).toEqual(nobody);
    expect(Schema.is(AccessAdminForbiddenProblemSchema)(stranger)).toBe(true);
    // Nothing about the capability was read, so existence cannot be probed through the answer.
    expect({ labels: catalog.labelReads, releases: catalog.releaseReads.releaseReads }).toEqual({
      labels: [],
      releases: 0,
    });
  }),
);

it.effect('answers an unreadable membership list as a retryable 503', () =>
  Effect.gen(function* unreadableMemberships() {
    const { bff } = bffOf({
      answers: { [SUBJECT_KEY]: { outcome: 'ALLOWED' }, [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: published([capability(PAY_KEY)]),
      directory: directoryOf({ members: 'unavailable' }),
    });

    const failure = yield* Effect.flip(bff.explain(new Headers(), question({ subjectPrincipalId: MEMBER })));

    expect(Schema.is(AccessAdminUnavailableProblemSchema)(failure)).toBe(true);
  }),
);

it.effect('refuses a subject question this composition cannot prove', () =>
  Effect.gen(function* refusesUnprovableSubject() {
    const { bff, catalog } = bffOf({
      answers: { [SUBJECT_KEY]: { outcome: 'ALLOWED' }, [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      catalog: published([capability(PAY_KEY)]),
    });

    const failure = yield* Effect.flip(bff.explain(new Headers(), question({ subjectPrincipalId: MEMBER })));

    expect(Schema.is(AccessAdminUnavailableProblemSchema)(failure)).toBe(true);
    expect({ labels: catalog.labelReads, releases: catalog.releaseReads.releaseReads }).toEqual({
      labels: [],
      releases: 0,
    });
  }),
);

it.effect('treats the asker’s own id in the subject field as a question about themselves', () =>
  Effect.gen(function* explainsSelfThroughSubjectField() {
    const { bff, gate } = bffOf({
      answers: {
        [AUTHORITY_KEY]: { outcome: 'DENIED' },
        [PAY_KEY]: { evidence: [evidenceOf()], outcome: 'ALLOWED' },
        [SURFACE_KEY]: { outcome: 'ALLOWED' },
      },
      catalog: published([capability(PAY_KEY)]),
    });

    const response = yield* bff.explain(
      new Headers(),
      question({ subjectPrincipalId: AccessHumanIdSchema.make(PERSON) }),
    );

    expect(response.outcome).toBe('ALLOWED');
    // No second capability and no directory question: the person asking is the person explained.
    expect(gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([
      SURFACE_KEY,
      PAY_KEY,
      AUTHORITY_KEY,
    ]);
    // O86: nobody is recorded as asking on their own behalf.
    expect(gate.askedDecisions.map(({ onBehalfOfPrincipalId }) => onBehalfOfPrincipalId ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  }),
);

it.effect('answers a mode the release does not offer with the engine’s own code', () =>
  Effect.gen(function* refusesUnsupportedMode() {
    const { bff, gate } = bffOf({
      answers: { [SURFACE_KEY]: { outcome: 'ALLOWED' } },
      // A routine, run-only Action can never be proposed (`update` is not a dangerous verb, so the
      // release accepts it at routine risk).
      catalog: published([capability(UPDATE_KEY, { kind: 'action', modes: ['run'], risk: 'routine' })]),
    });

    const response = yield* bff.explain(
      new Headers(),
      question({ capabilityKey: AccessCapabilityKeySchema.make(UPDATE_KEY), mode: 'propose' }),
    );

    expect(response).toMatchObject({ outcome: 'DENIED', reasonCodes: ['deny.mode_unsupported'] });
    expect(gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([SURFACE_KEY]);
  }),
);

it('marks every explanation response as non-cacheable, whatever the answer is', () => {
  // An explanation names capabilities, scopes and people, so no proxy or browser may store it — the same
  // header `api/index.ts` sets for the other admin groups, pinned here so a refactor cannot drop it.
  expect(noStoreExplain(HttpServerResponse.empty()).headers['cache-control']).toBe('no-store');
});

it.effect('treats a release that was never published as unavailability, never as an empty catalog', () =>
  Effect.gen(function* unpublishedRelease() {
    // `None` and "a release with no entries" are different states: the first means this deployment has
    // nothing to explain from (retryable), the second is a catalog defect an entry would have to answer.
    const readRelease = releaseReader({ readRelease: () => Effect.succeed(Option.none()) });

    const failure = yield* readRelease().pipe(Effect.flip);

    expect(failure.reason).toBe('no release has been published, so no capability is in force');
  }),
);

/* ------------------------------------------------------------------------------------------------
 * Company authority: a tenant-context answer never explains a company the asker cannot administer (O88).
 * ---------------------------------------------------------------------------------------------- */

/**
 * The scripted gate, with the explain surface's own keys refused in the company's required scope: a
 * tenant-context manager allowed every "Proč?" key whose envelope does not reach the asked company.
 */
const companyRefusingGate = (answers: Record<string, TestGateAnswer>, inCompany: 'DENIED' | 'UNAVAILABLE') => {
  const inner = gateFor(answers);
  const surfaceKeys = new Set<string>([AUTHORITY_KEY, SUBJECT_KEY, SURFACE_KEY]);
  const refusal: AccessDecision = {
    evidence: [],
    outcome: inCompany,
    reasons: [{ code: inCompany === 'DENIED' ? 'deny.insufficient_grant' : 'unavailable.intent' }],
    selectors: [],
  };
  // The company is still asked through the double, so the suite sees every question in its scope.
  const decide: typeof inner.decide = (input) =>
    input.legalEntityScope === 'required' && surfaceKeys.has(input.carrier.accessDeclaration?.key ?? '')
      ? inner.decide(input).pipe(Effect.as(refusal))
      : inner.decide(input);
  return { ...inner, decide };
};

const MANAGER_ANSWERS = {
  [AUTHORITY_KEY]: { outcome: 'ALLOWED' },
  [PAY_KEY]: { evidence: [evidenceOf()], outcome: 'ALLOWED' },
  [SUBJECT_KEY]: { outcome: 'ALLOWED' },
  [SURFACE_KEY]: { outcome: 'ALLOWED' },
} satisfies Record<string, TestGateAnswer>;

it.effect('refuses someone else’s access in a company that refuses the asker, like a company they cannot select', () =>
  Effect.gen(function* refusesSubjectInOtherCompany() {
    const directory = directoryOf({ members: [PERSON, String(MEMBER)] });
    const { bff, catalog, gate } = bffOf({
      answers: MANAGER_ANSWERS,
      catalog: published([capability(PAY_KEY)]),
      directory,
      gate: companyRefusingGate(MANAGER_ANSWERS, 'DENIED'),
    });

    const refused = yield* Effect.flip(bff.explain(new Headers(), question({ subjectPrincipalId: MEMBER })));
    const unselectable = yield* Effect.flip(
      bff.explain(
        new Headers(),
        question({ scope: { kind: 'company', legalEntityId: OTHER_COMPANY }, subjectPrincipalId: MEMBER }),
      ),
    );

    expect({ detail: refused.detail, status: refused.status }).toEqual({
      detail: unselectable.detail,
      status: unselectable.status,
    });
    // The subject's own decision in that company was never asked, and no role of it was named.
    expect(gate.askedDecisions.some(({ carrier }) => carrier.accessDeclaration?.key === PAY_KEY)).toBe(false);
    expect(catalog.labelReads).toEqual([]);
  }),
);

it.effect('withholds a company question’s authority when only the tenant context admits the metadata', () =>
  Effect.gen(function* withholdsCompanyAuthority() {
    const directory = directoryOf({ people: [{ displayName: 'Jana Nováková', principalId: PERSON }] });
    const { bff, catalog } = bffOf({
      answers: MANAGER_ANSWERS,
      catalog: published([capability(PAY_KEY)]),
      directory,
      gate: companyRefusingGate(MANAGER_ANSWERS, 'DENIED'),
    });

    const response = yield* bff.explain(new Headers(), question());

    expect(response).toMatchObject({
      authority: [],
      authorityMetadata: 'withheld',
      grantableBy: [],
      outcome: 'ALLOWED',
    });
    expect(JSON.stringify(response)).not.toContain(ROLE);
    expect(JSON.stringify(response)).not.toContain(ROLE_NAME);
    // Neither the company's role names nor the people who could grant are read for a withheld answer.
    expect({ grantable: directory.asks, labels: catalog.labelReads }).toEqual({ grantable: [], labels: [] });
  }),
);

it.effect('answers 503 when the company cannot say whether the asker may see its authority', () =>
  Effect.gen(function* companyAuthorityUnavailable() {
    const { bff } = bffOf({
      answers: MANAGER_ANSWERS,
      catalog: published([capability(PAY_KEY)]),
      gate: companyRefusingGate(MANAGER_ANSWERS, 'UNAVAILABLE'),
    });

    const failure = yield* Effect.flip(bff.explain(new Headers(), question()));

    expect(Schema.is(AccessAdminUnavailableProblemSchema)(failure)).toBe(true);
  }),
);
