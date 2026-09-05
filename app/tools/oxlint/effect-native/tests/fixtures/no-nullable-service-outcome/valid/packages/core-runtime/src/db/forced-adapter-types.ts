import type { QueryFunction, QueryOptions } from "@tanstack/react-query";
interface Row { id: string }
// Preserve the Promise protocol of an explicitly typed framework callback.
export const loader: QueryFunction<Row | undefined> = async (): Promise<Row | undefined> => undefined;
export const checked = (async (): Promise<Row | null> => null) satisfies QueryFunction<Row | null>;
export const options = {
  queryKey: ["row"] as const,
  queryFn: async (): Promise<Row | undefined> => undefined,
} satisfies QueryOptions<Row | undefined>;
