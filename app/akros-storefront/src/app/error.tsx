"use client";
import { Unavailable } from "@/ontos/unavailable";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <Unavailable reset={reset} />;
}
