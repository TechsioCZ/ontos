// Direct member imports used only in erased type positions never start a fiber.
import { provide, provideService } from "effect/Effect";
import type { updateService } from "effect/Effect";

export type ProvideParameters = Parameters<typeof provide>;
export type ProvideServiceType = typeof provideService;
export type UpdateService = typeof updateService;
