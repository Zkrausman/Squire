import { appendFile, access, writeFile } from "node:fs/promises";
import { PersonalMvpController } from "../dist/src/personal/controller.js";
import { JsonRunStateStore } from "../dist/src/personal/json-run-state.js";

const [directory, runId, digest, readyPath, releasePath, sideEffectsPath, resultPath] = process.argv.slice(2);
const backing = new JsonRunStateStore(directory);
const states = {
  create: state => backing.create(state),
  save: state => backing.save(state),
  findActive: ticketId => backing.findActive(ticketId),
  reserve: state => backing.reserve(state),
  release: (ticketId, owner) => backing.release(ticketId, owner),
  findByTicket: ticketId => backing.findByTicket(ticketId),
  reservationOwner: ticketId => backing.reservationOwner(ticketId),
  async read(identity) {
    const state = await backing.read(identity);
    await writeFile(readyPath, "ready\n", "utf8");
    for (;;) {
      try { await access(releasePath); break; }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    return state;
  },
};
const request = {
  ticketId: "AIDEV-1",
  repository: "example/repo",
  repositoryPath: "/tmp/example-repo",
  sourceRef: "HEAD",
  baseBranch: "main",
};
const controller = new PersonalMvpController({
  states,
  tickets: { async get() {
    await appendFile(sideEffectsPath, "ticket\n", "utf8");
    return { id: "AIDEV-1", title: "Claim race", description: "" };
  } },
  workspaces: { async prepare() {
    await appendFile(sideEffectsPath, "workspace\n", "utf8");
    throw new Error("stop after workspace side effect");
  } },
  phases: {},
  publication: {},
});

try {
  await controller.runReserved(request, runId, digest);
  await writeFile(resultPath, "completed\n", "utf8");
  process.exitCode = 0;
} catch (error) {
  await writeFile(resultPath, `${error instanceof Error ? error.message : String(error)}\n`, "utf8");
  process.exitCode = 2;
}
