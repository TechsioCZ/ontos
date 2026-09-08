import { Context as C } from "effect";
const Ambient = C;
export class Identity extends Ambient.Service<Identity, { readonly correlationId: string; readonly traceId: string }>()("Identity") {}
export const read = (raw: unknown) => (raw as { readonly correlationId?: string }).correlationId;
export const isIdentity = (value: unknown): value is { readonly traceId: string } => false;
