import type { Ticket, TicketPort } from "./types.js";

interface LinearClientOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
}

export class LinearClient implements TicketPort {
  readonly #apiKey: string;
  readonly #endpoint: string;

  constructor(options: LinearClientOptions) {
    if (!options.apiKey) throw new Error("Linear API key is required");
    this.#apiKey = options.apiKey;
    this.#endpoint = options.endpoint ?? "https://api.linear.app/graphql";
  }

  async get(ticketId: string, signal?: AbortSignal): Promise<Ticket> {
    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers: { authorization: this.#apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        query: "query SquireIssue($id: String!) { issue(id: $id) { id identifier title description url } }",
        variables: { id: ticketId },
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Linear request failed with HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Linear returned malformed JSON");
    const root = payload as Record<string, unknown>;
    if (Array.isArray(root["errors"]) && root["errors"].length > 0) throw new Error("Linear rejected the issue lookup");
    const data = root["data"] as Record<string, unknown> | undefined;
    const issue = data?.["issue"] as Record<string, unknown> | null | undefined;
    if (!issue || issue["identifier"] !== ticketId || typeof issue["title"] !== "string") throw new Error(`Linear ticket not found: ${ticketId}`);
    return {
      id: ticketId,
      title: issue["title"],
      description: typeof issue["description"] === "string" ? issue["description"] : "",
      ...(typeof issue["url"] === "string" ? { url: issue["url"] } : {}),
    };
  }
}
