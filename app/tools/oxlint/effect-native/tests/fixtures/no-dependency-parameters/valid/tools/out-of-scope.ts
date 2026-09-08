import { Layer } from "effect";

interface BuildGateway {
  readonly build: () => void;
}

// Outside includePaths (apps/**, verticals/**, packages/**).
export const configure = (gateway: BuildGateway, layer: Layer.Layer<never>) => [gateway, layer];
