import { cardVariantsWeb } from "@/ontos/card-variants-http";

export const dynamic = "force-dynamic";
export const GET = async (request: Request) => await cardVariantsWeb.handler(request);
