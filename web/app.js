import { createApi, request, soundFileUrl } from './api.js';
import { icon } from './icons.js';
import {
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
  isLive,
  navItems,
  plural,
  previewGain,
  scopeOf,
  sectionId,
  SOUND_LIBRARY_SECTION,
  soundName,
  targetBadge
} from './lib.js';

const $ = (selector) => document.querySelector(selector);

let state = null;
let preview = null;

/* ---------------- api ---------------- */

/**
 * Every mutation goes through here: it applies the state the server returned,
 * and reports the outcome. Passed to `createApi`, so the route definitions stay
 * free of anything to do with rendering.
 */
async function mutate(url, options, message) {
  try {
    const payload = await request(url, options);
    applyState(payload);

    // A sync can fail per settings file while the request itself succeeds —
    // reporting "installed" when nothing was written would be a lie.
    const failed = payload?.sync?.errors ?? [];
    if (failed.length) toast(`${failed[0].path}: ${failed[0].error}`, true);
    else if (message) toast(message);
    return payload;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

const api = createApi(mutate);

/* ---------------- when it is safe to redraw ---------------- */

/**
 * A render replaces the entire agent list, which destroys whatever the user is
 * currently working in. Measured before this guard existed: typing a tool
 * matcher and pausing for the 500ms debounce left the input detached from the
 * document with focus fallen back to `<body>`, and a slider drag paused past
 * its 350ms debounce was left holding a detached node.
 *
 * So a redraw waits for the interaction to finish. `state` is updated
 * immediately either way — only the DOM lags, and only while you are mid-edit.
 */
const HOLDS_WORK_IN_PROGRESS = new Set(['text', 'range']);
let pointerHeld = false;
let deferredRender = false;

function midEdit() {
  const active = document.activeElement;
  return Boolean(active && active.tagName === 'INPUT' && HOLDS_WORK_IN_PROGRESS.has(active.type));
}

const interacting = () => pointerHeld || midEdit();

function flushDeferredRender() {
  // Deferred to a task so `document.activeElement` has settled: during
  // focusout it is still the element being left.
  setTimeout(() => {
    if (!deferredRender || interacting()) return;
    deferredRender = false;
    render();
  }, 0);
}

document.addEventListener('pointerdown', () => {
  pointerHeld = true;
});
for (const event of ['pointerup', 'pointercancel']) {
  document.addEventListener(event, () => {
    pointerHeld = false;
    flushDeferredRender();
  });
}
document.addEventListener('focusout', flushDeferredRender);

/** Most endpoints return the whole state, so re-render from whatever came back. */
function applyState(payload) {
  if (!payload?.agents) return;
  state = payload;
  if (interacting()) {
    deferredRender = true;
    return;
  }
  render();
}

/* ---------------- helpers ---------------- */

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Preview in the browser at the same gain the hook would use. */
function previewSound(soundId, volume) {
  if (!soundId) return;
  preview?.pause();

  const name = soundName(state.sounds, soundId);
  const audio = new Audio(soundFileUrl(soundId));
  preview = audio;
  audio.volume = previewGain(state.config.masterVolume, volume);

  // The <audio> error event carries no useful detail, so ask the server what
  // actually went wrong — a stale process, a missing file and a decode failure
  // all look identical otherwise.
  audio.addEventListener('error', async () => {
    if (audio !== preview) return;
    try {
      const probe = await fetch(audio.src);
      if (probe.ok) {
        toast(`"${name}" downloaded but the browser could not decode it`, true);
      } else {
        const { error } = await probe.json().catch(() => ({}));
        toast(`Could not load "${name}" — ${probe.status}: ${error ?? 'request failed'}`, true);
      }
    } catch {
      toast('Could not reach the agentfx server — is it still running?', true);
    }
  });

  audio.play().catch((err) => {
    // A newer preview replaced this one — its rejection is expected, ignore it.
    if (audio !== preview || err.name === 'AbortError') return;
    if (err.name === 'NotAllowedError') {
      toast('Browser blocked playback — click anywhere on the page first', true);
    } else if (err.name !== 'NotSupportedError') {
      // NotSupportedError means the source failed to load; the 'error' handler
      // above reports that with a clearer message.
      toast(`Preview failed: ${err.message}`, true);
    }
  });
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

/** The on/off switch, which is the same three nested elements everywhere. */
function switchControl(input, title) {
  return el('label', { className: 'switch', title }, [
    input,
    el('span', { className: 'switch-track' }, [el('span', { className: 'switch-thumb' })])
  ]);
}

/* ---------------- rendering ---------------- */

function soundSelect(agentId, event, binding) {
  const select = el('select', { ariaLabel: `Sound for ${event.label}` });
  select.append(el('option', { value: '', textContent: '— no sound —' }));

  const groups = [
    ['Built in', state.sounds.filter((s) => s.builtin)],
    ['Your sounds', state.sounds.filter((s) => !s.builtin)]
  ];
  for (const [label, sounds] of groups) {
    if (!sounds.length) continue;
    const group = el('optgroup', { label });
    for (const sound of sounds) {
      group.append(el('option', { value: sound.id, textContent: sound.name }));
    }
    select.append(group);
  }

  select.value = binding.soundId ?? '';
  select.addEventListener('change', () => {
    const soundId = select.value || null;
    if (soundId) previewSound(soundId, binding.volume);
    api.bindings.save(
      agentId,
      event.id,
      { soundId },
      soundId ? `${event.label} → hook installed` : `${event.label} hook removed`
    );
  });
  return select;
}

const saveVolume = debounce((agentId, eventId, volume) => {
  api.bindings.save(agentId, eventId, { volume });
}, 350);

const saveMatcher = debounce((agentId, eventId, matcher) => {
  api.bindings.save(agentId, eventId, { matcher });
}, 500);

/**
 * How often this event is allowed to make a sound. Tool events fire several
 * times a minute, so without a gap they overlap into noise — this is what makes
 * them worth binding at all.
 */
function intervalSelect(agentId, event, binding) {
  const select = el('select', {
    className: 'interval',
    disabled: !binding.soundId,
    ariaLabel: `Minimum gap between plays for ${event.label}`,
    title: 'Minimum time between plays of this sound'
  });

  const current = binding.minInterval;
  for (const seconds of intervalChoices(current)) {
    select.append(
      el('option', { value: String(seconds), textContent: intervalLabel(seconds) })
    );
  }
  select.value = String(current);
  select.addEventListener('change', () =>
    api.bindings.save(agentId, event.id, { minInterval: Number(select.value) })
  );
  return select;
}

/** The event's name, id and one-line description. */
function eventLabel(event) {
  return el('div', {}, [
    el('div', { className: 'event-name' }, [
      document.createTextNode(event.label),
      el('span', { className: 'event-id', textContent: event.id })
    ]),
    el('p', { className: 'event-desc', textContent: event.description })
  ]);
}

/** The volume slider and its readout, which updates without a round trip. */
function volumeSlider(agent, event, binding) {
  const input = el('input', {
    type: 'range',
    min: '0',
    max: '100',
    step: '1',
    value: String(binding.volume),
    disabled: !binding.soundId,
    ariaLabel: `Volume for ${event.label}`
  });
  const readout = el('output', { textContent: `${binding.volume}%` });

  input.addEventListener('input', () => {
    readout.textContent = `${input.value}%`;
    saveVolume(agent.id, event.id, Number(input.value));
  });
  return { input, node: el('div', { className: 'volume' }, [input, readout]) };
}

/** Preview button and on/off switch. */
function eventControls(agent, event, binding, volumeInput) {
  const play = el('button', {
    className: 'btn icon',
    type: 'button',
    title: 'Preview',
    textContent: '▶',
    disabled: !binding.soundId
  });
  play.addEventListener('click', () => previewSound(binding.soundId, Number(volumeInput.value)));

  const toggle = el('input', {
    type: 'checkbox',
    checked: binding.enabled,
    disabled: !binding.soundId
  });
  toggle.addEventListener('change', () =>
    api.bindings.save(agent.id, event.id, { enabled: toggle.checked })
  );

  return el('div', { className: 'event-controls' }, [
    play,
    switchControl(toggle, binding.soundId ? 'Enable this hook' : 'Pick a sound first')
  ]);
}

/** Which tools this event fires for. Only events that take a matcher get one. */
function matcherField(agent, event, binding) {
  const input = el('input', {
    type: 'text',
    className: 'matcher',
    placeholder: 'Tool matcher — e.g. Bash|Edit|Write, or * for every tool',
    value: binding.matcher ?? '',
    ariaLabel: `Tool matcher for ${event.label}`
  });
  input.addEventListener('input', () => saveMatcher(agent.id, event.id, input.value));
  return input;
}

function renderEvent(agent, event) {
  const binding = bindingFor(state.bindings, agent.id, event.id);
  const volume = volumeSlider(agent, event, binding);

  const row = el('div', { className: `event${isLive(binding) ? '' : ' is-off'}` });
  row.append(
    eventLabel(event),
    soundSelect(agent.id, event, binding),
    volume.node,
    intervalSelect(agent.id, event, binding),
    eventControls(agent, event, binding, volume.input)
  );
  if (event.matcher) row.append(matcherField(agent, event, binding));

  return row;
}

/** One managed settings file: where it is, whether it's live, and its controls. */
function renderTarget(agent, target) {
  const scope = scopeOf(agent.scopes, target.scope);
  const row = el('div', { className: `target${target.enabled ? '' : ' is-off'}` });

  const badge = targetBadge(target);
  const status = el('span', { className: badge.className }, [
    el('span', { className: 'dot' }),
    document.createTextNode(badge.text)
  ]);

  const toggle = el('input', { type: 'checkbox', checked: target.enabled });
  toggle.addEventListener('change', () =>
    api.agents.targets.setEnabled(
      agent.id,
      target.id,
      toggle.checked,
      toggle.checked ? 'Hooks installed here' : 'Hooks removed from this file'
    )
  );

  const remove = el('button', {
    className: 'btn icon danger',
    type: 'button',
    textContent: '✕',
    title: 'Stop managing this file (removes its hooks first)'
  });
  remove.addEventListener('click', () => {
    if (!confirm(`Remove agentfx hooks from ${target.path} and stop managing it?`)) return;
    api.agents.targets.remove(agent.id, target.id, 'Stopped managing that file');
  });

  row.append(
    el('div', { className: 'target-main' }, [
      el('div', { className: 'target-scope' }, [
        document.createTextNode(scope.label),
        scope.warn ? el('span', { className: 'target-warn', textContent: scope.warn }) : null
      ]),
      el('div', { className: 'target-path mono', textContent: target.path, title: target.path })
    ]),
    status,
    switchControl(toggle, 'Install hooks in this file'),
    remove
  );
  return row;
}

/** Survives re-renders so typing into the add-target form is not lost. */
let pendingTargetDirectory = null;

/** The "add another settings file" form. */
function renderAddTarget(agent) {
  const scopes = agent.scopes ?? {};
  const scopeSelect = el('select', { ariaLabel: 'Scope for the new settings file' });
  for (const [value, scope] of Object.entries(scopes)) {
    scopeSelect.append(el('option', { value, textContent: scope.label }));
  }
  // Which scope to preselect is the adapter's call — an agent may not have a
  // project scope at all (Codex only reads notify from the user config).
  scopeSelect.value = defaultScope(scopes);

  const directory = el('input', {
    type: 'text',
    placeholder: 'Project directory',
    // Re-renders happen on every state change; keep whatever was typed rather
    // than resetting the field out from under the user.
    value: pendingTargetDirectory ?? state.system.cwd ?? '',
    ariaLabel: 'Project directory'
  });
  directory.addEventListener('input', () => {
    pendingTargetDirectory = directory.value;
  });

  const hint = el('p', { className: 'muted' });
  const syncHint = () => {
    const scope = scopes[scopeSelect.value] ?? {};
    hint.textContent = scope.hint ?? '';
    directory.placeholder =
      scopeSelect.value === 'custom' ? 'Full path to a settings file' : 'Project directory';
    // Driven by the scope's own declaration rather than by its name.
    const wantsPath = scope.needsDirectory || scopeSelect.value === 'custom';
    directory.style.display = wantsPath ? '' : 'none';
  };
  scopeSelect.addEventListener('change', syncHint);
  syncHint();

  const add = el('button', { className: 'btn', type: 'button', textContent: 'Add' });
  add.addEventListener('click', () => {
    pendingTargetDirectory = null;
    api.agents.targets.add(
      agent.id,
      { scope: scopeSelect.value, directory: directory.value.trim() || null },
      'Now managing that settings file'
    );
  });

  return el('div', { className: 'target-add' }, [
    el('div', { className: 'target-add-row' }, [scopeSelect, directory, add]),
    hint
  ]);
}

/** How many hooks this agent has installed, and whether it is even here. */
function agentBadges(agent, installedCount) {
  return [
    el('span', { className: `badge${installedCount ? ' ok' : ''}` }, [
      el('span', { className: 'dot' }),
      document.createTextNode(
        installedCount
          ? `${plural(installedCount, 'hook')} across ${plural(agent.targets.length, 'file')}`
          : 'No hooks installed'
      )
    ]),
    agent.detected
      ? null
      : el('span', { className: 'badge', textContent: 'not detected on this machine' })
  ].filter(Boolean);
}

/** Remove-all and sync, the two actions that apply to every file at once. */
function agentActions(agent, installedCount) {
  const removeButton = el('button', {
    className: 'btn quiet danger',
    type: 'button',
    textContent: 'Remove all hooks',
    disabled: installedCount === 0
  });
  removeButton.addEventListener('click', () => {
    const files = agent.targets.map((t) => t.path).join('\n');
    if (!confirm(`Remove every agentfx hook from:\n\n${files}`)) return;
    api.agents.sync(agent.id, { remove: true }, 'Hooks removed');
  });

  // Bindings are written through on every change, so this button only matters
  // when the file and the bindings have drifted apart — after "Remove all
  // hooks", or an edit made outside agentfx. It is the same action either way,
  // but "Re-sync" reads as a no-op when nothing is installed, so say what it
  // will actually do.
  const bound = boundEventCount(agent, state.bindings);

  const syncButton = el('button', {
    className: installedCount ? 'btn' : 'btn primary',
    type: 'button',
    textContent: installedCount ? 'Re-sync' : 'Install hooks',
    disabled: bound === 0,
    title: bound
      ? `Write ${plural(bound, 'hook')} into every managed settings file`
      : 'Pick a sound for an event first — that installs its hook'
  });
  syncButton.addEventListener('click', () =>
    api.agents.sync(agent.id, {}, installedCount ? 'Hooks synced' : 'Hooks installed')
  );

  return el('div', { className: 'event-controls' }, [removeButton, syncButton]);
}

/** The settings files this agent manages, and the form to add another. */
function targetsBlock(agent) {
  return el('div', { className: 'targets' }, [
    el('div', { className: 'targets-head' }, [
      el('h3', { textContent: 'Settings files' }),
      el('p', {
        className: 'muted',
        textContent: 'Where these hooks get written. Sounds below apply to all of them.'
      })
    ]),
    ...agent.targets.map((target) => renderTarget(agent, target)),
    agent.targets.length
      ? null
      : el('p', { className: 'empty', textContent: 'No settings files targeted — add one below.' }),
    renderAddTarget(agent)
  ]);
}

/**
 * Which harnesses are collapsed, by agent id.
 *
 * A view preference, so it lives here rather than in the config — nothing about
 * how you have the page folded belongs in a file that gets written to disk and
 * read by the hook. Held at module scope for the same reason
 * `pendingTargetDirectory` is: every state change re-renders the panels, and a
 * harness you folded away must not spring open because a slider moved.
 */
const collapsedAgents = new Set();

/**
 * The harness title, which is also what folds the panel.
 *
 * The heading and the badges stay ordinary elements — an `h2` inside a control,
 * or a `role="button"` wrapped around one, both cost the heading its semantics,
 * and the header already carries real buttons that must keep theirs. So the
 * control is a transparent button stretched across the title block: pointer
 * users press the header, keyboard users get a focusable control with a name,
 * and `Remove all hooks` beside it is untouched by either.
 *
 * Returns the block along with its `toggle`, so the rest of the header can fold
 * the panel through the same path rather than a second copy of the logic.
 */
function collapsibleTitle(agent, body, installedCount) {
  const hit = el('button', { className: 'panel-hit', type: 'button' });
  hit.setAttribute('aria-controls', body.id);

  /** Paints the current state — on first render, and after every toggle. */
  const paint = () => {
    const { label, expanded } = collapseToggle(collapsedAgents.has(agent.id), agent.name);
    body.hidden = !expanded;
    hit.title = label;
    hit.setAttribute('aria-label', label);
    hit.setAttribute('aria-expanded', String(expanded));
  };

  const toggle = () => {
    if (collapsedAgents.has(agent.id)) collapsedAgents.delete(agent.id);
    else collapsedAgents.add(agent.id);

    // Deliberately not a full `render()`: that would replace this control while
    // it holds focus, dropping a keyboard user back to the top of the document.
    paint();
    // Folding a panel moves every section below it, so the nav's idea of where
    // the reader is has just gone stale.
    syncActiveNav();
  };

  hit.addEventListener('click', toggle);
  paint();

  const node = el('div', { className: 'panel-title' }, [
    el('div', { className: 'panel-title-text' }, [
      // The mark goes inside the heading rather than beside it, so it stays with
      // the name when the header wraps on a narrow window.
      el('h2', {}, [icon(agent.id), el('span', { textContent: agent.name })]),
      el('div', { className: 'agent-meta' }, agentBadges(agent, installedCount))
    ]),
    hit
  ]);

  return { node, toggle };
}

function renderAgent(agent) {
  // The id is what the sidenav links to; `sectionId` is shared with it so the
  // two cannot drift into a nav full of dead anchors.
  const panel = el('section', { className: 'panel', id: sectionId(agent.id) });
  const installedCount = installedHookCount(agent);

  // The header stays out of the collapsible region: folded up, a harness still
  // has to say what it is and how many hooks it has installed.
  const body = el('div', { className: 'panel-body', id: bodyId(agent.id) }, [
    targetsBlock(agent),
    ...agent.events.map((event) => renderEvent(agent, event))
  ]);

  const title = collapsibleTitle(agent, body, installedCount);
  const head = el('div', { className: 'panel-head foldable' }, [
    title.node,
    agentActions(agent, installedCount)
  ]);

  // The stretched control covers the title block; this carries the rest of the
  // header — its padding, and the gap around the buttons. Anything interactive
  // in here answers for its own click, including that control, so folding on a
  // press of `Re-sync` is not a thing that can happen.
  head.addEventListener('click', (event) => {
    if (event.target.closest('button, select, input, a')) return;
    title.toggle();
  });

  panel.append(head, body);
  return panel;
}

/**
 * Advertise what this machine's backend can actually decode. A fixed list is a
 * trap: the browser will happily preview an .ogg that the hook then plays as
 * silence, so the file picker must not offer one in the first place.
 */
function renderFormats() {
  const { accept, caption } = formatSummary(state.system.formats ?? []);
  $('#format-info').textContent = caption;
  $('#file-input').accept = accept;
}

function renderSounds() {
  const list = $('#sound-list');
  list.replaceChildren();

  if (!state.sounds.length) {
    list.append(el('li', { className: 'empty', textContent: 'No sounds yet.' }));
    return;
  }

  for (const sound of state.sounds) {
    const play = el('button', { className: 'btn icon', type: 'button', textContent: '▶', title: 'Preview' });
    play.addEventListener('click', () => previewSound(sound.id, 100));

    const test = el('button', {
      className: 'btn quiet',
      type: 'button',
      textContent: 'Test on system',
      title: 'Play through the same audio backend your agent hooks use'
    });
    test.addEventListener('click', async () => {
      // Goes through `request` rather than `mutate`: this endpoint answers a
      // question rather than changing anything, so there is no state to apply.
      try {
        const result = await api.sounds.test(sound.id);
        toast(result.ok ? `Played via ${result.backend}` : result.error, !result.ok);
      } catch (err) {
        toast(err.message, true);
      }
    });

    const actions = [play, test];
    if (!sound.builtin) {
      const remove = el('button', {
        className: 'btn icon danger',
        type: 'button',
        textContent: '✕',
        title: 'Delete sound'
      });
      remove.addEventListener('click', () => {
        if (!confirm(`Delete "${sound.name}"? Any hook using it will be cleared.`)) return;
        api.sounds.remove(sound.id, 'Sound deleted');
      });
      actions.push(remove);
    }

    list.append(
      el('li', { className: 'sound' }, [
        el('span', { className: 'sound-name', textContent: sound.name }),
        el('span', {
          className: 'sound-meta',
          textContent: sound.builtin ? 'built in' : formatSize(sound.size)
        }),
        ...actions
      ])
    );
  }
}

/* ---------------- sidenav ---------------- */

/**
 * Nav id → its link, rebuilt on every render.
 *
 * The scroll listener outlives any single render, and a render replaces the
 * whole list, so holding the elements from the last one would leave the spy
 * styling detached nodes — the same class of bug the render guard above exists
 * for. Rebuilding the map is what keeps it pointing at the live DOM.
 */
let navLinks = new Map();

function syncActiveNav() {
  if (!navLinks.size) return;

  const sections = [];
  for (const id of navLinks.keys()) {
    const node = document.getElementById(id);
    if (node) sections.push({ id, top: node.getBoundingClientRect().top });
  }

  // Within a pixel of the end: fractional scroll heights mean the sum rarely
  // lands exactly on scrollHeight, and being one pixel short would drop the
  // last entry's highlight.
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 1;
  const active = activeNavId(sections, { atBottom });

  for (const [id, link] of navLinks) {
    const on = id === active;
    link.classList.toggle('is-active', on);
    if (on) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}

/**
 * What the entry counts: installed hooks for a harness, sounds for the library.
 * A zero reads as a defect rather than as "nothing here yet", so it is left off.
 */
function navCount(item) {
  if (!item.count) return null;
  const noun = item.id === SOUND_LIBRARY_SECTION ? 'sound' : 'installed hook';
  return el('span', {
    className: 'sidenav-count',
    textContent: String(item.count),
    title: plural(item.count, noun)
  });
}

function navEntry(item) {
  const link = el(
    'a',
    {
      className: `sidenav-link${item.detected ? '' : ' is-undetected'}`,
      href: `#${item.id}`,
      title: item.detected ? '' : 'Not detected on this machine'
    },
    [
      // The same glyph the entry's panel heading carries, so the nav and the
      // page it scrolls are recognisable as the same list. A harness with no
      // mark on file still gets the empty box: one unillustrated entry should
      // leave a gap in the column of marks, not a step in the column of names.
      icon(item.icon) ?? el('span', { className: 'glyph' }),
      el('span', { className: 'sidenav-label', textContent: item.label }),
      navCount(item)
    ]
  );

  // Scrolling to a harness the reader folded away would land them on a header
  // with nothing under it, so the nav unfolds it on the way in. Going through
  // the panel's own control rather than the set keeps one path for the change:
  // the body, `aria-expanded` and the nav all update from the same handler.
  link.addEventListener('click', () => {
    document.getElementById(item.id)?.querySelector('.panel-hit[aria-expanded="false"]')?.click();
  });

  navLinks.set(item.id, link);
  return el('li', {}, [link]);
}

function renderNav() {
  navLinks = new Map();
  const items = navItems(state.agents, state.sounds);
  $('#sidenav-list').replaceChildren(...items.map(navEntry));
  syncActiveNav();
}

window.addEventListener('scroll', syncActiveNav, { passive: true });
window.addEventListener('resize', syncActiveNav);

/* ---------------- rendering, continued ---------------- */

function render() {
  $('#master-volume').value = String(state.config.masterVolume);
  $('#master-volume-value').textContent = `${state.config.masterVolume}%`;
  $('#global-enabled').checked = state.config.enabled;
  $('#backend-info').textContent = `${state.system.platform} · audio via ${state.system.audioBackend}`;
  renderFormats();

  $('#agents').replaceChildren(...state.agents.map(renderAgent));
  renderSounds();
  // Last: the nav measures the sections it links to, which have to be in the
  // document before their positions mean anything.
  renderNav();
}

/* ---------------- uploads ---------------- */

async function uploadFiles(files) {
  // One at a time, and reported per file: a rejected format is the common case
  // and the message has to say which of the dropped files it was about.
  for (const file of files) {
    try {
      applyState(await api.sounds.upload(file));
      toast(`Added ${file.name}`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, true);
    }
  }
}

/* ---------------- wiring ---------------- */

const saveMaster = debounce((masterVolume) => {
  api.config.patch({ masterVolume });
}, 300);

$('#master-volume').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  state.config.masterVolume = value;
  $('#master-volume-value').textContent = `${value}%`;
  saveMaster(value);
});

$('#global-enabled').addEventListener('change', (event) =>
  api.config.patch(
    { enabled: event.target.checked },
    event.target.checked ? 'agentfx enabled' : 'agentfx muted'
  )
);

$('#upload-button').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (event) => {
  uploadFiles([...event.target.files]);
  event.target.value = '';
});

const dropzone = $('#dropzone');
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('dragging'));
}
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadFiles([...event.dataTransfer.files]);
});
dropzone.addEventListener('click', () => $('#file-input').click());

api
  .state()
  .then(applyState)
  .catch((err) => toast(err.message, true));
