# Private App Server turn mapping

`mapAppServerTurn` accepts caller-supplied installed-0.160.0 notification JSONL and explicitly selected thread and turn IDs. It is a bounded, pure adapter for the `agentMessage` subset: transport and projected output are limited to 1 MiB, and the input may contain at most 4096 frames. It reuses the project JSONL parser for UTF-8, duplicate-key, depth, and JSON checks.

Only a completed turn with a full matching item witness and one final answer can produce the private three-frame CLI-shaped projection. Commentary and deltas do not become final text. Thread token usage is validated but omitted because its total/last values are not exact per-turn CLI usage. Failure, interruption, local cancellation, malformed input, and missing terminal observations do not produce projected bytes. Returned status and reason values are fixed labels; arbitrary IDs, errors, paths, and messages are not included in them.

The projected bytes are adapter output. They are never evidence that `codex exec --json` emitted those bytes, and the module is not imported by a production runner or exported through the package API.
