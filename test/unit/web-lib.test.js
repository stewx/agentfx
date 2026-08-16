import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERVAL_CHOICES,
  SOUND_LIBRARY_SECTION,
  activeNavId,
  bindingFor,
  bodyId,
  boundEventCount,
  collapseToggle,
  defaultScope,
  formatSize,
  formatSummary,
  installedHookCount,
  intervalChoices,
  intervalLabel,
  navItems,
  plural,
  previewGain,
  sectionId,
  soundName,
  targetBadge
} from '../../web/lib.js';
import { isLive } from '../../web/lib.js';
import { defaultBinding, effectiveGain, isLive as isLiveOnServer } from '../../src/config.js';

/**
 * `web/app.js` wires the DOM at module scope and cannot be imported here at
 * all; `web/lib.js` is the part that decides things, and this is what stops it
 * drifting away from the server that feeds it.
 */

test('the preview plays at exactly the gain the hook will use', () => {
  // The browser preview and the real playback are computed by two different
  // functions in two different languages-worth of context. When they disagree,
  // the UI confirms a level the user will never actually hear.
  for (const masterVolume of [0, 1, 35, 70, 99, 100]) {
    for (const volume of [0, 1, 50, 100]) {
      assert.equal(
        previewGain(masterVolume, volume),
        effectiveGain({ masterVolume }, { volume }),
        `master ${masterVolume}% x event ${volume}% must agree`
      );
    }
  }
});

test('the UI and the server agree on whether a binding is live', () => {
  // The rule that decides whether a hook is written at all. The UI greys the
  // row out and counts the "Install hooks" total from its copy; if the two
  // disagree, the page shows a state the settings file does not have.
  const bindings = [
    { enabled: true, soundId: 'bundled:blip' },
    { enabled: false, soundId: 'bundled:blip' },
    { enabled: true, soundId: null },
    { enabled: true, soundId: '' },
    { enabled: false, soundId: null },
    { soundId: 'bundled:blip' },
    { enabled: true },
    {},
    undefined,
    null
  ];

  for (const binding of bindings) {
    assert.equal(
      isLive(binding),
      isLiveOnServer(binding),
      `must agree on ${JSON.stringify(binding) ?? String(binding)}`
    );
  }

  assert.equal(isLive({ enabled: true, soundId: 'bundled:blip' }), true, 'and it is not vacuous');
  assert.equal(isLive({ enabled: false, soundId: 'bundled:blip' }), false);
});

test('an absent per-event volume previews at full, it does not mute', () => {
  // Number(null) is 0, the same trap clampVolume exists for on the server.
  assert.equal(previewGain(100, undefined), 1);
  assert.equal(previewGain(100, null), 1);
  assert.equal(previewGain(50, undefined), 0.5);
});

test('soundName falls back to the id, so an error message still identifies it', () => {
  // The preview error path names the sound. A binding can outlive the sound it
  // points at, and "Could not load undefined" helps nobody.
  const sounds = [{ id: 'bundled:blip', name: 'Blip' }];
  assert.equal(soundName(sounds, 'bundled:blip'), 'Blip');
  assert.equal(soundName(sounds, 'deleted-id'), 'deleted-id');
  assert.equal(soundName([], 'deleted-id'), 'deleted-id');
});

test('bindingFor returns the stored binding, or a usable default', () => {
  const bindings = { claude: { Stop: { soundId: 'bundled:blip', volume: 40, enabled: false } } };

  assert.equal(bindingFor(bindings, 'claude', 'Stop').volume, 40);
  assert.equal(bindingFor(bindings, 'claude', 'Stop').enabled, false);

  for (const missing of [
    bindingFor(bindings, 'claude', 'Notification'),
    bindingFor(bindings, 'codex', 'Stop'),
    bindingFor(undefined, 'claude', 'Stop')
  ]) {
    assert.equal(missing.soundId, null, 'nothing bound');
    assert.equal(missing.volume, 100, 'full volume, matching the server default');
    assert.equal(missing.enabled, true);
    // Held to the server's own default rather than to a copy of it: the UI
    // renders an unsaved binding from this, and a field missing here shows the
    // user a state the settings file would never produce.
    assert.deepEqual(missing, defaultBinding(), 'every field the server would apply');
  }
});

test('targetBadge reports one state, in priority order', () => {
  const base = { installed: [], enabled: true, exists: true, error: null };

  // An error outranks everything: the file could not be read, so nothing else
  // it says about hooks is known to be true.
  assert.equal(targetBadge({ ...base, error: 'bad json', installed: ['Stop'] }).text, 'bad json');
  assert.match(targetBadge({ ...base, error: 'bad json' }).className, /warn/);

  assert.equal(targetBadge({ ...base, enabled: false, installed: ['Stop'] }).text, 'disabled');
  assert.equal(targetBadge({ ...base, installed: ['Stop'] }).text, '1 hook');
  assert.equal(targetBadge({ ...base, installed: ['Stop', 'PostToolUse'] }).text, '2 hooks');
  assert.equal(targetBadge(base).text, 'no hooks');
  assert.equal(targetBadge({ ...base, exists: false }).text, 'file not created yet');
});

test('defaultScope follows the declared default, not key order', () => {
  // Regression: Claude declared no default, so the form relied on `user`
  // happening to be written first in the SCOPES object.
  assert.equal(defaultScope({ project: {}, user: { default: true } }), 'user');
  assert.equal(defaultScope({ local: {}, project: {} }), 'local', 'falls back to the first');
  assert.equal(defaultScope({}), '');
  assert.equal(defaultScope(), '');
});

test('intervalChoices keeps a hand-edited value selectable', () => {
  assert.deepEqual(intervalChoices(0), INTERVAL_CHOICES);
  assert.deepEqual(intervalChoices(30), INTERVAL_CHOICES);

  const odd = intervalChoices(7);
  assert.ok(odd.includes(7), '7s is offered rather than snapped to 5 or 10');
  assert.deepEqual(odd, [...odd].sort((a, b) => a - b), 'still in order');
  assert.equal(odd.length, INTERVAL_CHOICES.length + 1);
});

test('intervalLabel names the no-limit case rather than showing 0', () => {
  assert.equal(intervalLabel(0), 'every time');
  assert.equal(intervalLabel(5), 'max 1 / 5s');
});

test('plural agrees with the count', () => {
  assert.equal(plural(0, 'hook'), '0 hooks');
  assert.equal(plural(1, 'hook'), '1 hook');
  assert.equal(plural(2, 'file'), '2 files');
});

test('formatSize is readable at both ends and blank when unknown', () => {
  assert.equal(formatSize(0), '', 'bundled sounds carry no size');
  assert.equal(formatSize(undefined), '');
  assert.equal(formatSize(400), '1 KB', 'never rounds a real file down to 0 KB');
  assert.equal(formatSize(48_000), '47 KB');
  assert.equal(formatSize(3_500_000), '3.3 MB');
});

test('formatSummary advertises only what this machine can decode', () => {
  const { accept, caption } = formatSummary(['.wav', '.mp3', '.flac']);
  assert.equal(accept, '.wav,.mp3,.flac', 'the file picker filters on it');
  assert.equal(caption, 'WAV, MP3, FLAC · up to 10 MB each');

  assert.equal(formatSummary([]).accept, '');
  assert.equal(formatSummary().accept, '');
});

test('the sidenav lists every harness in page order, then the sound library', () => {
  const agents = [
    { id: 'claude', name: 'Claude Code', detected: true, targets: [{ installed: ['Stop'] }] },
    { id: 'codex', name: 'Codex', detected: false, targets: [{ installed: [] }] }
  ];
  const items = navItems(agents, [{ id: 'bundled:blip' }, { id: 'bundled:alert' }]);

  assert.deepEqual(
    items.map((item) => item.label),
    ['Claude Code', 'Codex', 'Sound library'],
    'agents keep registry order, and the library is last — the order they render in'
  );
  assert.deepEqual(
    items.map((item) => item.id),
    ['agent-claude', 'agent-codex', SOUND_LIBRARY_SECTION],
    'every entry names the anchor its panel carries'
  );

  assert.equal(items[0].count, 1, 'installed hooks, summed across the agent’s files');
  assert.equal(items[1].count, 0);
  assert.equal(items[2].count, 2, 'the library counts sounds');

  assert.equal(items[1].detected, false, 'an absent harness is still listed, but marked');
  assert.equal(items[0].detected, true);
  assert.equal(items[2].detected, true, 'the library is never "not detected"');

  // The glyph is looked up by the bare agent id, not by the anchor: `icons.js`
  // files a harness's mark under the id the registry uses, and the nav entry has
  // to show the same mark the panel heading does.
  assert.deepEqual(
    items.map((item) => item.icon),
    ['claude', 'codex', SOUND_LIBRARY_SECTION],
    'each entry names the glyph it wants, agents by registry id'
  );
});

test('an agent id cannot collide with a fixed nav section', () => {
  // A bare agent id as the anchor would let an agent called `library` take over
  // the sound library's entry, and both nav links would scroll to the same panel.
  assert.notEqual(sectionId(SOUND_LIBRARY_SECTION), SOUND_LIBRARY_SECTION);

  const items = navItems([{ id: 'library', name: 'Library', targets: [] }], []);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'anchors stay unique');
});

test('the sidenav renders with no agents at all', () => {
  // The registry can report nothing detected, and `navItems()` is called on the
  // first paint before any state has arrived in some orders.
  assert.deepEqual(navItems().map((i) => i.id), [SOUND_LIBRARY_SECTION]);
  assert.equal(navItems([], []).length, 1);
  assert.equal(navItems()[0].count, 0);
});

test('collapseToggle names the harness it would fold, not just the action', () => {
  const open = collapseToggle(false, 'Codex CLI');
  const shut = collapseToggle(true, 'Codex CLI');

  assert.equal(open.expanded, true, 'this is the aria-expanded value, and it is the inverse');
  assert.equal(shut.expanded, false);

  // The control shows no icon, so `aria-expanded` and this label are the only
  // things that convey the state at all. And one control per harness: four of
  // them announcing "Collapse" tell a screen reader user nothing about which
  // panel they are on.
  assert.equal(open.label, 'Collapse Codex CLI');
  assert.equal(shut.label, 'Expand Codex CLI');
  assert.equal(collapseToggle(true, 'Pi').label, 'Expand Pi');
});

test('a panel’s anchor and its collapsible body are distinct ids', () => {
  // The nav scrolls to one and the collapse button controls the other. If they
  // were the same string, `aria-controls` would point the button at the section
  // containing it, and a hash link would resolve to whichever came first.
  assert.notEqual(bodyId('claude'), sectionId('claude'));
  assert.ok(bodyId('claude').startsWith(sectionId('claude')), 'derived, not composed apart');

  const ids = ['claude', 'codex', 'opencode', 'pi'].flatMap((id) => [sectionId(id), bodyId(id)]);
  assert.equal(new Set(ids).size, ids.length, 'no two panels claim the same id');
});

test('activeNavId highlights the section the reader is actually in', () => {
  const sections = (...tops) => tops.map((top, i) => ({ id: `s${i}`, top }));

  // Nothing scrolled yet: no section has crossed the line, but the first one is
  // on screen and highlighting nothing reads as a broken nav.
  assert.equal(activeNavId(sections(24, 900, 1600)), 's0');

  // The last section to pass the marker wins, not the first or the nearest.
  assert.equal(activeNavId(sections(-400, 90, 800)), 's1');
  assert.equal(activeNavId(sections(-1200, -700, 40)), 's2');

  // Exactly on the line counts as passed, so the highlight moves as the heading
  // reaches the topbar rather than a pixel later.
  assert.equal(activeNavId(sections(-100, 120, 900)), 's1');

  // The sound library is last and short: once the page bottoms out its top can
  // still sit below the marker forever, leaving the previous entry lit while
  // the library fills the screen.
  assert.equal(activeNavId(sections(-1400, -900, 400), { atBottom: true }), 's2');

  assert.equal(activeNavId([]), null, 'nothing to highlight before the first render');
  assert.equal(activeNavId(), null);
});

test('the agent counters read the same shapes the API sends', () => {
  const agent = {
    id: 'claude',
    events: [{ id: 'Stop' }, { id: 'Notification' }, { id: 'PostToolUse' }],
    targets: [{ installed: ['Stop'] }, { installed: ['Stop', 'Notification'] }, { installed: [] }]
  };
  const bindings = {
    claude: {
      Stop: { soundId: 'bundled:blip', enabled: true },
      Notification: { soundId: 'bundled:alert', enabled: false },
      PostToolUse: { soundId: null, enabled: true }
    }
  };

  assert.equal(boundEventCount(agent, bindings), 1, 'disabled and unbound do not count');
  assert.equal(installedHookCount(agent), 3, 'summed across every settings file');
});
