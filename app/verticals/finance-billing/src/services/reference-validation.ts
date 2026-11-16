import { ReadRuntime, agentActivityActorsRead, legalEntityDetailRead } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeReferenceGatewayCredentialSource } from '@app/gateway-principal-verifier/server';
import {
  COUNTERPARTY_IDENTITIES_MAX_REFS,
  executeCounterpartyIdentitiesWithAuthorization,
  executeCounterpartyReadWithAuthorization,
} from '@app/party-registry/api/client';
import type { CounterpartyIdentity } from '@app/party-registry/api/client';
import { executeRecordsWithAuthorization as readAgreements } from '@app/legal-agreements/clients/records';
import { executeRecordsWithAuthorization as readOccupancies } from '@app/property-leasing/clients/records';
import { executeRecordsWithAuthorization as readProperty } from '@app/property-portfolio/clients/records';
import { executeRecordsWithAuthorization as readWork } from '@app/work-tasks/clients/records';
import { Array as Arr, Context, DateTime, Effect, Layer } from 'effect';
import { FinanceReferenceUnavailable, FinanceRejected } from '../../shared/actions/apply-command.ts';
import type { Invoice } from '../../shared/apis/records.ts';
import { hasUsableRole } from '../../shared/domain/reference-audiences.ts';
import { FinanceTaxRates } from '../integrations/tax-rates.ts';
import { matchesFinanceRef } from './persistence.service.ts';
import type { ExportPartnerReference, FinanceAnchors, FinanceValidators } from './persistence.service.ts';

type MutableExportPartnerReference = { -readonly [Key in keyof ExportPartnerReference]: ExportPartnerReference[Key] };

type ReferenceFailure = Effect.Error<
  | ReturnType<typeof makeReferenceGatewayCredentialSource>
  | ReturnType<Effect.Success<ReturnType<typeof makeReferenceGatewayCredentialSource>>['issue']>
  | ReturnType<typeof executeCounterpartyIdentitiesWithAuthorization>
  | ReturnType<typeof executeCounterpartyReadWithAuthorization>
  | ReturnType<typeof readAgreements>
  | ReturnType<typeof readOccupancies>
  | ReturnType<typeof readProperty>
  | ReturnType<typeof readWork>
>;
/** Core Read failures (legal entity of the export issuer) are tagged errors as well. */
const unavailable = (cause?: ReferenceFailure | { readonly _tag: string }) =>
  Object.defineProperty(
    new FinanceReferenceUnavailable({
      code: 'finance_reference_unavailable',
      reason: 'A required public reference projection is unavailable',
    }),
    'cause',
    { value: cause },
  );
const rejected = (reason: string) => new FinanceRejected({ code: 'finance_rejected', reason });

const exportPartnerOf = (identity: CounterpartyIdentity): ExportPartnerReference => {
  const partner: MutableExportPartnerReference = {};
  if (identity.city !== null) {
    partner.city = identity.city;
  }
  if (identity.displayName !== null) {
    partner.displayName = identity.displayName;
  }
  if (identity.companyId !== null) {
    partner.ico = identity.companyId;
  }
  if (identity.vatId !== null) {
    partner.vatId = identity.vatId;
  }
  return partner;
};

/**
 * The registry identity of exactly the named counterparties, keyed by counterparty id: each distinct one asked once,
 * in batches the party registry accepts, so no partner is left out however many an export names.
 */
export const resolveExportPartners = Effect.fn('Finance.resolveExportPartners')(function* resolveExportPartners<E, R>(
  counterpartyRefs: readonly Invoice['counterpartyRef'][],
  readBatch: (batch: readonly Invoice['counterpartyRef'][]) => Effect.Effect<readonly CounterpartyIdentity[], E, R>,
) {
  const distinct = [...new Map(counterpartyRefs.map((ref) => [ref.resourceId, ref])).values()];
  const batches = Arr.chunksOf(distinct, COUNTERPARTY_IDENTITIES_MAX_REFS);
  const answered = yield* Effect.forEach(batches, readBatch, { concurrency: 1 });
  return new Map(answered.flat().map((identity) => [identity.counterpartyRef.resourceId, exportPartnerOf(identity)]));
});

const makeFinanceValidators = Effect.fn('Finance.referenceValidators')(function* makeFinanceValidators(
  scope: OperationalScope,
) {
  if (scope.legalEntityId === undefined) {
    return yield* rejected('legal_entity_required');
  }
  const { legalEntityId } = scope;
  const source = yield* makeReferenceGatewayCredentialSource(scope).pipe(Effect.mapError(unavailable));
  const readRuntime = yield* ReadRuntime;
  const taxRates = yield* FinanceTaxRates;
  /**
   * S08: the issuer name comes from Core's legal entity of the trusted scope, the partners of the selected invoices
   * from the party registry's identity of exactly those counterparties, whatever role they hold.
   */
  const exportReferences = Effect.fn('Finance.exportReferences')(function* exportReferences(
    counterpartyRefs: readonly Invoice['counterpartyRef'][],
  ) {
    const issuer = yield* readRuntime
      .runRead({
        input: {
          legalEntityRef: {
            moduleId: 'core.identity',
            resourceId: legalEntityId,
            resourceType: 'core.identity.legal-entity',
            tenantId: scope.tenantId,
          },
        },
        principal: scope,
        registration: legalEntityDetailRead,
        transport: { correlationId: scope.correlationId },
      })
      .pipe(Effect.mapError(unavailable));
    const issuerName = issuer.legalName;
    if (issuerName === undefined || issuerName.trim().length === 0) {
      return yield* unavailable();
    }
    // No partner credential is issued before the trusted issuer read succeeds; each batch carries its own.
    const { actors, partners } = yield* Effect.all(
      {
        partners: resolveExportPartners(counterpartyRefs, (batch) =>
          source.issue('party-registry').pipe(
            Effect.flatMap((target) =>
              executeCounterpartyIdentitiesWithAuthorization(
                { counterpartyRefs: batch },
                target.authorization,
                scope.correlationId,
                { baseUrl: target.apiBaseUrl, compositionRevision: target.compositionRevision },
              ),
            ),
            Effect.map((response) => response.items),
            Effect.mapError(unavailable),
          ),
        ),
        // The file names its author by the display name Core holds for the authenticated principal, never by its id.
        actors: readRuntime
          .runRead({
            input: {},
            principal: scope,
            registration: agentActivityActorsRead,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(Effect.mapError(unavailable)),
      },
      // One after the other, as before: the partner reads first, then the author.
      { concurrency: 1 },
    );
    const author = actors.names.find((entry) => entry.principalId === scope.principalId);
    if (author === undefined) {
      return { issuerName, partners };
    }
    return { authorName: author.displayName, issuerName, partners };
  });
  const validateCounterparty = Effect.fn('Finance.validateCounterparty')(function* validateCounterparty(
    invoice: Invoice,
  ) {
    const partyTarget = yield* source.issue('party-registry').pipe(Effect.mapError(unavailable));
    const party = yield* executeCounterpartyReadWithAuthorization(
      { counterpartyRef: invoice.counterpartyRef },
      partyTarget.authorization,
      scope.correlationId,
      { baseUrl: partyTarget.apiBaseUrl, compositionRevision: partyTarget.compositionRevision },
    ).pipe(Effect.mapError(unavailable));
    const roleType = invoice.direction === 'INCOMING' ? 'SUPPLIER' : 'CUSTOMER';
    // The role must be usable now (real clock), so customers added during the demo can be invoiced at once.
    const now = yield* DateTime.now;
    if (
      !matchesFinanceRef(party.counterpartyRef, invoice.counterpartyRef) ||
      party.legalEntityRef.resourceId !== legalEntityId ||
      party.party.archived ||
      !hasUsableRole(party.currentRoles, roleType, now)
    ) {
      return yield* rejected('counterparty_role_not_usable');
    }
    return yield* Effect.void;
  });
  const validateProperty = Effect.fn('Finance.validateProperty')(function* validateProperty(
    invoice: Pick<Invoice, 'propertyRef'>,
  ) {
    if (invoice.propertyRef !== undefined) {
      const target = yield* source.issue('property-portfolio').pipe(Effect.mapError(unavailable));
      const response = yield* readProperty(
        { resourceId: invoice.propertyRef.resourceId },
        target.authorization,
        scope.correlationId,
        { baseUrl: target.apiBaseUrl, compositionRevision: target.compositionRevision },
      ).pipe(Effect.mapError(unavailable));
      const wanted = invoice.propertyRef;
      const property = response.properties.find((record) => matchesFinanceRef(record.propertyRef, wanted));
      if (
        property === undefined ||
        property.legalEntityRef.resourceId !== legalEntityId ||
        property.lifecycleState !== 'ACTIVE'
      ) {
        return yield* rejected('property_not_usable');
      }
    }
    return yield* Effect.void;
  });
  const validateUnit = Effect.fn('Finance.validateUnit')(function* validateUnit(
    invoice: Pick<Invoice, 'propertyRef' | 'unitRef'>,
  ) {
    if (invoice.unitRef !== undefined) {
      const target = yield* source.issue('property-portfolio').pipe(Effect.mapError(unavailable));
      const response = yield* readProperty(
        { resourceId: invoice.unitRef.resourceId },
        target.authorization,
        scope.correlationId,
        { baseUrl: target.apiBaseUrl, compositionRevision: target.compositionRevision },
      ).pipe(Effect.mapError(unavailable));
      const wanted = invoice.unitRef;
      const unit = response.units.find((record) => matchesFinanceRef(record.unitRef, wanted));
      if (
        unit === undefined ||
        invoice.propertyRef === undefined ||
        !matchesFinanceRef(unit.propertyRef, invoice.propertyRef) ||
        unit.lifecycleState !== 'ACTIVE'
      ) {
        return yield* rejected('unit_property_mismatch');
      }
    }
    return yield* Effect.void;
  });
  const validateOccupancy = Effect.fn('Finance.validateOccupancy')(function* validateOccupancy(invoice: Invoice) {
    if (invoice.occupancyRef !== undefined) {
      const target = yield* source.issue('property-leasing').pipe(Effect.mapError(unavailable));
      const response = yield* readOccupancies(
        { resourceId: invoice.occupancyRef.resourceId },
        target.authorization,
        scope.correlationId,
        { baseUrl: target.apiBaseUrl, compositionRevision: target.compositionRevision },
      ).pipe(Effect.mapError(unavailable));
      const occupancy = response.occupancies.find((record) =>
        matchesFinanceRef(record.occupancyRef, invoice.occupancyRef ?? invoice.counterpartyRef),
      );
      if (
        occupancy === undefined ||
        occupancy.customerCounterpartyRef === null ||
        !matchesFinanceRef(occupancy.customerCounterpartyRef, invoice.counterpartyRef) ||
        (invoice.unitRef !== undefined && !matchesFinanceRef(occupancy.unitRef, invoice.unitRef)) ||
        (invoice.contractRef !== undefined &&
          (occupancy.contractRef === null || !matchesFinanceRef(occupancy.contractRef, invoice.contractRef))) ||
        (invoice.businessState === 'CONFIRMED' &&
          occupancy.state !== 'ACTIVE' &&
          occupancy.state !== 'CONFIRMED' &&
          occupancy.state !== 'COMPLETED')
      ) {
        return yield* rejected('occupancy_invoice_mismatch');
      }
    }
    return yield* Effect.void;
  });
  const validateContract = Effect.fn('Finance.validateContract')(function* validateContract(invoice: Invoice) {
    if (invoice.contractRef !== undefined) {
      const target = yield* source.issue('legal-agreements').pipe(Effect.mapError(unavailable));
      const response = yield* readAgreements(
        { resourceId: invoice.contractRef.resourceId },
        target.authorization,
        scope.correlationId,
        { baseUrl: target.apiBaseUrl, compositionRevision: target.compositionRevision },
      ).pipe(Effect.mapError(unavailable));
      const contract = response.contracts.find((record) =>
        matchesFinanceRef(record.contractRef, invoice.contractRef ?? invoice.counterpartyRef),
      );
      if (
        contract === undefined ||
        !matchesFinanceRef(contract.counterpartyRef, invoice.counterpartyRef) ||
        (invoice.unitRef !== undefined &&
          (contract.unitRef === null || !matchesFinanceRef(contract.unitRef, invoice.unitRef))) ||
        (invoice.propertyRef !== undefined &&
          contract.propertyRef !== null &&
          !matchesFinanceRef(contract.propertyRef, invoice.propertyRef)) ||
        (invoice.occupancyRef !== undefined &&
          contract.occupancyRef !== null &&
          !matchesFinanceRef(contract.occupancyRef, invoice.occupancyRef)) ||
        (invoice.businessState === 'CONFIRMED' && contract.lifecycleState !== 'ACTIVE')
      ) {
        return yield* rejected('contract_invoice_mismatch');
      }
    }
    return yield* Effect.void;
  });
  const validateTask = Effect.fn('Finance.validateTask')(function* validateTask(invoice: Invoice) {
    if (invoice.taskRef !== undefined) {
      const target = yield* source.issue('work-tasks').pipe(Effect.mapError(unavailable));
      const response = yield* readWork(
        { resourceId: invoice.taskRef.resourceId },
        target.authorization,
        scope.correlationId,
        { baseUrl: target.apiBaseUrl, compositionRevision: target.compositionRevision },
      ).pipe(Effect.mapError(unavailable));
      const task = response.items.find((record) =>
        matchesFinanceRef(record.ref, invoice.taskRef ?? invoice.counterpartyRef),
      );
      if (
        task === undefined ||
        invoice.propertyRef === undefined ||
        !task.contextRefs.some(
          (ref) =>
            ref.moduleId === invoice.propertyRef?.moduleId &&
            ref.resourceType === invoice.propertyRef.resourceType &&
            matchesFinanceRef(ref, invoice.propertyRef),
        )
      ) {
        return yield* rejected('task_property_mismatch');
      }
    }
    return yield* Effect.void;
  });
  /** Budgets, plan items and hand-typed supplier invoices: the anchors must exist in this legal entity. */
  const validateContractAnchor = Effect.fn('Finance.validateContractAnchor')(function* validateContractAnchor(
    anchors: FinanceAnchors,
  ) {
    if (anchors.contractRef !== undefined) {
      const wanted = anchors.contractRef;
      const target = yield* source.issue('legal-agreements').pipe(Effect.mapError(unavailable));
      const response = yield* readAgreements(
        { resourceId: wanted.resourceId },
        target.authorization,
        scope.correlationId,
        {
          baseUrl: target.apiBaseUrl,
          compositionRevision: target.compositionRevision,
        },
      ).pipe(Effect.mapError(unavailable));
      if (!response.contracts.some((record) => matchesFinanceRef(record.contractRef, wanted))) {
        return yield* rejected('contract_not_usable');
      }
    }
    return yield* Effect.void;
  });
  return {
    anchors: Effect.fn('Finance.authorizedAnchors')(function* anchorReferences(anchors: FinanceAnchors) {
      yield* validateProperty(anchors);
      yield* validateUnit(anchors);
      return yield* validateContractAnchor(anchors);
    }),
    exportReferences,
    invoice: Effect.fn('Finance.authorizedInvoiceReferences')(function* invoiceReferences(invoice: Invoice) {
      yield* validateCounterparty(invoice);
      yield* validateProperty(invoice);
      yield* validateUnit(invoice);
      yield* validateOccupancy(invoice);
      yield* validateContract(invoice);
      return yield* validateTask(invoice);
    }),
    vat: (on: string) => taxRates.choices(scope, on),
  } satisfies FinanceValidators;
});

export type FinanceValidatorRequirements = Effect.Services<ReturnType<typeof makeFinanceValidators>>;

/**
 * Builds the command reference validators of one request from that request's operational scope (tenant and
 * company). Every call returns new validators over a new reference credential source, so two requests never
 * share a validator or what it looked up. Required by the apply-command Action; provided once in the API root.
 */
export class FinanceReferenceValidators extends Context.Service<
  FinanceReferenceValidators,
  {
    readonly forScope: (
      scope: OperationalScope,
    ) => Effect.Effect<
      FinanceValidators,
      Effect.Error<ReturnType<typeof makeFinanceValidators>>,
      FinanceValidatorRequirements
    >;
  }
>()('@app/finance-billing/services/reference-validation/FinanceReferenceValidators') {}

export const FinanceReferenceValidatorsLive = Layer.succeed(FinanceReferenceValidators, {
  forScope: makeFinanceValidators,
});
