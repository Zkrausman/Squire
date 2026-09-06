import { LinearClient } from "@linear/sdk";
import type { LinearClient as LinearClientType } from "@linear/sdk";
import type { LinearIssueClient, LinearIssueObservation } from "./domain.js";
import { IntakeValidationError } from "./domain.js";

/** Official SDK adapter.  The SDK object is projected immediately into a
 * bounded plain observation; class instances and display names never cross
 * the intake authority boundary. */
export class LinearSdkIssueClient implements LinearIssueClient {
  readonly #client: LinearClientType;
  readonly #maxDescription: number;
  constructor(client: LinearClientType | string, options: { readonly maxDescription?: number } = {}) { if (typeof client === "string") { if (client.length < 1 || client.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(client)) throw new IntakeValidationError("Linear API key is invalid"); this.#client = new LinearClient({ apiKey: client }); } else if (!client || typeof client.issue !== "function") throw new IntakeValidationError("official Linear client is required"); else this.#client = client; this.#maxDescription = options.maxDescription ?? 1_000_000; if (!Number.isSafeInteger(this.#maxDescription) || this.#maxDescription < 1 || this.#maxDescription > 16 * 1024 * 1024) throw new IntakeValidationError("Linear description bound is invalid"); }
  async fetchIssue(issueId: string): Promise<LinearIssueObservation> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(issueId)) throw new IntakeValidationError("Linear issue UUID is invalid");
    // `issue(id)` is the SDK's scalar UUID lookup.  No search, pagination, or
    // title/label selector is used.
    let issue: unknown;
    try { issue = await this.#client.issue(issueId); } catch { throw new IntakeValidationError("Linear issue lookup failed"); }
    if (!issue || typeof issue !== "object") throw new IntakeValidationError("Linear returned no issue");
    const projected = issue as unknown as Record<string, unknown>;
    const team = await resolve(projected["team"]);
    const state = await resolve(projected["state"]);
    let labelsValue: unknown;
    try { labelsValue = typeof projected["labels"] === "function" ? await (projected["labels"] as () => Promise<unknown>)() : await resolve(projected["labels"]); } catch (error) { if (error instanceof IntakeValidationError) throw error; throw new IntakeValidationError("Linear label lookup failed"); }
    const labels = projectLabels(labelsValue);
    const description = typeof projected["description"] === "string" ? projected["description"] : "";
    if (description.length > this.#maxDescription) throw new IntakeValidationError("Linear description exceeds the configured bound");
    const id = stringField(projected["id"], "Linear issue ID");
    const identifier = stringField(projected["identifier"], "Linear issue identifier");
    const teamId = stringField(team && typeof team === "object" ? (team as Record<string, unknown>)["id"] : undefined, "Linear team ID");
    const stateId = stringField(state && typeof state === "object" ? (state as Record<string, unknown>)["id"] : undefined, "Linear state ID");
    const title = stringField(projected["title"], "Linear issue title");
    const url = stringField(projected["url"], "Linear issue URL");
    const acceptance = Array.isArray(projected["acceptanceCriteria"]) ? (() => { const values = projected["acceptanceCriteria"] as unknown[]; if (values.some(entry => typeof entry !== "string")) throw new IntakeValidationError("Linear acceptance criteria contains a non-string item"); return values as string[]; })() : parseAcceptanceCriteria(description);
    return { id, identifier, teamId, stateId, title, description, acceptanceCriteria: acceptance, labels, url };
  }
}
export const OfficialLinearClientAdapter = LinearSdkIssueClient;
export const LinearIssueClientAdapter = LinearSdkIssueClient;
export function createLinearIssueClient(apiKey: string, options: { readonly maxDescription?: number } = {}): LinearSdkIssueClient { return new LinearSdkIssueClient(apiKey, options); }

async function resolve(value: unknown): Promise<unknown> { try { if (value && typeof value === "object" && "then" in value && typeof (value as PromiseLike<unknown>).then === "function") return await value as unknown; return value; } catch { throw new IntakeValidationError("Linear related-object lookup failed"); } }
function projectLabels(value: unknown): Array<{ name: string }> {
  const connection = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const pageInfo = connection?.["pageInfo"];
  if (pageInfo && typeof pageInfo === "object" && (pageInfo as Record<string, unknown>)["hasNextPage"] === true) throw new IntakeValidationError("Linear label inventory is incomplete");
  const values: unknown[] = Array.isArray(value) ? value : connection && Array.isArray(connection["nodes"]) ? connection["nodes"] as unknown[] : (() => { throw new IntakeValidationError("Linear label inventory is not a bounded connection"); })();
  return values.map((item: unknown) => { const object = item && typeof item === "object" ? item as Record<string, unknown> : {}; return { name: typeof object["name"] === "string" ? object["name"] as string : "" }; });
}
function parseAcceptanceCriteria(description: string): string[] { const marker = /(?:^|\n)#{1,6}\s*acceptance criteria\s*\n([\s\S]*)$/iu; const match = marker.exec(description); if (!match?.[1]) return []; return match[1].split(/\r?\n/u).map(line => line.replace(/^\s*[-*]\s+/u, "").trim()).filter(Boolean); }
function stringField(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 1_000_000 || /[\u0000-\u001f\u007f]/u.test(value)) throw new IntakeValidationError(`${label} is invalid`); return value; }
