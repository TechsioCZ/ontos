// expect-count: 2
// `.mts` sources under packages/ are production code, not scripts.
export interface MtsScope {
	readonly correlationId: string;
}

export const mtsThread = (traceId: string) => traceId;
