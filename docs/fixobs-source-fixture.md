# Trusted geometric fixture — source only

FIXOBS is a non-game evaluator fixture, separate from Blackjack and its unchanged
brief/rubric. The accepted source specification is SHA-256
`be92d4b36b632152e3a4bf9f83e004a241ca6912b361e5766ced8898f836f10b`;
independent Gemini review is `8f14f41f30ff119443a4ebfab8f2b87784013fd418118a768e5f0f0066af607e`.
Owner approval covers source, synthetic tests, independent code/privacy review and
ordinary PR/CI/merge. It grants no launch, installation or qualification operation.

`fixtures/fixobs/fixture.mjs` is unlaunched GJS/GTK4 source with an explicit
`createFixobsWindow(application)` factory. A future qualified launcher must own
GTK initialization, application lifetime and presenting the window. None is
supplied here. The module has no top-level window, main loop, timer, observer,
capture, supervisor, model call, ACK socket or output logging. Node tests never
import it, run GJS, check GJS syntax natively or launch children.

The undecorated, nonresizable canvas requests 1280x720 at scale1. Drawing at wrong
dimensions produces only background, with no scaling/cropping fallback. Runtime
size, scale, rendering, focus and toolkit/API compatibility remain unqualified.
Background is opaque RGB(30,30,30); the 200x200 mark is [540,740)x[260,460).
Initial S0 is gray(128,128,128); Space key down changes S0 to S1 blue(0,0,255);
Button1 down inside the mark changes S1 to S2 green(0,255,0). The reference click
is (640,360). Releases, repeats, duplicates, wrong keys/buttons, out-of-order
clicks and outside clicks are no-ops. Only actual state changes queue a redraw.
There is no text, animation, automatic transition or periodic redraw.

`src/fixobs-state.mjs` contains shared portable geometry and the pure transition.
`evaluateFixobsFrame(stage, bytes, previousBytes)` in `src/fixobs.mjs` accepts
only exact, nonshared Uint8Array canonical RGBA8: 1280x720, stride5120,
3,686,400 bytes, alpha255 everywhere. No raw display normalization is supplied.
Every pixel/channel in the 160x160 core [560,720)x[280,440) must be within5 of
its target. Every baseline pixel outside the mark must be within3 of30; later
background channels may drift at most2 from their immediate previous frame.
The edge ring's RGB is excluded, but its alpha is not. Each post-action frame
must differ from its predecessor. No averages, alternate channel order,
interpolation, crop, resize or tolerance widening is accepted. Missing, stale,
malformed or mismatching buffers yield UNKNOWN rather than an inferred input
failure, false ACK or product failure. Direct predicate use is conditional on
supplied prior buffers; the sequence model enforces the accepted prior chain.

`createFixobsObservation(t0_ms)` is an in-memory source model, not an executable
supervisor. Its `reserveLaunch`, `reserveAction`, `acceptCandidate`, `poll`,
`stop` and `snapshot` methods take explicit monotonic millisecond observations.
Reservations model prospective ceilings; they do not dispatch or attest events.
Actions are exactly SPACE_STROKE and BUTTON1_CENTER_STROKE, each denoting one
press/release stroke. No more than1 launch,1 key,1 click or3 candidate attempts
can be reserved. There are no retries or default/native ports. The model retains
only an owned copy of the last accepted candidate and drops it on first stop;
snapshots contain no pixel content, arbitrary errors, event strings or paths.
No real capture retention or export authority is added.

All phases share T0: baseline including bootstrap and validation ends by T0+10s;
post-key by min(T0+18s,baseline-completion+8s); post-click by
min(T0+26s,key-completion+8s). `acceptCandidate` takes an explicit validation
completion time as well as capture time, so validation overhead is not refunded.
The active ceiling is T0+30s; its final4s margin is not another sample interval.
UNKNOWN stops later actions/captures; untouched frame slots remain NOT_RUN.
The first observed stop is permanent and sets cleanup deadline
min(T0+60s,first-stop+30s). Unused active time never augments cleanup. A late
clock report records lateness, not fictitious timely termination. Polling is
caller-driven: this model cannot stop a process or enforce wall time while idle.

`BUFFER_SEQUENCE_MATCH` means only three supplied buffers met the finite
predicates under the modeled order/budget. It is never app/window attribution,
input transport acceptance, causality, presentation completion, native loading,
GTK health, safety, benchmark PASS or cleanup proof. Runtime admission and
qualified observation remain false; cleanup remains UNKNOWN even when its
observation window elapses. There is no cleanup ACK or reusable workspace grant.
The inclusive eight-process ceiling is preserved as a future requirement, not
implemented by this pure model. Identity-safe bootstrap/control/full settlement,
FD/helper ownership, private display/window attribution, input/capture tooling
and host support remain separate unresolved operational prerequisites. Benchmark
private-grader isolation is separate from this trusted public fixture.

Tests use synthetic public pixels and explicit clock values only. They do not
qualify rendering or any host route, relax previous denials/unknowns/Q219 or
change existing Node/desktop profiles, process-control code or benchmark scoring.
The original unaccepted review/drafts are not acceptance inputs. A separately
reported three-byte mismatch in a nonauthoritative historical review snapshot
is not represented as byte-perfect preservation; it does not affect the accepted
final contract/review identities above or the original author/input artifacts.
