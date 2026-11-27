"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";

import { NAVIGATION_START as START } from "@/components/navigation-start";
import { useDictionary } from "@/ontos/market-context";

const SLOW_MS = 12_000;

const isForm = (value: EventTarget | null): value is HTMLFormElement =>
  value !== null && HTMLFormElement.prototype.isPrototypeOf(value);

type Pending = { href?: string; slow: boolean } | null;

export function NavigationProgress() {
  const cs = useDictionary();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [state, setState] = useState<Pending>(null);

  useEffect(() => {
    const onStart = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      setState({ href: typeof detail === "string" ? detail : undefined, slow: false });
    };
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (event.defaultPrevented || !isForm(form) || form.method.toLowerCase() !== "get") return;
      setState({ href: form.action, slow: false });
    };
    const onPageShow = () => setState(null);
    window.addEventListener(START, onStart);
    window.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener(START, onStart);
      window.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  useEffect(() => setState(null), [pathname, search]);

  const pending = state !== null && !state.slow;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(
      () => setState((current) => (current ? { ...current, slow: true } : current)),
      SLOW_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pending, state]);

  if (!state) return null;
  return (
    <>
      <div
        role="progressbar"
        aria-label={cs.notifications.loading}
        data-route-progress=""
        className="pointer-events-none fixed inset-x-0 top-0 z-[1000] h-(--dimension-4) bg-(--color-primary) motion-safe:animate-pulse"
      />
      {state.slow && (
        <div
          role="alert"
          data-route-slow=""
          className="fixed inset-x-0 top-(--dimension-4) z-[1000] flex flex-wrap items-center justify-center gap-(--dimension-12) bg-(--color-fill-surface) p-(--dimension-12) shadow-md"
        >
          <strong>{cs.errorPages.unavailableTitle}</strong>
          <Button
            size="sm"
            onClick={() => window.location.assign(state.href ?? window.location.href)}
          >
            {cs.errorPages.retry}
          </Button>
        </div>
      )}
    </>
  );
}
