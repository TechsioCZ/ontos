import { ReadRuntime, legalEntityDetailRead } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeReferenceGatewayCredentialSource } from '@app/gateway-principal-verifier/server';
import {
  executeCounterpartyReadWithAuthorization,
  executeCustomerListWithAuthorization,
} from '@app/party-registry/api/client';
import { executeRecordsWithAuthorization as readAgreements } from '@app/siampark-agreements/clients/records';
import { executeRecordsWithAuthorization as readOccupancies } from '@app/siampark-occupancy/clients/records';
import { executeRecordsWithAuthorization as readProperty } from '@app/siampark-property/clients/records';
import { executeRecordsWithAuthorization as readWork } from '@app/siampark-work/clients/records';
import { DateTime, Effect } from 'effect';
import { FinanceReferenceUnavailable, FinanceRejected } from '../../shared/actions/apply-command.ts';
import type { Invoice } from '../../shared/apis/records.ts';
import { hasUsableRole } from '../../shared/domain/reference-audiences.ts';
import { matchesFinanceRef } from './persistence.service.ts';
import type { ExportPartnerReference, FinanceAnchors, FinanceValidators } from './persistence.service.ts';

type ReferenceFailure = Effect.Error<
  | ReturnType<typeof makeReferenceGatewayCredentialSource>
  | ReturnType<Effect.Success<ReturnType<typeof makeReferenceGatewayCredentialSource>>['issue']>
  | ReturnType<typeof executeCounterpartyReadWithAuthorization>
  | ReturnType<typeof executeCustomerListWithAuthorization>
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
export const makeFinanceValidators = Effect.fn('Finance.referenceValidators')(function* makeFinanceValidators(
  scope: OperationalScope,
) {
  if (scope.legalEntityId === undefined) {
    return yield* rejected('legal_entity_required');
  }
  const { legalEntityId } = scope;
  const source = yield* makeReferenceGatewayCredentialSource(scope).pipe(Effect.mapError(unavailable));
  const readRuntime = yield* ReadRuntime;
  /** S08: the issuer name comes from Core's legal entity of the trusted scope, partners from the party registry. */
  const exportReferences = Effect.gen(function* exportReferences() {
    const issuer = yield* readRuntime.runRead({
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
    });
    const target = yield* source.issue('party-registry');
    const customers = yield* executeCustomerListWithAuthorization({}, target.authorization, scope.correlationId, {
      baseUrl: target.apiBaseUrl,
      compositionRevision: target.compositionRevision,
    });
    const partners = new Map<string, ExportPartnerReference>();
    for (const customer of customers.items) {
      const partner: ExportPartnerReference = {
        ...(customer.city === null ? {} : { city: customer.city }),
        ...(customer.displayName === null ? {} : { displayName: customer.displayName }),
        ...(customer.companyId === null ? {} : { ico: customer.companyId }),
        ...(customer.vatId === null ? {} : { vatId: customer.vatId }),
      };
      partners.set(customer.counterpartyId, partner);
      partners.set(customer.partyId, partner);
    }
    return { issuerName: issuer.legalName, partners };
  }).pipe(Effect.mapError(unavailable), Effect.withSpan('Finance.exportReferences'));
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
    // The role must be usable today (real clock), so customers added during the demo can be invoiced at once.
    const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
    if (
      !matchesFinanceRef(party.counterpartyRef, invoice.counterpartyRef) ||
      party.legalEntityRef.resourceId !== legalEntityId ||
      party.party.archived ||
      !hasUsableRole(party.currentRoles, roleType, today)
    ) {
      return yield* rejected('counterparty_role_not_usable');
    }
    return yield* Effect.void;
  });
  const validateProperty = Effect.fn('Finance.validateProperty')(function* validateProperty(
    invoice: Pick<Invoice, 'propertyRef'>,
  ) {
    if (invoice.propertyRef !== undefined) {
      const target = yield* source.issue('siampark-property').pipe(Effect.mapError(unavailable));
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
      const target = yield* source.issue('siampark-property').pipe(Effect.mapError(unavailable));
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
      const target = yield* source.issue('siampark-occupancy').pipe(Effect.mapError(unavailable));
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
      const target = yield* source.issue('siampark-agreements').pipe(Effect.mapError(unavailable));
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
      const target = yield* source.issue('siampark-work').pipe(Effect.mapError(unavailable));
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
      const target = yield* source.issue('siampark-agreements').pipe(Effect.mapError(unavailable));
      const response = yield* readAgreements({ resourceId: wanted.resourceId }, target.authorization, scope.correlationId, {
        baseUrl: target.apiBaseUrl,
        compositionRevision: target.compositionRevision,
      }).pipe(Effect.mapError(unavailable));
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
  } satisfies FinanceValidators;
});

export type FinanceValidatorRequirements = Effect.Services<ReturnType<typeof makeFinanceValidators>>;
