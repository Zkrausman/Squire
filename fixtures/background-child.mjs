import { closeSync, writeSync } from "node:fs";
import { connect } from "node:net";

const [port, token, mode = "normal"] = process.argv.slice(2);
if (!port || !token) throw new Error("control port and token are required");
// Never create stdout/stderr streams: no buffered writes may survive the ack.
writeSync(1, "detached stdout inherited\n");
writeSync(2, "detached stderr inherited\n");
let closed = false;
function closeLogs() {
  if (closed) return true;
  let success = true;
  for (const fd of [1, 2]) {
    try { closeSync(fd); } catch { success = false; }
  }
  closed = true;
  return success;
}
const socket = connect({ host: "127.0.0.1", port: Number(port) });
// This is a failure deadline, not test coordination or a cleanup retry.
const deadline = setTimeout(() => stop(2), 15_000);
function stop(code) {
  closeLogs();
  clearTimeout(deadline);
  socket.destroy();
  process.exitCode = code;
}
socket.on("error", () => stop(2));
socket.on("close", () => { closeLogs(); clearTimeout(deadline); });
socket.on("connect", () => {
  socket.write(`${JSON.stringify({ token, type: "ready", pid: process.pid })}\n`);
});
let input = "";
socket.on("data", chunk => {
  input += chunk.toString();
  if (input.length > 4096) return stop(2);
  const end = input.indexOf("\n");
  if (end < 0) return;
  let message;
  try { message = JSON.parse(input.slice(0, end)); } catch { return stop(2); }
  input = input.slice(end + 1);
  if (message.token !== token || message.type !== "release") return stop(2);
  if (mode === "stall") return; // negative test: intentionally withhold closure
  if (!closeLogs()) return stop(2);
  clearTimeout(deadline);
  // This independent socket is the last output. No fixture filesystem access
  // (including completion markers) is permitted after closing the logs.
  socket.end(`${JSON.stringify({ token, type: "logs-closed", pid: process.pid })}\n`);
});
