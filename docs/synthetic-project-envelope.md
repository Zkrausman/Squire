# Author a synthetic project envelope

Select a profile, a fresh output filename, and one or more synthetic files.
For each file, give its local filename, its path in the project, its class
(`SOURCE`, `DOC` or `LOCAL_ASSET`) and its wire encoding (`utf-8` or `base64`).
Relative local filenames and the output filename resolve from the working directory.

```sh
node bin/squire-author-envelope.mjs standard fixture.json \
  --file samples/module.txt src/main.mjs SOURCE utf-8 \
  --file samples/notes.txt README.md DOC utf-8 \
  --file samples/pixels.bin assets/pixels.bin LOCAL_ASSET base64
node bin/squire-envelope-inspect.mjs standard fixture.json
```

Use `large` to select the large payload limits. Each declaration selects a
bounded regular file and contributes one entry, in order. Source is read as
data. Use base64 for arbitrary bytes. The selected [payload policy](project-candidates.md)
checks paths, classifications, decoded sizes and the complete serialized envelope,
including JSON escaping and base64 expansion. Before writing, the authoring
command compares each decoded entry with its original bytes.

The command creates the output exclusively with mode 0600, subject to the
process umask. It prints `SYNTHETIC_ENVELOPE_WRITTEN` on success and exits
with status 2 on rejection. The resulting JSON contains the fixture contents.
