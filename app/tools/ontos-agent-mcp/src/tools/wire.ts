// Wire shapes the tools read. Hand-typed from each vertical's Schema (file references in the comments).
// Decoding is deliberately shallow: the vertical owns validation, the tools only read the fields they show.
// Money fields are integer CZK minor units unless the name ends in Czk.

/** workforce/shared/apis/records.ts EmployeeSchema */
export interface EmployeeWire {
  readonly active: boolean;
  readonly department: string;
  readonly email: string;
  readonly fullName: string;
  readonly id: string;
  readonly phone?: string;
  readonly role: string;
}

/** tagging/shared/apis/records.ts TagWithCountsSchema */
export interface TagWire {
  readonly color: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly description?: string;
  readonly id: string;
  readonly name: string;
  readonly subjectKinds: readonly string[];
}

/** tagging/shared/apis/records.ts AssignmentSchema */
export interface AssignmentWire {
  readonly subject: { readonly id: string; readonly kind: string };
  readonly tagId: string;
}

/** tagging/shared/apis/records.ts RecordsResponseSchema */
export interface TaggingRecordsWire {
  readonly assignments: readonly AssignmentWire[];
  readonly revision: number;
  readonly tags: readonly TagWire[];
}

/** party-registry/shared/apis/customer-list.ts CustomerListItemSchema (nullable Option fields are null on the wire) */
export interface CustomerWire {
  readonly city: string | null;
  readonly companyId: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly partyId: string;
  readonly phone: string | null;
  readonly status: string;
  readonly vatId: string | null;
}

/** sales-pipeline/shared/model/opportunity.ts OpportunitySchema */
export interface OpportunityWire {
  readonly amountMinor: number;
  readonly closedAt?: string;
  readonly createdAt: string;
  readonly expectedCloseDate: string;
  readonly id: string;
  readonly lines: readonly OpportunityLineWire[];
  readonly note?: string;
  readonly ownerEmployeeId?: string;
  readonly partyId: string;
  readonly probability: number;
  readonly stage: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface OpportunityLineWire {
  readonly productId?: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly vatRate: number;
}

/** sales-pipeline/shared/apis/records.ts OpportunityIndicatorsSchema; winRate is a 0..1 fraction or null */
export interface OpportunityIndicatorsWire {
  readonly lostCount: number;
  readonly openCount: number;
  readonly openValueMinor: number;
  readonly weightedValueMinor: number;
  readonly winRate: number | null;
  readonly wonCount: number;
  readonly wonValueMinor: number;
}

export interface OpportunitiesRecordsWire {
  readonly indicators: OpportunityIndicatorsWire;
  readonly items: readonly OpportunityWire[];
  readonly revision: number;
}

export interface OpportunityCommandResultWire {
  readonly opportunities: readonly OpportunityWire[];
  readonly revision: number;
}

/** merchandise/domain/merchandise-model.ts ProductRecordSchema */
export interface ProductWire {
  readonly active: boolean;
  readonly category: string;
  readonly currentPriceMinor: number;
  readonly id: string;
  readonly lowStock: boolean;
  readonly lowStockThreshold: number;
  readonly name: string;
  readonly sku: string;
  readonly stockOnHand: number;
  readonly stockValueMinor: number;
  readonly unit: string;
  readonly vatRate: number;
}

/** merchandise/domain/merchandise-model.ts StockMovementSchema */
export interface MovementWire {
  readonly delta: number;
  readonly productId: string;
}

/** merchandise/domain/merchandise-model.ts OrderSchema */
export interface OrderWire {
  readonly createdAt: string;
  readonly id: string;
  readonly lines: readonly {
    readonly productId: string;
    readonly productName: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly vatRate: number;
  }[];
  readonly number: string;
  readonly opportunityId?: string;
  readonly partyId: string;
  readonly status: string;
  readonly totalMinor: number;
  readonly totalVatMinor: number;
}

export interface MerchandiseRecordsWire {
  readonly indicators: {
    readonly lowStockCount: number;
    readonly openOrderValueMinor: number;
    readonly orderCount: number;
    readonly productCount: number;
    readonly stockValueMinor: number;
  };
  readonly movements: readonly MovementWire[];
  readonly orders: readonly OrderWire[];
  readonly products: readonly ProductWire[];
  readonly revision: number;
}

/** siampark-billing-finance/shared/apis/records.ts InvoiceSchema (subset) */
export interface InvoiceWire {
  readonly businessState: string;
  readonly counterpartyRef: { readonly resourceId: string };
  readonly direction: string;
  readonly documentNumber: string;
  readonly dueDate: string;
  readonly issueDate: string;
  readonly number?: string;
  readonly opportunityId?: string;
  readonly paidMinor: number;
  readonly partyId?: string;
  readonly paymentState: string;
  readonly totalMinor: number;
}

export interface BillingRecordsWire {
  readonly canWrite: boolean;
  readonly indicators: Readonly<Record<string, number>>;
  readonly referenceDate: string;
  readonly revision: number;
  readonly state: { readonly invoices: readonly InvoiceWire[] };
}

/** siampark-work/shared/apis/records.ts TaskSchema (subset) */
export interface TaskWire {
  readonly assigneeEmployeeId?: string;
  readonly description?: string;
  readonly dueDate?: string;
  readonly opportunityId?: string;
  readonly partyId?: string;
  readonly priority: string;
  readonly ref: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  };
  readonly state: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface WorkRecordsWire {
  readonly indicators: { readonly open: number; readonly overdue: number };
  readonly items: readonly TaskWire[];
  readonly referenceDate: string;
  readonly revision: number;
}

export interface WorkCommandResultWire {
  readonly results?: readonly { readonly outcome: string; readonly reason?: string; readonly resourceId: string }[];
  readonly revision: number;
  readonly task?: TaskWire;
}
