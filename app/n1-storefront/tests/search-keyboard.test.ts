import { describe, expect, it } from "@rstest/core";
import { submitSearchOnEnter } from "../src/features/search-keyboard";

type SearchKeyEvent = Parameters<typeof submitSearchOnEnter>[0];

const keyboardEvent = (overrides: Partial<SearchKeyEvent> = {}) => {
  const state = { prevented: false, submissions: 0 };
  const event: SearchKeyEvent = {
    altKey: false,
    ctrlKey: false,
    currentTarget: {
      form: {
        requestSubmit: () => {
          state.submissions += 1;
        },
      },
      getAttribute: () => null,
    },
    get defaultPrevented() {
      return state.prevented;
    },
    key: "Enter",
    metaKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => {
      state.prevented = true;
    },
    shiftKey: false,
    ...overrides,
  };
  return { event, state };
};

describe("search input keyboard submission", () => {
  it("submits the existing form on unselected Enter and consumes the key before the combobox", () => {
    const { event, state } = keyboardEvent();
    submitSearchOnEnter(event);
    expect(state).toEqual({ prevented: true, submissions: 1 });
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps a highlighted product's Enter under native combobox navigation", () => {
    const { event, state } = keyboardEvent();
    event.currentTarget.getAttribute = () => "product-option";
    submitSearchOnEnter(event);
    expect(state).toEqual({ prevented: false, submissions: 0 });
  });

  it.each([{ isComposing: true }, { isComposing: false }])(
    "respects the native IME composition state: %j",
    (nativeEvent) => {
      const { event, state } = keyboardEvent({ nativeEvent });
      submitSearchOnEnter(event);
      expect(state).toEqual({
        prevented: !nativeEvent.isComposing,
        submissions: nativeEvent.isComposing ? 0 : 1,
      });
    },
  );

  it.each([{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }])(
    "leaves modified Enter unchanged: %j",
    (modifier) => {
      const { event, state } = keyboardEvent(modifier);
      submitSearchOnEnter(event);
      expect(state).toEqual({ prevented: false, submissions: 0 });
    },
  );

  it.each(["Escape", "ArrowDown", "ArrowUp", "Tab", "a"])("leaves %s unchanged", (key) => {
    const { event, state } = keyboardEvent({ key });
    submitSearchOnEnter(event);
    expect(state).toEqual({ prevented: false, submissions: 0 });
  });

  it("does not resubmit an already handled key", () => {
    const { event, state } = keyboardEvent({ defaultPrevented: true });
    submitSearchOnEnter(event);
    expect(state).toEqual({ prevented: false, submissions: 0 });
  });

  it("does not consume Enter outside a form", () => {
    const { event, state } = keyboardEvent();
    event.currentTarget.form = null;
    submitSearchOnEnter(event);
    expect(state).toEqual({ prevented: false, submissions: 0 });
  });
});
