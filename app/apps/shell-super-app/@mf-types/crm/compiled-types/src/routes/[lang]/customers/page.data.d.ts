import { Effect } from 'effect';
import type { executeCreateContactAction } from '../../../api/create-contact-action-client.ts';
import type { executeCreateCustomerAction } from '../../../api/create-customer-action-client.ts';
import { executeCustomerDirectory } from '../../../api/customer-directory-client.ts';
import type { executeDeleteContactAction } from '../../../api/delete-contact-action-client.ts';
import type { executeDeleteCustomerAction } from '../../../api/delete-customer-action-client.ts';
import type { executeEditContactAction } from '../../../api/edit-contact-action-client.ts';
import type { executeEditCustomerAction } from '../../../api/edit-customer-action-client.ts';
import type { ContactView, CustomerDirectoryRequest, CustomerDirectoryResponse, CustomerView } from '../../../../shared/apis/customer-directory.ts';
import type { ContactDeleteResult, ContactDetailModel, ContactMutationResult, ContactRouteValidationReason } from '../../../contacts/contact-view-model.ts';
import type { CustomerDeleteResult, CustomerMutationResult, CustomerPageModel, CustomerRecordModel, CustomerRouteValidationReason } from '../../../customers/customer-view-model.ts';
export type CustomerDirectoryFailure = Effect.Error<ReturnType<typeof executeCustomerDirectory>>;
export type CustomerMutationClientFailure = Effect.Error<ReturnType<typeof executeCreateCustomerAction>> | Effect.Error<ReturnType<typeof executeEditCustomerAction>>;
export type CustomerDeleteClientFailure = Effect.Error<ReturnType<typeof executeDeleteCustomerAction>>;
export type ContactMutationClientFailure = Effect.Error<ReturnType<typeof executeCreateContactAction>> | Effect.Error<ReturnType<typeof executeEditContactAction>>;
export type ContactDeleteClientFailure = Effect.Error<ReturnType<typeof executeDeleteContactAction>>;
export interface CustomerRouteState {
    readonly contactCursor?: string;
    readonly contactPage?: number;
    readonly cursor?: string;
    readonly page: number;
    readonly selectedContactId?: string;
    readonly selectedCustomerId?: string;
}
export type CustomerRouteParseResult = {
    readonly contactValidationReason?: ContactRouteValidationReason;
    readonly state: 'valid';
    readonly value: CustomerRouteState;
} | {
    readonly reason: CustomerRouteValidationReason;
    readonly state: 'invalid';
};
export interface CustomerPageClients {
    readonly directory: (payload: CustomerDirectoryRequest, correlationId: string) => Effect.Effect<CustomerDirectoryResponse, CustomerDirectoryFailure>;
}
export declare const parseCustomerRouteState: (url: URL) => CustomerRouteParseResult;
export declare const hrefWithSelectedCustomer: (href: string, customerId: string | null) => string;
export declare const hrefWithSelectedContact: (href: string, contactId: string | null) => string;
export declare const customerViewToRecord: (customer: CustomerView) => CustomerRecordModel;
export declare const contactViewToRecord: (contact: ContactView) => ContactDetailModel;
export declare const loadCustomerPageModel: (request: Pick<Request, 'url'>, clients?: CustomerPageClients) => Promise<CustomerPageModel>;
export declare const mutationFailure: (error: CustomerMutationClientFailure) => Exclude<CustomerMutationResult, {
    state: 'success';
}>;
export declare const deleteFailure: (error: CustomerDeleteClientFailure) => Exclude<CustomerDeleteResult, {
    state: 'success';
}>;
export declare const contactMutationFailure: (error: ContactMutationClientFailure) => Exclude<ContactMutationResult, {
    state: 'success';
}>;
export declare const contactDeleteFailure: (error: ContactDeleteClientFailure) => Exclude<ContactDeleteResult, {
    state: 'success';
}>;
export declare const isCustomerPageModel: (value: unknown) => value is CustomerPageModel;
interface CustomerLoaderArguments {
    readonly request: Request;
}
export declare const loader: ({ request }: CustomerLoaderArguments) => Promise<CustomerPageModel>;
export {};
