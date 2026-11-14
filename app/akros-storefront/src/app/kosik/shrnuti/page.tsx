import type { Metadata } from "next";
import { getDictionary } from "@/ontos/active-market";
import { ReviewStep } from "@/features/checkout/review-step";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).checkout.steps.summary };
}
export default function ReviewPage() {
  return <ReviewStep />;
}
