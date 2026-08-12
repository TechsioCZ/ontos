import type { FormEvent } from 'react';
import type { CustomerWorkspaceProps } from './customer-view-model.ts';
interface CrudFailureCopy {
    readonly issues: {
        readonly server_validation: string;
    };
    readonly states: {
        readonly conflict: string;
        readonly forbidden: string;
        readonly notFound: string;
        readonly unavailable: string;
    };
}
type CrudFailure<Issue> = {
    readonly issues: readonly Issue[];
    readonly state: 'validation';
} | {
    readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable';
};
export declare const crudMutationMessage: <Issue>(result: CrudFailure<Issue>, copy: CrudFailureCopy) => string;
interface CrudFormStateOptions<Values, Field extends string, Issue extends {
    readonly field?: Field;
}, Success extends {
    readonly state: 'success';
}> {
    readonly initialValues: Values;
    readonly mutationMessage: (failure: CrudFailure<Issue>) => string;
    readonly onSubmit: (values: Values) => Promise<Success | CrudFailure<Issue>>;
    readonly onSuccess: (result: Success) => void;
    readonly validate: (values: Values) => readonly Issue[];
}
export declare const useCrudFormState: <Values, Field extends string, Issue extends {
    readonly field?: Field;
}, Success extends {
    readonly state: 'success';
}>({ initialValues, mutationMessage, onSubmit, onSuccess, validate, }: CrudFormStateOptions<Values, Field, Issue, Success>) => {
    failure: string | undefined;
    formId: string;
    handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
    issueFor: (field: Field) => Issue | undefined;
    issues: readonly Issue[];
    pending: boolean;
    setFieldElement: (field: Field, element: HTMLInputElement | null) => void;
    setSummaryElement: (element: HTMLDivElement | null) => void;
    setValues: import("react").Dispatch<import("react").SetStateAction<Values>>;
    values: Values;
};
type CrudDeleteResult = {
    readonly state: 'success';
} | {
    readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable';
};
interface CrudDeleteStateOptions<Selected> {
    readonly failureMessage: (failure: Exclude<CrudDeleteResult, {
        state: 'success';
    }>) => string;
    readonly onDelete: (selected: Selected) => Promise<CrudDeleteResult>;
    readonly onSuccess: () => void;
    readonly selected: Selected | undefined;
}
export declare const useCrudDeleteState: <Selected>({ failureMessage, onDelete, onSuccess, selected, }: CrudDeleteStateOptions<Selected>) => {
    failure: string | undefined;
    handleDelete: () => void;
    onOpenChange: (nextOpen: boolean) => void;
    open: boolean;
    pending: boolean;
    setOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
};
export declare const CrudStatePanel: ({ children, status, }: {
    readonly children: string;
    readonly status?: 'default' | 'error' | 'warning';
}) => import("react").JSX.Element;
export declare const CustomerWorkspace: ({ copy, model, onCreate, onDelete, onEdit, onNavigate, onRetry, writable, }: CustomerWorkspaceProps) => import("react").JSX.Element;
export {};
