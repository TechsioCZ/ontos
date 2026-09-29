import type { Metadata } from "next";
import { ReviewStep } from "@/features/checkout/review-step";
export const metadata: Metadata = { title: "Shrnutí objednávky" };
export default function ReviewPage() {
  return <ReviewStep />;
}
