// expect-count: 4
import { Context } from "unrelated-context";
// A wire-shaped outer owner must never bless a nested internal operation.
export function safeCorrelationId(input: string) {
	const forward = (correlationId: string) => input + correlationId;
	return forward(input);
}
export const buildRequest = () => {
	interface Internal { ["traceId"]: string }
	return (correlationId: string) => correlationId;
};
// A lookalike Context binding is not the audit's ambient-service target.
export class NotAmbient extends Context.Service<NotAmbient, { readonly correlationId: string }>()("x") {}
