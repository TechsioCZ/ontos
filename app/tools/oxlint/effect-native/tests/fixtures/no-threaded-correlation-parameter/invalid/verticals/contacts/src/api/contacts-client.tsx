// expect-count: 4
// A6: browser client option bags thread trace identity through every operation.
export interface ContactsOperationOptions {
	readonly correlationId: string;
	readonly locale?: string;
	readonly traceId?: string;
}

export const CustomerRow = ({
	options: { traceparent },
}: {
	readonly options: { readonly traceparent?: string };
}) => <span>{traceparent ?? 'none'}</span>;

export function ContactsBadge({ correlationId }: ContactsOperationOptions) {
	return <b>{correlationId}</b>;
}
