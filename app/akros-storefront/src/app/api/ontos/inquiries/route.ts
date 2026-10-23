import "server-only";
import { createHash } from "node:crypto";
import { readProducts } from "@/ontos/catalog-server";
import { callAction, OntosError, readRecords } from "@/ontos/gateway";
import { guard, jsonBody, problem, RequestError } from "@/ontos/http";
import { inquiryTaskTitle, parseInquirySubmission } from "@/ontos/inquiry-model";

export async function POST(request: Request) {
  try {
    guard(request);
    const inquiry = parseInquirySubmission(await jsonBody(request));
    if (inquiry === null)
      throw new RequestError(
        400,
        "Zkontrolujte jméno, e-mail, předmět a zprávu (nejvýše 1 500 znaků).",
      );
    // Resolve product identity now: a stale browser label or a caller-supplied URL is never persisted.
    let product: { productId: string; productSlug: string; productName: string } | undefined;
    if (inquiry.productId !== undefined) {
      const page = await readProducts(
        { productIds: [inquiry.productId], pageSize: 1 },
        "card",
        true,
      );
      const record = page.products.find((item) => item.id === inquiry.productId);
      if (record === undefined)
        throw new RequestError(404, "Produkt již není v nabídce. Odešlete prosím obecný dotaz.");
      product = { productId: record.id, productSlug: record.slug, productName: record.name };
    }
    const command = {
      _tag: "CreateTask",
      title: inquiryTaskTitle(inquiry),
      description: [
        `Kontakt: ${inquiry.name} <${inquiry.email}>`,
        ...(product ? [`Produkt: ${product.productId}`] : []),
        "",
        inquiry.message,
      ].join("\n"),
      priority: "NORMAL",
      storefrontInquiry: { ...inquiry, ...product },
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = (await readRecords("work-tasks", "records", {})) as { revision: number };
      if (!Number.isSafeInteger(snapshot.revision))
        throw new Error("Task owner returned no revision");
      const payload = { command, expectedRevision: snapshot.revision };
      const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      try {
        const result = (await callAction(
          "work-tasks",
          "apply-command",
          payload,
          `akros-inquiry-${inquiry.requestId}-${digest}`,
        )) as { task?: { ref?: { resourceId?: string } } };
        const taskId = result.task?.ref?.resourceId;
        if (typeof taskId !== "string" || taskId === "")
          throw new Error("Task persistence was not confirmed");
        return Response.json({ taskId }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        // Only a definite optimistic-lock refusal is retried. Never repeat a command with an unknown outcome.
        if (
          error instanceof OntosError &&
          error.status === 409 &&
          error.code === "work_revision_conflict" &&
          attempt < 2
        )
          continue;
        throw error;
      }
    }
    throw new Error("Inquiry owner is busy");
  } catch (error) {
    if (error instanceof OntosError && error.status === 403) {
      console.error("[AKROS] Inquiry owner authorization denied");
      return Response.json(
        {
          message:
            "Kontaktní formulář je dočasně nedostupný. Dotaz nebyl odeslán. Napište nám prosím na akros@akros.cz nebo zavolejte na 737 591 849.",
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    return problem(
      error,
      "Přijetí dotazu se nepodařilo potvrdit. Údaje zachovejte a zkuste odeslání znovu.",
    );
  }
}
