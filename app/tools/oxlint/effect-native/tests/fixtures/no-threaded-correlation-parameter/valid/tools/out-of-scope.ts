// Outside `includePaths`: tooling is not application source.
export interface ToolingScope {
	readonly correlationId: string;
	readonly traceId?: string;
}

export const toolingScope = (correlationId: string) => correlationId;
