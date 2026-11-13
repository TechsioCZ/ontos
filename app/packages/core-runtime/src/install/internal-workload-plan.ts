import { stableUuid } from '../access/catalog/stable-id.ts';
import { internalWorkloadPrincipalId } from '../auth/module-credentials.ts';

/*
 * What the platform's internal workload registration should do in ONE tenant, decided from what that tenant holds
 * now. Pure: the release step reads the tenant, asks this plan, and performs exactly what it returns.
 *
 * A module's own declared internal workload is registered once per (tenant, workload, company): one service
 * principal, one workload binding, one company binding. One active workload binding acts for one company (D6), so a
 * tenant with three companies holds three registrations of a workload, each with its own key.
 */

/** A module's internal workload that the reviewed catalogue declares, and the module key that installs it. */
export interface InternalWorkloadDeclaration {
  readonly appId: string;
  /** What a person reads for the workload, before the company: e.g. `CRM · zakládání klientů`. */
  readonly label: string;
  /** The module whose active state in a tenant makes the workload wanted there. */
  readonly moduleKey: string;
  readonly workloadKey: string;
}

/** One registration the platform made, as the tenant holds it now (active or retired). */
export interface PlatformRegistration {
  /** The active company binding, if any. */
  readonly activeCompanyBindingId: string | null;
  /** The active workload binding, if any. */
  readonly activeWorkloadBindingId: string | null;
  /** How many company bindings were ever written for the active workload binding (active or revoked). */
  readonly companyBindingCount: number;
  /** The principal's display name now; empty for a registration not made yet. */
  readonly displayName: string;
  /**
   * Active company bindings on the active workload binding for any company but this registration's own: one binding
   * acts for one company (D6), so each is revoked.
   */
  readonly extraCompanyBindingIds: readonly string[];
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly principalStatus: 'active' | 'archived' | 'disabled' | 'missing';
  /** How many workload bindings were ever written for this principal and workload (active or revoked). */
  readonly workloadBindingCount: number;
  readonly workloadKey: string;
}

export interface TenantWorkloadState {
  readonly activeCompanies: ReadonlySet<string>;
  readonly activeModuleKeys: ReadonlySet<string>;
  /** Each company's legal name, by its id. */
  readonly companyNames: ReadonlyMap<string, string>;
  /** Every registration the platform made in this tenant: the wanted ones and any it made before. */
  readonly registrations: readonly PlatformRegistration[];
  readonly tenantId: string;
}

export type InternalWorkloadStep =
  | {
      readonly displayName: string;
      readonly kind: 'create-principal';
      readonly legalEntityId: string;
      readonly principalId: string;
      readonly workloadKey: string;
    }
  | { readonly kind: 'reactivate-principal'; readonly principalId: string }
  | { readonly displayName: string; readonly kind: 'rename-principal'; readonly principalId: string }
  | {
      readonly bindingId: string;
      readonly incarnation: string;
      readonly kind: 'bind-workload';
      readonly principalId: string;
      readonly workloadKey: string;
    }
  | {
      readonly companyBindingId: string;
      readonly incarnation: string;
      readonly kind: 'bind-company';
      readonly legalEntityId: string;
      readonly workloadBindingId: string;
    }
  | { readonly companyBindingId: string; readonly kind: 'revoke-company' }
  | { readonly bindingId: string; readonly kind: 'revoke-workload' }
  | { readonly kind: 'disable-principal'; readonly principalId: string };

/** The steps of one registration, performed in order and on their own: one registration's failure stops no other. */
export interface RegistrationUnit {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly steps: readonly InternalWorkloadStep[];
  readonly workloadKey: string;
}

export interface TenantWorkloadPlan {
  /** Extra company bindings revoked from registrations (D6: one binding, one company). */
  readonly corrected: number;
  /** Registrations that stay as they are although wanted: a principal someone else disabled or archived. */
  readonly held: readonly PlatformRegistration[];
  readonly registered: number;
  /** Registrations that were whole but carried another name (a company or the workload's label was renamed). */
  readonly renamed: number;
  readonly retired: number;
  readonly steps: readonly InternalWorkloadStep[];
  readonly unchanged: number;
  /** The same steps, one unit per registration: wanted ones first, then the ones retired. */
  readonly units: readonly RegistrationUnit[];
}

/** A workload binding's id and incarnation, derived from its principal and how many it had before. */
export const workloadBindingIdsOf = (principalId: string, generation: number) => ({
  bindingId: stableUuid(`ontos.internal-workload/binding:${principalId}:${String(generation)}`),
  incarnation: stableUuid(`ontos.internal-workload/binding-incarnation:${principalId}:${String(generation)}`),
});

/** A company binding's id and incarnation, derived from its workload binding, its company and its generation. */
export const companyBindingIdsOf = (workloadBindingId: string, legalEntityId: string, generation: number) => ({
  companyBindingId: stableUuid(
    `ontos.internal-workload/company:${workloadBindingId}:${legalEntityId}:${String(generation)}`,
  ),
  incarnation: stableUuid(
    `ontos.internal-workload/company-incarnation:${workloadBindingId}:${legalEntityId}:${String(generation)}`,
  ),
});

/**
 * The display name a person reads for a registration: the workload's label and the company, e.g. `CRM · zakládání
 * klientů · Obchodní firma`. Never an identifier; the platform recognises its principals by id and marker, not by name.
 */
export const internalWorkloadDisplayName = (label: string, companyName: string): string => `${label} · ${companyName}`;

/** The (workload, company) pairs a tenant should hold: each wanted workload in each active company. */
const wantedIn = (state: TenantWorkloadState, declarations: readonly InternalWorkloadDeclaration[]) =>
  declarations.flatMap((declaration) =>
    state.activeModuleKeys.has(declaration.moduleKey)
      ? [...state.activeCompanies].toSorted().map((legalEntityId) => ({
          displayName: internalWorkloadDisplayName(declaration.label, state.companyNames.get(legalEntityId) ?? ''),
          legalEntityId,
          principalId: internalWorkloadPrincipalId({
            legalEntityId,
            tenantId: state.tenantId,
            workloadKey: declaration.workloadKey,
          }),
          workloadKey: declaration.workloadKey,
        }))
      : [],
  );

interface WantedRegistration {
  readonly displayName: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly workloadKey: string;
}

const missingRegistration = (wanted: WantedRegistration): PlatformRegistration => ({
  activeCompanyBindingId: null,
  activeWorkloadBindingId: null,
  companyBindingCount: 0,
  displayName: '',
  extraCompanyBindingIds: [],
  legalEntityId: wanted.legalEntityId,
  principalId: wanted.principalId,
  principalStatus: 'missing',
  workloadBindingCount: 0,
  workloadKey: wanted.workloadKey,
});

/** The steps that make one wanted registration whole; none when it is whole already. */
const ensureSteps = (registration: PlatformRegistration, displayName: string): readonly InternalWorkloadStep[] => {
  const { legalEntityId, principalId, workloadKey } = registration;
  const principalSteps: InternalWorkloadStep[] =
    registration.principalStatus === 'missing'
      ? [{ displayName, kind: 'create-principal', legalEntityId, principalId, workloadKey }]
      : [];
  if (registration.principalStatus === 'disabled' && registration.activeWorkloadBindingId === null) {
    // Retired by the platform before (company or module gone, now back): the same principal takes the workload again.
    principalSteps.push({ kind: 'reactivate-principal', principalId });
  }
  if (registration.activeWorkloadBindingId !== null) {
    if (registration.activeCompanyBindingId !== null) {
      return principalSteps;
    }
    const company = companyBindingIdsOf(
      registration.activeWorkloadBindingId,
      legalEntityId,
      registration.companyBindingCount,
    );
    return [
      ...principalSteps,
      { ...company, kind: 'bind-company', legalEntityId, workloadBindingId: registration.activeWorkloadBindingId },
    ];
  }
  const binding = workloadBindingIdsOf(principalId, registration.workloadBindingCount);
  const company = companyBindingIdsOf(binding.bindingId, legalEntityId, 0);
  return [
    ...principalSteps,
    { ...binding, kind: 'bind-workload', principalId, workloadKey },
    { ...company, kind: 'bind-company', legalEntityId, workloadBindingId: binding.bindingId },
  ];
};

/** Revokes every company binding a registration holds beyond its own company. */
const correctionSteps = (registration: PlatformRegistration): readonly InternalWorkloadStep[] =>
  registration.extraCompanyBindingIds.map(
    (companyBindingId) => ({ companyBindingId, kind: 'revoke-company' }) as const,
  );

/** The steps that retire one registration that is no longer wanted: company, then workload, then principal. */
const retireSteps = (registration: PlatformRegistration): readonly InternalWorkloadStep[] => [
  ...correctionSteps(registration),
  ...(registration.activeCompanyBindingId === null
    ? []
    : [{ companyBindingId: registration.activeCompanyBindingId, kind: 'revoke-company' } as const]),
  ...(registration.activeWorkloadBindingId === null
    ? []
    : [{ bindingId: registration.activeWorkloadBindingId, kind: 'revoke-workload' } as const]),
  ...(registration.principalStatus === 'active'
    ? [{ kind: 'disable-principal', principalId: registration.principalId } as const]
    : []),
];

/**
 * The plan for one tenant. Wanted registrations are made whole; registrations the platform made that are no longer
 * wanted (module not active, workload no longer declared or internal, company not active) are retired, never deleted.
 * A wanted registration whose principal someone else disabled (its binding still active) or archived is held as set.
 */
export const planTenantInternalWorkloads = (
  state: TenantWorkloadState,
  declarations: readonly InternalWorkloadDeclaration[],
): TenantWorkloadPlan => {
  const byPrincipal = new Map(state.registrations.map((registration) => [registration.principalId, registration]));
  const wanted = wantedIn(state, declarations);
  const wantedIds = new Set(wanted.map(({ principalId }) => principalId));
  const units: RegistrationUnit[] = [];
  const kept: PlatformRegistration[] = [];
  let corrected = 0;
  let registered = 0;
  let renamed = 0;
  let unchanged = 0;
  const unitOf = (registration: PlatformRegistration, steps: readonly InternalWorkloadStep[]) => {
    if (steps.length > 0) {
      units.push({
        legalEntityId: registration.legalEntityId,
        principalId: registration.principalId,
        steps,
        workloadKey: registration.workloadKey,
      });
    }
  };
  for (const wish of wanted) {
    const registration = byPrincipal.get(wish.principalId) ?? missingRegistration(wish);
    if (
      registration.principalStatus === 'archived' ||
      (registration.principalStatus === 'disabled' && registration.activeWorkloadBindingId !== null)
    ) {
      kept.push(registration);
      continue;
    }
    const ensure = ensureSteps(registration, wish.displayName);
    const rename =
      registration.principalStatus !== 'missing' && registration.displayName !== wish.displayName
        ? [{ displayName: wish.displayName, kind: 'rename-principal', principalId: wish.principalId } as const]
        : [];
    const correction = correctionSteps(registration);
    if (correction.length > 0) {
      corrected += correction.length;
    }
    if (ensure.length > 0) {
      registered += 1;
    } else if (rename.length > 0) {
      renamed += 1;
    } else if (correction.length === 0) {
      unchanged += 1;
    }
    unitOf(registration, [...correction, ...ensure, ...rename]);
  }
  let retired = 0;
  for (const registration of state.registrations.filter(({ principalId }) => !wantedIds.has(principalId))) {
    const retire = retireSteps(registration);
    if (retire.length > 0) {
      retired += 1;
      unitOf(registration, retire);
    }
  }
  return {
    corrected,
    held: kept,
    registered,
    renamed,
    retired,
    steps: units.flatMap((unit) => unit.steps),
    unchanged,
    units,
  };
};
