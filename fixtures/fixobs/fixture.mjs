// Trusted non-game GTK4 fixture SOURCE ONLY. Never loaded by Node tests.
// No top-level initialization, launch, main loop, timers, capture, ACK or logging.
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import {FIXOBS, advanceFixobsState} from '../../src/fixobs-state.mjs';

// A future qualified launcher must supply its Gtk.Application and explicit
// initialization/lifetime. This factory does not present or run the window.
export function createFixobsWindow(application) {
  let state = 'S0';
  let heldSpaceCode = null;
  const area = new Gtk.DrawingArea({content_width: FIXOBS.width,
    content_height: FIXOBS.height, focusable: true, margin_top: 0,
    margin_bottom: 0, margin_start: 0, margin_end: 0});
  const window = new Gtk.ApplicationWindow({application, decorated: false,
    resizable: false, default_width: FIXOBS.width, default_height: FIXOBS.height});
  window.set_child(area);
  area.set_draw_func((_area, cr, width, height) => {
    cr.setSourceRGBA(30 / 255, 30 / 255, 30 / 255, 1); cr.paint();
    // Wrong dimensions do not silently scale or crop the reference geometry.
    if (width !== FIXOBS.width || height !== FIXOBS.height) return;
    const color = FIXOBS.colors[state];
    cr.setSourceRGBA(color[0] / 255, color[1] / 255, color[2] / 255, 1);
    cr.rectangle(540, 260, 200, 200); cr.fill();
  });
  const update = event => {
    const next = advanceFixobsState(state, event);
    if (next !== state) { state = next; area.queue_draw(); }
  };
  const key = new Gtk.EventControllerKey();
  key.connect('key-pressed', (_controller, keyval, keycode) => {
    const repeat = heldSpaceCode !== null;
    // One bounded held-key slot, no event-controlled set growth.
    if (keyval === Gdk.KEY_space) {
      if (heldSpaceCode === null) heldSpaceCode = keycode;
      update({type: 'KEY_DOWN', key: 'Space', repeat});
      return true;
    }
    return false;
  });
  key.connect('key-released', (_controller, _keyval, keycode) => { if (keycode === heldSpaceCode) heldSpaceCode = null; });
  area.add_controller(key);
  const click = new Gtk.GestureClick({button: 1});
  click.connect('pressed', (_gesture, _count, x, y) => {
    update({type: 'BUTTON_DOWN', button: 1, x, y});
  });
  // Release does not transition or schedule another draw.
  area.add_controller(click);
  area.connect('map', () => { area.grab_focus(); });
  return window;
}
