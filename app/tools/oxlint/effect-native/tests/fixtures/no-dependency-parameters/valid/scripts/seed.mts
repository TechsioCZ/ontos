import { Layer } from "effect";

interface SeedGateway {
  readonly seed: () => void;
}

// scripts/** is out of scope by default (B3 migrates only consequential scripts).
export const run = (gateway: SeedGateway, layer: Layer.Layer<never>) => [gateway, layer];
