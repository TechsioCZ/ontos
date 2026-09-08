// expect-count: 3
import { Layer } from "@modern-js/plugin-bff/effect-edge";

interface ActionRuntime {
  readonly run: () => void;
}
interface ReadRuntime {
  readonly read: () => void;
}
interface AresSubjectService {
  readonly lookup: () => void;
}
declare const aresSubjectServiceLive: Layer.Layer<AresSubjectService>;

// 1-3: `Layer.Layer` reaches this repository through a re-export barrel, not `effect` directly;
// the qualified spelling is still unambiguously Effect's Layer (A1 evidence).
export const makeContactsApiRuntime = (
  actionRuntime: Layer.Layer<ActionRuntime>,
  readRuntime: Layer.Layer<ReadRuntime>,
  aresSubject: Layer.Layer<AresSubjectService> = aresSubjectServiceLive,
) => [actionRuntime, readRuntime, aresSubject];
