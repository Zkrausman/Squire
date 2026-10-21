# Source-only GJS/GTK4 desktop profile

`desktop-gjs-gtk4` is an additive candidate generation target. It permits platform
GJS/GTK4 APIs in a returned multifile envelope; no desktop application is run.
The reviewed contract identity is
`cabc6f039c42f1b19ac7d61415a199fd4717fb25251f90a3702808b09a7c64a7`.
Suitability is an engineering inference from public API documentation and
installation metadata, not ABI/loading, rendering, input, custody or benchmark
qualification. Squire uses Codex; Gemini remains Lore research/review only.

The chosen native surface is GJS ESM plus GTK4, with `Gtk.DrawingArea`/Cairo,
key/motion/click event controllers and widget tick callbacks. These APIs allow
an autonomous small game design without selecting its mechanics. GTK4 uses
`set_draw_func` for custom drawing; drawing callbacks must not mutate layout or
widget properties. Key-pressed returns a propagation boolean; key-released is
void. Documentation references: [DrawingArea](https://docs.gtk.org/gtk4/class.DrawingArea.html),
[key signals](https://docs.gtk.org/gtk4/class.EventControllerKey.html),
[tick callback](https://docs.gtk.org/gtk4/method.Widget.add_tick_callback.html),
and [GJS modules](https://gjs.guide/extensions/development/imports-and-modules.html).
Those primary-document API facts were supplied through Lore's independently
reviewed source notes. This source lane performed no GJS invocation or GUI test.

No WebKit, ambient browser, Electron, npm/pip packages or downloads are added.
The brief's perspective, rules, controls, visual design and ticket decomposition
remain autonomous. The prefix phrase "without external dependencies" means no
additional package-manager dependencies beyond selected GJS/GTK4 platform APIs;
it does not mean system dependency freedom. GJS/GTK rely on native libraries,
whose dependency closure and resolution remain unverified. GJS supplies no OS
sandbox. Codex's read-only permission mode is not an application sandbox; no
supported application sandbox may be disabled to obtain qualification.

`validateProjectRequest` accepts only `node24-esm` or `desktop-gjs-gtk4`. The
existing closed request schema and file-envelope schema remain unchanged.
`buildProjectCodegenPrompt` selects an exact prefix by that explicit target:

- Node:1030 bytes, SHA256
  `9b213319932227f2a9c46c8dfe7b666f188beb4c5d1d2e18fbd2f52b3aca455e`.
- Desktop:1075 bytes, SHA256
  `6757b78f69af53b686ee1a0c09060ab1fcaad040ddc7d26639eafd46f9b3ca49`.

Desktop task instructions are1–31693 UTF8 bytes; total stdin stays at32768.
Node's1–31738 instructions and exact existing prefix stay unchanged. The shared
private JSONL collector, envelope parser, class/count/storage caps and physical
PR176 staging rules are unchanged. Desktop source files are opaque bytes:
parsing and hashing do not prove GJS syntax, supported imports, safety or gameplay.
Generated source/logs/frames never become observed evidence by classification.

New project spec/config fields are additive. Missing `runtime_target` in the
legacy spec/config means Node, never desktop inferred from prompt contents.
Desktop requires explicit `runtime_target`, the matching prefix identity in
config, and a closed prospective `desktop_runtime_identity`. Node preparation
omits these new fields; no historical request is silently retargeted. New source
pins include `src/desktop-profile.mjs` and the actual current import closure.
Prompt/config/source/manifest hashes must be refreshed for any future admitted
operation; old preparations remain historical and cannot be silently rebound.

The private desktop identity is:

```
{status: 'NOT_QUALIFIED',
 executable: {path, bytes, sha256},
 typelibs: [{namespace, version, typelib, bytes, sha256}],
 libraries: [{name, path, bytes, sha256}]}
```

All fields are explicit caller inputs; public code supplies no installed GJS
path, hash or production model default. Typelibs/libraries are bounded to8/16,
with nonempty distinct identities and Gtk version4.0 required. This validates
representation only, not sufficiency or actual resolution. Directory search
paths are not pin evidence. Status must remain NOT_QUALIFIED; extra admission
fields, duplicate namespaces/paths, getters and proxies reject. Validation owns
and freezes data copies before an asynchronous boundary.

Three identities stay distinct: the existing Node host identity is referenced
through `NODE_RUNTIME`; the Codex launcher uses the existing explicit CLI pin and
supported authorization/permission tuple; the prospective GJS executable belongs
only to the desktop identity. It must never be the executable passed to the
Codex generation runner. None of these identities proves full descendant custody.

Desktop preparation and the direct project runner require explicit
`SOURCE_SIMULATION` fake ports. Preparation compares a fake
`observeDesktopRuntimeIdentity()` result with the explicit private input,
then freezes the target/prefix/runtime identity into config and manifest.
It returns PREPARED_NOT_EXECUTABLE. The normal native admission function rejects
all desktop configs before consuming an operation or dispatching anything.
The Blackjack entrypoint remains byte-identical and always DRY_RUN_NATIVE_DISABLED;
there is no real desktop activation shape. SOURCE_SIMULATION is a testing
convention, not authenticated permission or containment against arbitrary caller
functions. No production Codex desktop adapter or GJS launcher is wired here.

The Blackjack controller optionally accepts the explicit desktop target and
observes its prospective identity only through injected fake ports. Its source
input lineage is the nine immutable PR178 public inputs. Legacy Node retains the
original13 PR177 API-reference pins and unchanged BLACKJACK_BASE. Explicit
desktop specs bind DESKTOP_BASE (PR178 commit
`8e429d99f02b445386e49f27024ae5b09c338501`, tree
`37242b90610aaad0d0e05b0592111f7e4839b9c1`) to match those9 reference pins;
adding a target to an old-base spec does not silently rebind its lineage. Public frozen `.txt` fixtures allow tests
to verify those historical inputs after current source files change. They are
never imported, executed, or represented as active runtime qualification. This
avoids rewriting historical hashes or embedding recursive self-hash claims.

Interpretation must still be host-persisted and both wire/receipt reverified
before a candidate call. One original deadline includes the30-second reserve;
120s generation/140s per-call observation, nonrefunding counters, singular active
reservation and permanent failure remain intact. Candidate envelope, stage ACK,
observed evidence and export ACK remain distinct. Fake desktop tests establish
source wiring only. Candidate/export outcomes remain NOT_EVALUATED and false
runtime/operator admission; native logic/GUI/grading reject permanently.

The next real gates remain: actual pinned GJS/typelib/library qualification,
owned display/input/app-only capture, all-owned process custody/control/lifetime,
private grader read isolation, offline behavior, fresh Codex allowance/permissions
and exact new operation admission. Existing metadata at checked paths is not
whole-host availability or absence proof. No launch, install, probe, benchmark,
security/access change, old retry or hill climbing is authorized by this source
delivery; Q219 and all other historical unknown/access/no-rerun holds remain.
