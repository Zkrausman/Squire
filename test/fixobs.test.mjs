import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FIXOBS, FIXOBS_CONTRACT, advanceFixobsState, inFixobsMark,
  evaluateFixobsFrame, createFixobsObservation} from '../src/fixobs.mjs';

// Synthetic public pixels only. This helper is not a capture/backend default.
function frame(state = 'S0', background = 30) {
  const bytes = new Uint8Array(FIXOBS.bytes), color = FIXOBS.colors[state];
  for (let y = 0, o = 0; y < 720; y++) for (let x = 0; x < 1280; x++, o += 4) {
    const mark = x >= 540 && x < 740 && y >= 260 && y < 460;
    bytes[o] = mark ? color[0] : background;
    bytes[o + 1] = mark ? color[1] : background;
    bytes[o + 2] = mark ? color[2] : background; bytes[o + 3] = 255;
  }
  return bytes;
}
const put = (b, x, y, c, value) => { b[(y * 1280 + x) * 4 + c] = value; };
const space = {type: 'KEY_DOWN', key: 'Space', repeat: false};
const click = {type: 'BUTTON_DOWN', button: 1, x: 640, y: 360};
const start = (t0 = 1000) => { const run = createFixobsObservation(t0); run.reserveLaunch(t0); return run; };
function toKey(run, time = 1000) { return run.acceptCandidate(frame(), time); }
function toClick(run, time = 2000) { run.reserveAction('SPACE_STROKE', time); return run.acceptCandidate(frame('S1'), time); }

test('FIXOBS exact accepted immutable geometry and source boundary', () => {
  assert.equal(FIXOBS.width * FIXOBS.height * 4, 3686400);
  assert.equal(FIXOBS.stride, 5120); assert.equal(FIXOBS.scale, 1);
  assert.deepEqual(FIXOBS.core, {left:560,right:720,top:280,bottom:440});
  assert.equal(FIXOBS_CONTRACT.sha256, 'be92d4b36b632152e3a4bf9f83e004a241ca6912b361e5766ced8898f836f10b');
  assert.equal(FIXOBS_CONTRACT.runtime_admitted, false);
  assert.throws(() => { FIXOBS.colors.S0[0] = 0; });
});
test('only ordered Space down then Button1 down change fixture state', () => {
  assert.equal(advanceFixobsState('S0', click), 'S0');
  assert.equal(advanceFixobsState('S0', space), 'S1');
  assert.equal(advanceFixobsState('S1', space), 'S1');
  assert.equal(advanceFixobsState('S1', click), 'S2');
  assert.equal(advanceFixobsState('S2', click), 'S2');
  assert.equal(advanceFixobsState('S2', space), 'S2');
});
for (const [label, event] of [
  ['release', {type:'KEY_UP',key:'Space',repeat:false}],
  ['repeat', {...space,repeat:true}], ['wrong key', {...space,key:'Return'}],
  ['wrong button', {...click,button:2}], ['button release', {...click,type:'BUTTON_UP'}],
  ['extra field', {...space,extra:true}], ['missing repeat', {type:'KEY_DOWN',key:'Space'}],
]) test(`fixture no-op: ${label}`, () => {
  assert.equal(advanceFixobsState('S0', event), 'S0');
  assert.equal(advanceFixobsState('S1', event), 'S1');
});
test('mark hit test uses half-open bounds with finite coordinates', () => {
  for (const [x,y] of [[540,260],[739.99,459.99],[640,360]]) assert.equal(inFixobsMark(x,y), true);
  for (const [x,y] of [[539,360],[740,360],[640,259],[640,460],[NaN,360],[640,Infinity]]) {
    assert.equal(inFixobsMark(x,y), false);
    assert.equal(advanceFixobsState('S1', {...click,x,y}), 'S1');
  }
});
test('getter/throwing proxy event is no-op without exposing content', () => {
  let calls = 0;
  const event = {type:'KEY_DOWN',key:'Space',get repeat(){calls++;throw Error('private');}};
  assert.equal(advanceFixobsState('S0', event), 'S0'); assert.equal(calls,0);
  assert.equal(advanceFixobsState('S0', new Proxy({}, {getOwnPropertyDescriptor(){throw Error('private');},ownKeys(){throw Error('private');}})), 'S0');
});
test('three exact synthetic frames satisfy finite predicates only', () => {
  const a=frame(),b=frame('S1'),c=frame('S2');
  for (const [s,x,p] of [['S0',a,null],['S1',b,a],['S2',c,b]]) {
    const r=evaluateFixobsFrame(s,x,p);assert.equal(r.predicate,'MATCH');
    assert.equal(r.qualified_observation,false);assert.equal(r.runtime_admitted,false);
  }
});
test('core tolerance is per pixel/channel, inclusive +/-5', () => {
  const b=frame();put(b,560,280,0,123);put(b,719,439,2,133);
  assert.equal(evaluateFixobsFrame('S0',b).predicate,'MATCH');
  put(b,719,439,2,134);
  assert.equal(evaluateFixobsFrame('S0',b).reason,'CORE_MISMATCH');
});
test('baseline background tolerance inclusive +/-3, no averaging', () => {
  const b=frame();put(b,0,0,0,27);put(b,1279,719,2,33);
  assert.equal(evaluateFixobsFrame('S0',b).predicate,'MATCH');
  put(b,1279,719,2,34);
  assert.equal(evaluateFixobsFrame('S0',b).reason,'BACKGROUND_MISMATCH');
});
test('post-action background drift inclusive2 is relative to immediate prior', () => {
  const a=frame('S0',33),b=frame('S1',35),c=frame('S2',37);
  assert.equal(evaluateFixobsFrame('S1',b,a).predicate,'MATCH');
  assert.equal(evaluateFixobsFrame('S2',c,b).predicate,'MATCH');
  put(b,0,0,1,36);assert.equal(evaluateFixobsFrame('S1',b,a).reason,'BACKGROUND_DRIFT');
});
test('edge ring RGB is excluded but alpha is checked everywhere', () => {
  const b=frame();put(b,540,260,0,255);put(b,739,459,1,0);
  assert.equal(evaluateFixobsFrame('S0',b).predicate,'MATCH');
  for (const [x,y] of [[540,260],[560,280],[0,0],[1279,719]]) {
    const c=b.slice();put(c,x,y,3,254);
    assert.equal(evaluateFixobsFrame('S0',c).reason,'NONOPAQUE_PIXEL');
  }
});
test('stale/preexisting/wrong surface and missing frames remain UNKNOWN', () => {
  const a=frame(),b=frame('S1');
  assert.equal(evaluateFixobsFrame('S1',a,a).predicate,'UNKNOWN');
  assert.equal(evaluateFixobsFrame('S0',b).predicate,'UNKNOWN');
  assert.equal(evaluateFixobsFrame('S1',b,null).reason,'MISSING_PREVIOUS_BUFFER');
  assert.equal(evaluateFixobsFrame('S1',b,b).reason,'PREVIOUS_PREDICATE_MISMATCH');
  assert.equal(evaluateFixobsFrame('S0',null).predicate,'UNKNOWN');
});
test('no crop/resize/stride/byteorder fallback and no guessed prior', () => {
  const a=frame();
  for (const b of [a.subarray(1),new Uint8Array(a.length+4),new Uint16Array(a.buffer),
    Buffer.from(a),new Uint8Array(new SharedArrayBuffer(a.length)),new Proxy(a,{})]) {
    assert.equal(evaluateFixobsFrame('S0',b).reason,'INVALID_CANONICAL_BUFFER');
  }
  assert.equal(evaluateFixobsFrame('S3',a).reason,'INVALID_STAGE');
  const abgr=a.slice();for(let i=0;i<abgr.length;i+=4){abgr[i]=255;abgr[i+3]=30;}
  assert.equal(evaluateFixobsFrame('S0',abgr).predicate,'UNKNOWN');
});
test('frame copies avoid caller iterator/getter hooks and reject detached buffers', () => {
  const b=frame();Object.defineProperty(b,Symbol.iterator,{get(){throw Error('private');}});
  assert.equal(evaluateFixobsFrame('S0',b).predicate,'MATCH');
  const c=frame();structuredClone(c.buffer,{transfer:[c.buffer]});
  assert.equal(evaluateFixobsFrame('S0',c).predicate,'UNKNOWN');
});
test('explicit-time complete source model reserves1launch/2strokes/3attempts', () => {
  const run=start();const old=toKey(run,2000);toClick(run,4000);
  run.reserveAction('BUTTON1_CENTER_STROKE',6000);const done=run.acceptCandidate(frame('S2'),7000);
  assert.equal(done.observation,'BUFFER_SEQUENCE_MATCH');assert.deepEqual(done.frames,['MATCH','MATCH','MATCH']);
  assert.deepEqual(done.modeled_reservations,{launches:1,logical_keys:1,logical_clicks:1,capture_attempts:3});
  assert.equal(done.cleanup_deadline_ms,37000);assert.equal(done.cleanup_observed,'UNKNOWN');
  assert.equal(done.qualified_observation,false);assert.equal(done.custody_established,false);
  assert.equal(done.process_ceiling_enforced,false);assert.equal(old.phase,'KEY');
  assert.throws(()=>{old.frames[0]='UNKNOWN';});
});
test('original baseline cap10s includes launch and validation, no reset', () => {
  const run=start();const out=run.acceptCandidate(frame(),11000,11001);
  assert.equal(out.reason,'PHASE_DEADLINE');assert.deepEqual(out.frames,['UNKNOWN','NOT_RUN','NOT_RUN']);
  assert.equal(out.cleanup_deadline_ms,41001);
});
test('step8s clamp may be earlier than cumulative18s cap', () => {
  const run=start();toKey(run,1000);assert.equal(run.snapshot().phase_deadline_ms,9000);
  run.reserveAction('SPACE_STROKE',2000);const out=run.acceptCandidate(frame('S1'),9001);
  assert.equal(out.reason,'PHASE_DEADLINE');assert.equal(out.modeled_reservations.capture_attempts,1);
});
test('cumulative10/18/26s caps include validation; early phases cannot refund', () => {
  const run=start();toKey(run,11000);assert.equal(run.snapshot().phase_deadline_ms,19000);
  toClick(run,19000);assert.equal(run.snapshot().phase_deadline_ms,27000);
  run.reserveAction('BUTTON1_CENTER_STROKE',27000);
  assert.equal(run.acceptCandidate(frame('S2'),27000,27001).reason,'PHASE_DEADLINE');
});
test('UNKNOWN stops remaining actions/captures; no hidden retries or late promotion', () => {
  const run=start();toKey(run);run.reserveAction('SPACE_STROKE',2000);
  const unknown=run.acceptCandidate(frame(),2000);assert.deepEqual(unknown.frames,['MATCH','UNKNOWN','NOT_RUN']);
  run.reserveAction('BUTTON1_CENTER_STROKE',3000);run.acceptCandidate(frame('S1'),3000);
  const after=run.snapshot();assert.deepEqual(after.frames,unknown.frames);
  assert.deepEqual(after.modeled_reservations,unknown.modeled_reservations);
  assert.equal(after.first_stop_ms,2000);assert.equal(after.cleanup_deadline_ms,32000);
});
test('bad first frame aborts with remainder NOT_RUN and one attempted capture', () => {
  const run=start();const out=run.acceptCandidate(null,1000);
  assert.deepEqual(out.frames,['UNKNOWN','NOT_RUN','NOT_RUN']);assert.equal(out.observation,'UNKNOWN');
  assert.equal(out.modeled_reservations.capture_attempts,1);assert.equal(out.modeled_reservations.logical_keys,0);
});
test('out-of-order/repeated modeled actions stop instead of expanding action ceiling', () => {
  const run=start();toKey(run);run.reserveAction('BUTTON1_CENTER_STROKE',1000);
  assert.equal(run.snapshot().reason,'UNEXPECTED_SEQUENCE');assert.equal(run.snapshot().modeled_reservations.logical_clicks,0);
  const other=start();toKey(other);other.reserveAction('SPACE_STROKE',1000);other.reserveAction('SPACE_STROKE',1000);
  assert.equal(other.snapshot().modeled_reservations.logical_keys,1);assert.equal(other.snapshot().observation,'UNKNOWN');
});
test('source model owns prior bytes; caller mutation cannot rewrite capture history', () => {
  const run=start(),b=frame();run.acceptCandidate(b,1000);b.fill(0);
  run.reserveAction('SPACE_STROKE',1000);assert.equal(run.acceptCandidate(frame('S1'),1000).frames[1],'MATCH');
});
test('idle explicit poll expires phase without timer/callback; elapsed cleanup is not settlement', () => {
  const run=start();const stopped=run.poll(11001);assert.equal(stopped.reason,'PHASE_DEADLINE');
  assert.equal(stopped.cleanup_deadline_ms,41001);
  const ended=run.poll(41001);assert.equal(ended.cleanup_window,'ELAPSED');assert.equal(ended.cleanup_observed,'UNKNOWN');
  run.stop(42000);assert.equal(run.snapshot().cleanup_deadline_ms,41001);
});
test('late observation cannot fabricate timely stop or borrow beyond original60s', () => {
  const run=start();const out=run.poll(100000);
  assert.equal(out.first_stop_ms,100000);assert.equal(out.cleanup_deadline_ms,61000);
  assert.equal(out.cleanup_window,'ELAPSED');assert.equal(out.cleanup_observed,'UNKNOWN');
});
test('invalid/backwards clock fails closed, never echoed, no deadline reset', () => {
  assert.throws(()=>createFixobsObservation(-1),/INVALID_FIXOBS_CLOCK/);
  assert.throws(()=>createFixobsObservation(Number.MAX_SAFE_INTEGER),/INVALID_FIXOBS_CLOCK/);
  for(const value of [999,NaN,Infinity,'private',{},new Proxy({},{get(){throw Error('private');}})]) {
    const run=start();const out=run.poll(value);assert.equal(out.reason,'INVALID_CLOCK');
    assert.equal(out.first_stop_ms,1000);assert.equal(out.cleanup_deadline_ms,31000);
  }
});
test('snapshots never expose candidate bytes, events, selfACK, private input or native status', () => {
  const run=start();run.acceptCandidate(null,1000);const text=JSON.stringify(run.snapshot());
  assert(!text.includes('provider'));assert(!text.includes('message'));assert(!text.includes('pixels'));
  assert.equal(run.snapshot().runtime_admitted,false);
});
test('GTK source remains explicit factory, not imported/executed; zero launch/capture/ACK/timers', async () => {
  const text=await readFile(new URL('../fixtures/fixobs/fixture.mjs',import.meta.url),'utf8');
  assert.match(text,/export function createFixobsWindow\(application\)/);
  assert.match(text,/decorated: false/);assert.match(text,/resizable: false/);
  assert.match(text,/width !== FIXOBS.width \|\| height !== FIXOBS.height/);
  assert.match(text,/if \(next !== state\)/);assert.match(text,/return true;/);
  assert(!/\.present\(|\.run\(|Gtk\.init\(|setTimeout\(|setInterval\(|GLib\.|print\(|console\.|spawn\(|queue_draw\(\).*queue_draw\(/s.test(text));
});
