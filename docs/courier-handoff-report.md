# Courier handoff report

`src/courier-handoff-report.mjs` turns a caller-supplied saved request and its
matching observations into a readable offline report. It does not read the
referenced artifacts or execute the private command.

## API

```js
import {buildCourierHandoffReport} from 'squire/courier-handoff-report';

const report = buildCourierHandoffReport({
  schema: 'SQUIRE3_COURIER_HANDOFF_REPORT_V1',
  request: savedRequest,
  observations: savedObservations
});
```

The input envelope has exactly `schema`, `request`, and `observations`.
`request` and `observations` use the unchanged
`squire3.courier_handoff_request.v1` and
`squire3.courier_handoff_observations.v1` profiles. Their digests must match.
The API also accepts UTF-8 JSON bytes and uses the existing bounded JSON
parser. It rejects unknown fields, duplicate decoded JSON keys, accessors,
proxies, cycles, symbols, malformed Unicode, and invalid PR188 metadata with
the constant `CourierHandoffReportError` code and message `INVALID_INPUT`.

The API prepares and assesses the supplied records with the existing
`prepareCourierHandoff` and `assessCourierHandoff` functions. The returned
`SQUIRE3_COURIER_HANDOFF_REPORT_OUTPUT_V1` has:

- `assessment`: the unchanged, deep-frozen safe assessment;
- `terminal_text`: deterministic ASCII and LF report text, no more than
  8,192 UTF-8 bytes.

The report is generated only from that fresh safe assessment. It does not
accept a caller-supplied assessment or expose a formatter that could be passed
a forged summary. It omits commands, paths, reference IDs, raw labels, and
error text. Digests can still correlate metadata. Coverage, context, custody,
settlement, denial, and quota values remain supplied claims; this report does
not verify referenced bytes or infer a primary blockage.

Unknown, missing, empty, zero, and unreported states remain distinct. A
complete capture, exit code zero, exact read claims, or successful tool claim
does not establish semantic correctness or review acceptance. Runtime
admission remains false; task correctness remains `NOT_EVALUATED`; execution
permission and external review acceptance, delivery, merge, installation, and
use remain external and unassessed. Replay is not supported.

The existing PR188 intake and projection limits remain in force. The saved
input cap is 262,144 bytes; the report cap is 8,192 UTF-8 bytes. The report
does not retain input or create a receipt.

## CLI

The existing command accepts one explicit saved receipt path:

```sh
node bin/squire-report.mjs /path/to/private-handoff-receipt.json
```

The CLI reuses the existing no-follow bounded reader. For the handoff-report
schema it writes `terminal_text` and exits with status `1`, including when the
supplied metadata reports exit code zero and complete capture. Invalid
handoff input exits `2` with the fixed `INVALID_INPUT` diagnostic and never
falls through to a legacy report route. Usage, parse, and read errors keep
finite diagnostics. Existing campaign, single-JavaScript, and project routes
retain their formatters and exit behavior.

The caller controls the private receipt path, retention, and access. There is
no discovery, directory walk, write, watch, export, launcher, recovery, replay,
or native execution authority in this adapter.
