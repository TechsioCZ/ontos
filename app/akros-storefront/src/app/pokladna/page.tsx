import { redirect } from "next/navigation";
import { marketHref } from "@/ontos/active-market";
export default async function CheckoutPage() {
  redirect(await marketHref("/kosik/doprava-platba"));
}
