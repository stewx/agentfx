/**
 * The parts of the UI that are decisions rather than DOM.
 *
 * `app.js` wires elements up at module scope, which means it cannot be imported
 * under Node and so cannot be tested at all. Everything here is pure — no
 * `document`, no `fetch`, no module state — so it runs in the browser as part
 * of the page and under `node:test` as an ordinary import.
 */

/**
 * A binding, or the defaults the server would apply to a new one.
 *
 * The browser cannot import from `src/`, so this mirrors `defaultBinding()` in
 * `src/config.js` and `test/unit/web-lib.test.js` holds the two together — the
 * same arrangement `isLive` and `previewGain` are under. `minInterval` was
 * missing here, and the interval control compensated with its own `?? 0`, which
 * left the drift working by accident rather than by agreement.
 */
export function bindingFor(bindings, agentId, eventId) {
  return (
    bindings?.[agentId]?.[eventId] ?? {
      soundId: null,
      volume: 100,
      enabled: true,
      matcher: '',
      minInterval: 0
    }
  );
}

export function soundName(sounds, soundId) {
  return sounds.find((s) => s.id === soundId)?.name ?? soundId;
}

export function formatSize(bytes) {
  if (!bytes) return '';
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** `1 hook`, `2 hooks`. */
export function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The gain to preview a sound at, 0..1.
 *
 * This must stay the same curve as `effectiveGain` in `src/config.js`, or the
 * preview lies about how loud the hook will be. Both values arrive already
 * clamped to 0-100 because the server normalizes the config before sending it;
 * the `min` is belt and braces for a hand-edited file that got through.
 */
export function previewGain(masterVolume, volume) {
  return Math.min(1, (masterVolume / 100) * ((volume ?? 100) / 100));
}

/** The five mutually exclusive states a managed settings file can be in. */
export function targetBadge(target) {
  const count = target.installed.length;
  if (target.error) return { text: target.error, className: 'badge warn' };
  if (!target.enabled) return { text: 'disabled', className: 'badge' };
  if (count) return { text: plural(count, 'hook'), className: 'badge ok' };
  if (target.exists) return { text: 'no hooks', className: 'badge' };
  return { text: 'file not created yet', className: 'badge' };
}

/**
 * A scope definition, with a usable fallback.
 *
 * A target can name a scope its agent no longer declares — a config written by
 * an older version, or hand-edited — and it is still a real file we manage, so
 * it is labelled with the raw scope id rather than blank.
 */
export function scopeOf(scopes, scopeId) {
  return scopes?.[scopeId] ?? { label: scopeId, hint: '' };
}

/**
 * Which scope the add-target form starts on.
 *
 * Driven by the adapter's own `default` flag rather than by key order: relying
 * on the first key made it correct only by accident, and silently wrong for any
 * agent that listed its scopes in another order.
 */
export function defaultScope(scopes = {}) {
  const preferred = Object.entries(scopes).find(([, scope]) => scope.default)?.[0];
  return preferred ?? Object.keys(scopes)[0] ?? '';
}

/** Offered gaps between plays, in seconds. 0 is "every time". */
export const INTERVAL_CHOICES = [0, 1, 2, 5, 10, 30, 60];

/**
 * The gaps to offer, including whatever is currently set. A hand-edited config
 * can hold a value we do not offer; it stays selectable rather than being
 * silently snapped to a neighbour.
 */
export function intervalChoices(current = 0) {
  if (INTERVAL_CHOICES.includes(current)) return INTERVAL_CHOICES;
  return [...INTERVAL_CHOICES, current].sort((a, b) => a - b);
}

export function intervalLabel(seconds) {
  return seconds === 0 ? 'every time' : `max 1 / ${seconds}s`;
}

/**
 * Can this binding produce a sound at all?
 *
 * The browser cannot import from `src/`, so this mirrors `isLive` in
 * `src/config.js` — the rule that decides whether a hook is written at all.
 * `test/unit/web-lib.test.js` asserts the two agree rather than trusting this
 * comment, the same way `previewGain` is held to `effectiveGain`.
 */
export function isLive(binding) {
  return Boolean(binding?.enabled && binding?.soundId);
}

/** How many of an agent's events have a sound bound and switched on. */
export function boundEventCount(agent, bindings) {
  return agent.events.filter((event) => isLive(bindingFor(bindings, agent.id, event.id))).length;
}

/** Hooks installed across every settings file this agent manages. */
export function installedHookCount(agent) {
  return agent.targets.reduce((total, target) => total + target.installed.length, 0);
}

/* ---------------- sidenav ---------------- */

/** The anchor the sound library panel carries, and the nav entry that points at it. */
export const SOUND_LIBRARY_SECTION = 'library';

/**
 * The anchor id for an agent's panel.
 *
 * Prefixed rather than using the bare agent id, so an agent can never collide
 * with a fixed section — an agent called `library` would otherwise take over
 * the sound library's entry.
 */
export const sectionId = (agentId) => `agent-${agentId}`;

/**
 * The collapsible part of an agent's panel — everything below its header.
 *
 * Derived from `sectionId` rather than composed separately, so the anchor the
 * nav scrolls to and the region the collapse button controls can only ever
 * describe the same panel.
 */
export const bodyId = (agentId) => `${sectionId(agentId)}-body`;

/**
 * What the fold control announces, in the same shape as `targetBadge`: the
 * caller applies what this returns rather than deciding any of it.
 *
 * The control carries no icon — folded, the panel's own emptiness is the state.
 * That puts the whole burden of conveying it on `aria-expanded` and on a label
 * that names the harness: the page has one of these per agent, and four
 * controls all announcing "Collapse" say nothing about which panel you are on.
 */
export function collapseToggle(collapsed, name) {
  return {
    label: `${collapsed ? 'Expand' : 'Collapse'} ${name}`,
    expanded: !collapsed
  };
}

/**
 * The left nav: one entry per harness, then the sound library.
 *
 * Agent order follows the registry, which is the order the panels render in —
 * a nav that lists them differently to the page it scrolls is worse than none.
 *
 * `icon` is the name the entry's glyph is filed under in `icons.js`, and is the
 * bare agent id rather than the prefixed anchor: a harness's nav entry has to
 * show the same mark its panel heading does, and both look it up by that id.
 * Naming it here rather than stripping the prefix back off at the call site
 * keeps `sectionId` the only place that knows how the anchor is composed.
 */
export function navItems(agents = [], sounds = []) {
  return [
    ...agents.map((agent) => ({
      id: sectionId(agent.id),
      icon: agent.id,
      label: agent.name,
      count: installedHookCount(agent),
      detected: agent.detected !== false
    })),
    {
      id: SOUND_LIBRARY_SECTION,
      icon: SOUND_LIBRARY_SECTION,
      label: 'Sound library',
      count: sounds.length,
      detected: true
    }
  ];
}

/**
 * Which nav entry to highlight, from each section's distance to the top of the
 * viewport (`getBoundingClientRect().top`, so it is negative once scrolled past).
 *
 * The last section to have crossed the marker line wins. Two edges matter and
 * neither falls out of that rule on its own: at the very top nothing has
 * crossed yet, and the final section — the sound library, which is short — can
 * never reach the line when the page bottoms out first, so `atBottom` claims it.
 * Without that, scrolling to the end leaves the last harness highlighted while
 * the library fills the screen.
 *
 * `marker` clears the sticky topbar: a section is "current" once its heading has
 * risen behind the bar, not when its top edge touches the viewport.
 */
export function activeNavId(sections = [], { marker = 120, atBottom = false } = {}) {
  if (!sections.length) return null;
  if (atBottom) return sections[sections.length - 1].id;

  let active = sections[0];
  for (const section of sections) {
    if (section.top <= marker) active = section;
  }
  return active.id;
}

/** The upload picker's accept list and the caption beside it. */
export function formatSummary(formats = []) {
  const names = formats.map((ext) => ext.replace('.', '').toUpperCase()).join(', ');
  return {
    accept: formats.join(','),
    caption: `${names} · up to 10 MB each`
  };
}
