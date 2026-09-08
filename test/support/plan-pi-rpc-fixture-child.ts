const responseLine = `${JSON.stringify({ id: "probe-state", type: "response", command: "get_state", success: true, data: { ok: true } })}\n`;
const malformedResponseLine = `${JSON.stringify({ id: "probe-state", type: "response", command: "get_state", success: false, error: "primary RPC failure" })}\n`;
const extensionErrorLine = `${JSON.stringify({ type: "extension_error", extensionPath: "termination-extension.mjs", event: "session_start", error: "termination failure" })}\n`;
const modes = new Set([
  "environment",
  "graceful-exit",
  "spontaneous-exit",
  "extension-failure",
  "malformed-exit",
  "redaction",
  "flood",
  "late-primary",
]);

const mode = process.argv[2];
if (typeof mode !== "string" || !modes.has(mode)) {
  process.stderr.write("unsupported Plan RPC fixture mode\n", () => process.exit(2));
} else if (mode === "environment") {
  const data = {
    node: process.execPath,
    path: process.env["PATH"],
    home: process.env["HOME"] ?? null,
    secret: process.env["OPENAI_API_KEY"] ?? null,
    nodeOptions: process.env["NODE_OPTIONS"] ?? null,
    ambientPi: process.env["PI_AMBIENT_BAD"] ?? null,
  };
  process.stdout.write(`${JSON.stringify({ id: "probe-state", type: "response", command: "get_state", success: true, data })}\n`);
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else if (mode === "graceful-exit") {
  process.stdout.write(responseLine);
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else if (mode === "spontaneous-exit") {
  process.stdout.write(responseLine, () => process.exit(7));
} else if (mode === "extension-failure") {
  process.stdout.write(responseLine);
  process.stdin.resume();
  process.stdin.on("end", () => process.stdout.write(extensionErrorLine, () => process.exit(143)));
} else if (mode === "malformed-exit") {
  process.stdout.write(malformedResponseLine, () => process.exit(7));
} else if (mode === "redaction") {
  const secret = process.argv[3];
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 1024) process.exit(2);
  const hex = Buffer.from(secret, "utf8").toString("hex");
  const percent = encodeURIComponent(secret);
  const mixedCase = (value: string): string => [...value].map((character, index) => index % 2 === 0 ? character.toUpperCase() : character.toLowerCase()).join("");
  const forms = [secret, Buffer.from(secret, "utf8").toString("base64"), hex, percent, mixedCase(hex), mixedCase(percent)];
  const extensionLineForSecret = `${JSON.stringify({ type: "extension_error", extensionPath: "secret-extension.mjs", error: forms.join(" | ") })}\n`;
  process.stdout.write(responseLine, () => process.stdout.write(extensionLineForSecret, () => process.exit(7)));
} else if (mode === "flood") {
  const lines = 5_000;
  process.stdout.write(responseLine, () => {
    let index = 0;
    const write = (): void => {
      while (index < lines) {
        if (!process.stdout.write(`${JSON.stringify({ type: "extension_error", error: `flood-${index}-€` })}\n`)) {
          process.stdout.once("drain", write);
          return;
        }
        index += 1;
      }
      process.stderr.write("€".repeat(10_000), () => process.exit(7));
    };
    write();
  });
} else {
  const secondaryLines = Array.from({ length: 16 }, (_, index) => `${JSON.stringify({ type: "extension_error", error: `secondary-${index}-${"S".repeat(900)}` })}\n`).join("");
  const latePrimary = `${JSON.stringify({ id: "probe-state", type: "response", command: "get_state", success: false, error: "P".repeat(2_000) })}\n`;
  process.stdout.write(`${responseLine}${secondaryLines}${latePrimary}`, () => process.exit(7));
}
