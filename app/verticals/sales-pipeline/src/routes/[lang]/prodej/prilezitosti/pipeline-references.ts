import { HttpApi, HttpApiEndpoint, HttpApiGroup, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { listProducts } from '@app/merchandise/clients/records';
import type { ProductRecord } from '@app/merchandise/contracts/records';
import { listCustomers } from '@app/party-registry/api/client';
import type { CustomerListItem } from '@app/party-registry/api/client';
import { subjectsWithTag } from '@app/tagging/clients/records';
import { SubjectIdSchema } from '@app/tagging/contracts/records';
import type { SubjectId, SubjectKind, TagId } from '@app/tagging/contracts/records';
import { listEmployees } from '@app/workforce/clients/records';
import type { Employee } from '@app/workforce/contracts/records';
import { Effect, Option, Random, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { OpportunityLine } from '../../../../../shared/model/opportunity.ts';
import {
  EmployeeIdSchema,
  PartyIdSchema,
  ProductIdSchema,
} from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { loadPipeline } from './pipeline-api.ts';

type PartyId = typeof PartyIdSchema.Type;
type EmployeeId = typeof EmployeeIdSchema.Type;
type ProductId = typeof ProductIdSchema.Type;

/** One reference list: loading until the first answer, then ready, or error when the read failed. */
export type LoadState<T> =
  | { readonly status: 'loading' }
  | { readonly items: T; readonly status: 'ready' }
  | { readonly cause: unknown; readonly status: 'error' };

export interface CustomerOption {
  readonly archived: boolean;
  readonly companyId: string | null;
  /** The customer's counterparty in this company; contracts and invoices reference it. */
  readonly counterpartyId: string;
  readonly id: PartyId;
  readonly name: string | null;
}

export interface EmployeeOption {
  readonly active: boolean;
  readonly fullName: string;
  readonly id: EmployeeId;
}

export interface ProductOption {
  readonly active: boolean;
  readonly currentPriceMinor: number;
  readonly id: ProductId;
  readonly name: string;
  readonly sku: string;
  readonly vatRate: OpportunityLine['vatRate'];
}

export interface PipelineReferences {
  readonly customers: LoadState<readonly CustomerOption[]>;
  readonly employees: LoadState<readonly EmployeeOption[]>;
  readonly products: LoadState<readonly ProductOption[]>;
}

const correlated = (name: string) => Random.nextInt.pipe(Effect.map((nonce) => `sales-pipeline:${name}:${nonce}`));

const toCustomerOption = (item: CustomerListItem): Option.Option<CustomerOption> =>
  Option.map(Schema.decodeOption(PartyIdSchema)(item.partyId), (id) => ({
    archived: item.status === 'ARCHIVED',
    companyId: item.companyId,
    counterpartyId: item.counterpartyId,
    id,
    name: item.displayName,
  }));

const toEmployeeOption = (item: Employee): Option.Option<EmployeeOption> =>
  Option.map(Schema.decodeOption(EmployeeIdSchema)(item.id), (id) => ({
    active: item.active,
    fullName: item.fullName,
    id,
  }));

const toProductOption = (item: ProductRecord): Option.Option<ProductOption> =>
  Option.map(Schema.decodeOption(ProductIdSchema)(item.id), (id) => ({
    active: item.active,
    currentPriceMinor: item.currentPriceMinor,
    id,
    name: item.name,
    sku: item.sku,
    vatRate: item.vatRate,
  }));

const loadCustomers = listCustomers({}).pipe(
  Effect.map((items) => items.flatMap((item) => Option.toArray(toCustomerOption(item)))),
);

const loadEmployees = listEmployees().pipe(
  Effect.map((items) => items.flatMap((item) => Option.toArray(toEmployeeOption(item)))),
);

// The shell publishes only modules permitted for the selected legal entity. A missing catalog is an
// intentional composition choice; a failed composition lookup still surfaces the actual provider failure.
const NavigationModuleIdSchema = Schema.String.pipe(Schema.brand('NavigationModuleId'));
const NavigationApi = HttpApi.make('PipelineNavigationApi').add(
  HttpApiGroup.make('composition').add(
    HttpApiEndpoint.get('shellComposition', '/shell/composition', {
      success: Schema.Struct({
        navigation: Schema.Array(Schema.Struct({ moduleId: NavigationModuleIdSchema })),
        state: Schema.String,
      }),
    }),
  ),
);
const catalogReadable = makeEffectHttpApiClient(NavigationApi, { baseUrl: '/shell-super-app-api' }).pipe(
  Effect.flatMap((client) => client.composition.shellComposition({})),
  Effect.map(
    ({ navigation, state }) =>
      state !== 'available' || navigation.some(({ moduleId }) => moduleId === 'demo.merchandise'),
  ),
  Effect.timeout('3 seconds'),
  Effect.orElseSucceed(() => true),
);
const loadProducts = catalogReadable.pipe(
  Effect.flatMap((readable) =>
    readable
      ? correlated('products').pipe(
          Effect.flatMap((id) => listProducts(id)),
          Effect.map((items) => items.flatMap((item) => Option.toArray(toProductOption(item)))),
        )
      : Effect.succeed<readonly ProductOption[]>([]),
  ),
);

/** Full opportunity population, unfiltered, with its revision. Bulk actions use it so table filters never narrow them. */
const loadAllOpportunities = correlated('bulk-tags').pipe(Effect.flatMap((id) => loadPipeline({}, id)));

/** Runs one read in the browser runtime. The state stays `loading` until the read settles. */
const useLoad = <A, E>(load: Effect.Effect<A, E>): LoadState<A> => {
  const [state, setState] = useState<LoadState<A>>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    void browserRuntime.runPromise(
      load.pipe(
        Effect.match({
          onFailure: (error) => {
            if (active) {
              setState({ cause: error, status: 'error' });
            }
          },
          onSuccess: (items) => {
            if (active) {
              setState({ items, status: 'ready' });
            }
          },
        }),
      ),
    );
    return () => {
      active = false;
    };
  }, [load]);
  return state;
};

/** Customers, employees and products for the pipeline screen. Each list fails on its own. */
export const usePipelineReferences = (): PipelineReferences => ({
  customers: useLoad(loadCustomers),
  employees: useLoad(loadEmployees),
  products: useLoad(loadProducts),
});

export const useAllOpportunities = (): LoadState<RecordsResponse> => useLoad(loadAllOpportunities);

/** Subject id accepted by tagging, or `undefined` for anything tagging would refuse. */
export const subjectIdOf = (id: string): SubjectId | undefined =>
  Option.getOrUndefined(Schema.decodeOption(SubjectIdSchema)(id));

export const toSubjectIds = (ids: readonly string[]): SubjectId[] =>
  ids.flatMap((id) => {
    const subject = subjectIdOf(id);
    return subject === undefined ? [] : [subject];
  });

/**
 * Subject ids that carry `tagId` for one kind. `undefined` when no tag is chosen; `loading` until the read
 * answers for the current tag and version. `version` changes after tag writes so the set refreshes.
 */
export const useSubjectIdsWithTag = (
  kind: SubjectKind,
  tagId: TagId | null,
  version: number,
): LoadState<ReadonlySet<string>> | undefined => {
  const key = `${kind}:${tagId ?? ''}:${version}`;
  const [result, setResult] = useState<{ readonly key: string; readonly state: LoadState<ReadonlySet<string>> }>();
  useEffect(() => {
    let active = true;
    if (tagId !== null) {
      void browserRuntime.runPromise(
        subjectsWithTag(kind, tagId).pipe(
          Effect.match({
            onFailure: (error) => {
              if (active) {
                setResult({ key, state: { cause: error, status: 'error' } });
              }
            },
            onSuccess: (ids) => {
              if (active) {
                setResult({ key, state: { items: new Set<string>(ids), status: 'ready' } });
              }
            },
          }),
        ),
      );
    }
    return () => {
      active = false;
    };
  }, [key, kind, tagId]);
  const current = result?.key === key ? result.state : { status: 'loading' as const };
  return tagId === null ? undefined : current;
};
