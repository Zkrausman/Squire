# Materialize a synthetic stage fixture

Use the [synthetic envelope author](synthetic-project-envelope.md) to construct
an envelope from explicitly selected files. Then select its profile, a unique
operation ID (1–64 ASCII letters, digits, `_` or `-`), and a fresh absolute stage
directory whose parent already exists and meets the stage writer's ownership
rules:

```sh
node bin/squire-materialize-envelope.mjs standard fixture.json fixture-1 /absolute/private/fixture-stage
```

Use `large` for the existing large-project envelope and stage policies. There
is no fallback between profiles. The envelope path is relative to the working
directory unless absolute; it must select a bounded regular file, not a symbolic
link. The standard encoded envelope cap is 1 MiB and the large cap is 4 MiB;
all existing decoded size, classification and path limits still apply. A
65,537-byte SOURCE needs the large profile. No file is parsed as executable code.

The command uses the ordinary staging planner, writer and verifier, with the
fixed caller label `synthetic_stage_fixture`. The stage has a private 0700
root and 0400 files and manifest. Input files are not modified. On success the
command prints one JSON record on stdout, with these fields:

- `schema`: `SQUIRE_SYNTHETIC_STAGE_COPY_V1`
- `profile`: `standard` or `large`
- `copy_integrity`: `VERIFIED`
- `envelope_sha256`: digest of the exact selected encoded envelope bytes
- `stage_manifest_sha256`: digest of the verified stage manifest
- `file_count`, `total_bytes`: decoded staged file count and payload bytes

Keep the manifest digest separately to bind later copy verification, using the
existing matching-profile stage/export APIs. Stage verification checks the
inventory, paths and byte digests; it does not establish the origin of the
bytes. The synthetic copy record is **not** an admissible generation or project
candidate receipt, provider evidence, an admission token or a functional
acceptance result. This command provides no generation, candidate execution,
syntax check, provenance authentication or crash-durability guarantee.

The command exits 2 on rejection and returns no successful copy record. Invalid
payloads reject before stage creation. Existing destinations are not replaced.
If an I/O or verification failure occurs after exclusive destination creation,
a partial or complete unacknowledged stage can remain; quarantine that output
rather than reusing it. If stdout fails, treat the command as unacknowledged.

Run the dedicated offline suite with Node 24:

```sh
node --test --test-isolation=none test/materialize-envelope.test.mjs
```
