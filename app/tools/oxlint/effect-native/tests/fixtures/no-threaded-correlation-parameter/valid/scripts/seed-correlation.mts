// Scripts are out of scope (`isScriptFile`).
export interface SeedScope {
	readonly correlationId: string;
}

export const seed = ({ correlationId }: SeedScope, traceId: string) => `${correlationId}${traceId}`;
