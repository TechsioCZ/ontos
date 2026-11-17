import type { seedSourceProcessingNativeFixture } from '@app/privacy/testing/source-processing-native';

import { addressRecordId, contactRecordId, customerItemSource } from './symmy-c14-customer-public.mts';
import type { PublicAddress } from './symmy-c14-customer-public.mts';
import { customerIntakeContext } from './symmy-c14-customer-rules.mts';

/**
 * The Privacy contexts a public customers request needs, named for the exact sources the owner derives from its
 * Idempotency-Key. Privacy is seeded before the request, so every source, record and occurrence is known beforehand.
 */
export type NativeContext = Parameters<typeof seedSourceProcessingNativeFixture>[0]['contexts'][number];

const partyModuleId = 'party.registry' as const;
const commerceModuleId = 'commerce.customer-context' as const;

type Source = ReturnType<typeof customerItemSource>;
type Target = NonNullable<NativeContext['request']['target']>;

export interface SourceAuthority {
  readonly issuer: string;
  readonly namespace: string;
  readonly recordType: string;
  readonly routeRef: string;
}

/** The principals and the owner records the customer already has. */
export interface CustomerContextScope {
  readonly integrationPrincipalId: string;
  readonly partyId: string;
  readonly profileId: string;
  readonly source: SourceAuthority;
  readonly systemId: string;
}

export interface CustomerExpectation {
  readonly addresses?: readonly PublicAddress[];
  readonly contacts?: readonly { readonly preferred: boolean; readonly type: 'EMAIL'; readonly value: string }[];
  /**
   * `existing`: the Party and profile exist, so the request matches them. `created`: a new Party and profile.
   * `ambiguous`: a Party whose name an existing Party holds, so no Party is created or matched.
   */
  readonly kind: 'ambiguous' | 'created' | 'existing';
  readonly recordId: string;
}

const system = (scope: CustomerContextScope, request: NativeContext['request']): NativeContext => ({
  authMethod: 'system',
  principalId: scope.systemId,
  request,
});
const partyRequest = (operation: string, source: Source, target: Target | null): NativeContext['request'] => ({
  consumerModuleId: partyModuleId,
  operation,
  source,
  target,
});

const sourcesOf = (scope: CustomerContextScope, key: string, expectation: CustomerExpectation, index: number) => ({
  addresses: (expectation.addresses ?? []).map((address, position) =>
    customerItemSource(
      scope.source,
      key,
      `address-${index}-${position}`,
      addressRecordId(expectation.recordId, address),
    ),
  ),
  contacts: (expectation.contacts ?? []).map((contact, position) =>
    customerItemSource(
      scope.source,
      key,
      `contact-${index}-${position}`,
      contactRecordId(expectation.recordId, contact),
    ),
  ),
  customer: customerItemSource(scope.source, key, `customer-${index}`, expectation.recordId),
});

/** What matching the existing Party and profile asks Privacy for, beyond what creating them asks. */
const existingContexts = (
  scope: CustomerContextScope,
  customer: Source,
  others: { readonly addresses: readonly Source[]; readonly contacts: readonly Source[] },
): readonly NativeContext[] => {
  const partyTarget = { kind: 'PARTY', resourceId: scope.partyId } as const;
  const profileTarget = { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: scope.profileId } as const;
  return [
    system(scope, partyRequest('CREATE', customer, partyTarget)),
    system(scope, partyRequest('EVIDENCE_READ', customer, partyTarget)),
    // The profile exists: the source binding of the record moves to this observation.
    system(scope, {
      consumerModuleId: commerceModuleId,
      operation: 'customer-profile-source.write',
      source: customer,
      target: profileTarget,
    }),
    ...others.contacts.flatMap((source) => [
      system(scope, partyRequest('EVIDENCE_READ', source, null)),
      system(scope, partyRequest('EVIDENCE_READ', source, partyTarget)),
      system(scope, partyRequest('ADD_CONTACT_POINT', source, partyTarget)),
    ]),
    ...others.addresses.flatMap((source) =>
      ['saved-address-source.add', 'saved-address-source.receipt'].map((operation) =>
        system(scope, { consumerModuleId: commerceModuleId, operation, source, target: profileTarget }),
      ),
    ),
  ];
};

/** Every context one request needs, for each customer it names. */
export const customerContexts = (
  scope: CustomerContextScope,
  key: string,
  expectations: readonly CustomerExpectation[],
): readonly NativeContext[] =>
  expectations.flatMap((expectation, index) => {
    const { addresses, contacts, customer } = sourcesOf(scope, key, expectation, index);
    const intake = [customer, ...contacts, ...addresses].map((source) =>
      customerIntakeContext(scope.integrationPrincipalId, source, null),
    );
    const partyTarget = { kind: 'PARTY', resourceId: scope.partyId } as const;
    if (expectation.kind === 'ambiguous') {
      return [
        ...intake,
        system(scope, partyRequest('CREATE', customer, null)),
        system(scope, partyRequest('CREATE', customer, partyTarget)),
      ];
    }
    const creation: readonly NativeContext[] = [
      {
        authMethod: 'api_key',
        principalId: scope.integrationPrincipalId,
        request: partyRequest('EVIDENCE_READ', customer, null),
      },
      system(scope, partyRequest('CREATE', customer, null)),
      system(scope, partyRequest('EVIDENCE_READ', customer, null)),
      {
        authMethod: 'system',
        principalId: scope.systemId,
        request: {
          consumerModuleId: commerceModuleId,
          operation: 'PROFILE_CREATE',
          partySourceReference: {
            occurrenceId: customer.occurrenceId,
            recordId: customer.recordId,
            source: scope.source,
          },
          source: customer,
          target: null,
        },
        targetAdmission: 'CURRENT_SOURCE_PERSON',
      },
    ];
    return expectation.kind === 'created'
      ? [...intake, ...creation]
      : [...intake, ...creation, ...existingContexts(scope, customer, { addresses, contacts })];
  });

/** What the GET of the customers asks Privacy for, as the original source record. */
export const readbackContexts = (scope: CustomerContextScope, source: Source): readonly NativeContext[] => {
  const partyTarget = { kind: 'PARTY', resourceId: scope.partyId } as const;
  const profileTarget = { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: scope.profileId } as const;
  const requests = [
    partyRequest('PROFILE_EXPORT', source, partyTarget),
    { consumerModuleId: commerceModuleId, operation: 'customer-profile-source.read', source, target: profileTarget },
  ];
  return requests.flatMap((request) => [
    { authMethod: 'api_key' as const, principalId: scope.integrationPrincipalId, request },
    system(scope, request),
  ]);
};
