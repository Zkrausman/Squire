// Portable pure fixture data. Also imported by the unlaunched GJS source.
export const FIXOBS = Object.freeze({
  width: 1280, height: 720, stride: 5120, bytes: 3686400, scale: 1,
  mark: Object.freeze({left: 540, right: 740, top: 260, bottom: 460}),
  core: Object.freeze({left: 560, right: 720, top: 280, bottom: 440}),
  background: Object.freeze([30, 30, 30]),
  colors: Object.freeze({S0: Object.freeze([128, 128, 128]),
    S1: Object.freeze([0, 0, 255]), S2: Object.freeze([0, 255, 0])}),
  click: Object.freeze({x: 640, y: 360}),
});

export function inFixobsMark(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) &&
    x >= FIXOBS.mark.left && x < FIXOBS.mark.right &&
    y >= FIXOBS.mark.top && y < FIXOBS.mark.bottom;
}

// Closed, data-only event input. Invalid events are no-ops; no error values escape.
export function advanceFixobsState(state, event) {
  if (typeof state !== 'string' || !Object.hasOwn(FIXOBS.colors, state)) return state;
  try {
    if (!event || Object.getPrototypeOf(event) !== Object.prototype) return state;
    const d = Object.getOwnPropertyDescriptors(event);
    if (Reflect.ownKeys(d).some(k => typeof k !== 'string' || !Object.hasOwn(d[k], 'value'))) return state;
    const keys = Object.keys(d).sort().join(',');
    if (keys === 'key,repeat,type' && d.type.value === 'KEY_DOWN' &&
        d.key.value === 'Space' && d.repeat.value === false && state === 'S0') return 'S1';
    if (keys === 'button,type,x,y' && d.type.value === 'BUTTON_DOWN' &&
        d.button.value === 1 && state === 'S1' && inFixobsMark(d.x.value, d.y.value)) return 'S2';
  } catch { /* No-op, including throwing accessors/proxies. */ }
  return state;
}
