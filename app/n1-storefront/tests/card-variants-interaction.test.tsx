import { afterEach, beforeEach, describe, expect, rs } from "@rstest/core";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { it } from "effect-rstest";
import type { DependencyList, EffectCallback, PropsWithChildren, SetStateAction } from "react";
import actualReact from "react" with { rstest: "importActual" };
import { renderToStaticMarkup } from "react-dom/server";
import { CardVariants } from "../src/features/card-variants";
import { getDictionary } from "../src/i18n";
import type { ProductCardModel } from "../src/ontos/catalog-model";
import type { CardVariantsResult } from "../src/ontos/card-variants";

interface KeyboardAction {
  key: string;
  preventDefault: () => void;
}
interface AnchorActions {
  onFocus: () => void;
  onKeyDown: (event: KeyboardAction) => void;
  onPointerEnter: () => void;
}
interface TriggerActions {
  onClick: () => void;
}
interface CardReadFixture {
  fiber: Fiber.Fiber<CardVariantsResult>;
  request: Deferred.Deferred<Effect.Effect<CardVariantsResult>>;
  response: Deferred.Deferred<CardVariantsResult>;
}
interface RenderedCard {
  anchor: AnchorActions | null;
  effects: EffectCallback[];
  fixture: CardReadFixture | null;
  load: ReturnType<typeof rs.fn>;
  open: boolean | null;
  openUpdates: boolean[];
  stateIndex: number;
  toast: ReturnType<typeof rs.fn>;
  trigger: TriggerActions | null;
  unmount: (() => void) | null;
}
const rendered = rs.hoisted(() => {
  const state: RenderedCard = {
    anchor: null,
    effects: [],
    fixture: null,
    load: rs.fn(),
    open: null,
    openUpdates: [],
    stateIndex: 0,
    toast: rs.fn(),
    trigger: null,
    unmount: null,
  };
  return state;
});

// Preserve React's real dispatcher and state values. Observe open updates made by
// the captured handlers; SSR cannot reproduce a browser's later state rerender.
rs.mock("react", () => ({
  ...actualReact,
  useEffect: (effect: EffectCallback, dependencies: DependencyList) => {
    rendered.effects.push(effect);
    actualReact.useEffect(effect, dependencies);
  },
  useState: <S,>(initial: S | (() => S)) => {
    const slot = rendered.stateIndex;
    rendered.stateIndex += 1;
    const [value, update] = actualReact.useState(initial);
    return [
      value,
      (next: SetStateAction<S>) => {
        if (slot === 0 && Schema.is(Schema.Boolean)(next)) {
          rendered.openUpdates.push(next);
        }
        update(next);
      },
    ] as const;
  },
}));

// The mock boundary captures only the component's own action contracts. It does
// not fabricate DOM events or duplicate the Popover's browser focus behavior.
rs.mock("@techsio/ui-kit/molecules/popover", () => ({
  Popover: Object.assign(
    ({ children, open }: PropsWithChildren<{ open: boolean }>) => {
      rendered.open = open;
      return children;
    },
    {
      Anchor: (props: PropsWithChildren<AnchorActions>) => {
        rendered.anchor = props;
        return props.children;
      },
      Content: ({ children }: PropsWithChildren) => children,
      Positioner: ({ children }: PropsWithChildren) => children,
      Trigger: (props: PropsWithChildren<TriggerActions>) => {
        rendered.trigger = props;
        return props.children;
      },
    },
  ),
}));
rs.mock("@techsio/ui-kit/atoms/link-button", () => ({
  LinkButton: ({ children }: PropsWithChildren) => children,
}));
rs.mock("@techsio/ui-kit/molecules/toast", () => ({
  useToast: () => ({ create: rendered.toast }),
}));
rs.mock("../src/ontos/card-variants-client", () => ({
  loadCardVariants: () => {
    rendered.load();
    if (rendered.fixture === null) {
      throw new Error("CardVariants read fixture was not installed");
    }
    return Deferred.await(rendered.fixture.response);
  },
}));
rs.mock("../src/ontos/client-runtime", () => ({
  clientRuntime: {
    runFork: (program: Effect.Effect<CardVariantsResult>) => {
      if (rendered.fixture === null) {
        throw new Error("CardVariants read fixture was not installed");
      }
      // The harness owns and has already forked this child. UI dispatch only
      // supplies its real program; no Effect runtime is started from the test.
      Deferred.doneUnsafe(rendered.fixture.request, Effect.succeed(program));
      return rendered.fixture.fiber;
    },
  },
}));

const product: ProductCardModel = {
  currency: "CZK",
  description: "",
  id: "owner",
  image: null,
  name: "Owner product",
  priceFrom: false,
  priceMinor: 100,
  sku: "OWNER",
  slug: "owner",
  stock: "available",
  variantCount: 3,
  variantPreview: [{ id: "first", name: "S" }],
};
const ready: CardVariantsResult = {
  productId: product.id,
  slug: product.slug,
  state: "ready",
  variants: [
    { id: "first", name: "S" },
    { id: "second", name: "M" },
    { id: "third", name: "L" },
  ],
};
const renderPendingCard = Effect.gen(function* renderCard() {
  const request = yield* Deferred.make<Effect.Effect<CardVariantsResult>>();
  const response = yield* Deferred.make<CardVariantsResult>();
  const fiber = yield* Deferred.await(request).pipe(Effect.flatten, Effect.forkChild);
  const fixture = { fiber, request, response };
  rendered.fixture = fixture;
  const html = renderToStaticMarkup(
    actualReact.createElement(CardVariants, { locale: "cs", product }),
  );
  expect(html).toContain('aria-busy="false"');
  expect(rendered.open).toBe(false);
  for (const effect of rendered.effects) {
    const cleanup = effect();
    if (cleanup !== undefined) {
      rendered.unmount = () => {
        cleanup();
      };
    }
  }
  if (rendered.anchor === null || rendered.trigger === null) {
    throw new Error("Missing rendered CardVariants handlers");
  }
  return { ...fixture, anchor: rendered.anchor, trigger: rendered.trigger };
});
const respond = (fixture: CardReadFixture, result: CardVariantsResult) =>
  Deferred.succeed(fixture.response, result).pipe(Effect.andThen(Fiber.join(fixture.fiber)));

beforeEach(() => {
  rendered.anchor = null;
  rendered.effects.length = 0;
  rendered.fixture = null;
  rendered.open = null;
  rendered.openUpdates.length = 0;
  rendered.stateIndex = 0;
  rendered.trigger = null;
  rendered.unmount = null;
  rs.clearAllMocks();
});
afterEach(() => {
  rendered.unmount?.();
});

describe("CardVariants rendered intent handlers", () => {
  it.effect("attaches Escape to the pending anchor and keeps a late result closed", () =>
    Effect.gen(function* pendingEscape() {
      const card = yield* renderPendingCard;
      card.trigger.onClick();
      expect(rendered.load).toHaveBeenCalledOnce();
      const event = { key: "Escape", preventDefault: rs.fn() };
      card.anchor.onKeyDown(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      card.anchor.onFocus();
      yield* respond(card, ready);
      expect(rendered.openUpdates).not.toContain(true);
      expect(rendered.load).toHaveBeenCalledOnce();
      expect(rendered.toast).not.toHaveBeenCalled();
    }),
  );

  it.effect("leaves other pending keys alone and opens the requested successful result", () =>
    Effect.gen(function* pendingArrow() {
      const card = yield* renderPendingCard;
      card.trigger.onClick();
      const event = { key: "ArrowDown", preventDefault: rs.fn() };
      card.anchor.onKeyDown(event);
      yield* respond(card, ready);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(rendered.openUpdates).toContain(true);
      expect(rendered.toast).not.toHaveBeenCalled();
    }),
  );

  it.effect("announces a failed explicit activation once", () =>
    Effect.gen(function* explicitFailure() {
      const card = yield* renderPendingCard;
      card.trigger.onClick();
      yield* respond(card, { state: "unavailable" });
      expect(rendered.toast).toHaveBeenCalledExactlyOnceWith({
        duration: 10_000,
        title: getDictionary("cs").variantsUnavailable,
        type: "error",
      });
      expect(rendered.openUpdates).not.toContain(true);
    }),
  );

  for (const source of ["onFocus", "onPointerEnter"] as const) {
    it.effect(`keeps failed passive ${source} previews quiet`, () =>
      Effect.gen(function* passiveFailure() {
        const card = yield* renderPendingCard;
        card.anchor[source]();
        yield* respond(card, { state: "unavailable" });
        expect(rendered.load).toHaveBeenCalledOnce();
        expect(rendered.toast).not.toHaveBeenCalled();
        expect(rendered.openUpdates).not.toContain(true);
      }),
    );
  }

  it.effect("does not announce a failed activation after its Escape cancellation", () =>
    Effect.gen(function* canceledFailure() {
      const card = yield* renderPendingCard;
      card.trigger.onClick();
      card.anchor.onKeyDown({ key: "Escape", preventDefault: () => {} });
      yield* respond(card, { state: "unavailable" });
      expect(rendered.toast).not.toHaveBeenCalled();
      expect(rendered.openUpdates).not.toContain(true);
    }),
  );

  it.effect("does not update or notify after the actual mount cleanup", () =>
    Effect.gen(function* unmountedCard() {
      const card = yield* renderPendingCard;
      card.trigger.onClick();
      rendered.unmount?.();
      rendered.openUpdates.length = 0;
      yield* respond(card, ready);
      expect(rendered.openUpdates).toEqual([]);
      expect(rendered.toast).not.toHaveBeenCalled();
    }),
  );
});
