import { connect } from "node:net";

const [port, token] = process.argv.slice(2);
if (!/^[0-9]+$/.test(port ?? "") || !/^[a-f0-9]{64}$/.test(token ?? "")) throw new Error("invalid coordination arguments");
await Promise.all([
  new Promise((resolve, reject) => process.stdout.write("detached stdout inherited\n", error => error ? reject(error) : resolve())),
  new Promise((resolve, reject) => process.stderr.write("detached stderr inherited\n", error => error ? reject(error) : resolve())),
]);
const socket = connect({ host: "127.0.0.1", port: Number(port) });
// A watchdog is only a failure bound; it is never completion evidence.
const deadline = setTimeout(() => { process.exitCode = 2; socket.destroy(); }, 15000);
let buffer = "";
let released = false;
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`ready ${token} ${process.pid}\n`));
socket.on("data", data => {
  buffer += data;
  if (buffer.length > 512) { process.exitCode = 2; socket.destroy(); return; }
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!released && /^challenge [a-f0-9]{64}$/.test(line)) socket.write(`answer ${line.slice(10)}\n`);
    else if (!released && line === "release") { released = true; socket.end(); }
    else { process.exitCode = 2; socket.destroy(); }
  }
});
socket.on("error", () => { process.exitCode = 2; socket.destroy(); });
socket.on("end", () => socket.end());
socket.on("close", () => clearTimeout(deadline));
