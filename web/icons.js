/**
 * The small glyphs that sit in front of a label — in a panel heading and in the
 * matching sidenav entry. Two kinds, kept in two tables because they answer to
 * different rules: the harnesses' brand marks below, and `sections`, the plain
 * glyphs for the parts of the page that belong to no vendor.
 *
 * Every path in `marks` is the vendor's own, traced from an official asset —
 * nothing is drawn by hand, because a harness's logo is the one thing on its
 * panel a reader recognises before they read anything:
 *
 *   claude    code.claude.com, via simple-icons `claudecode`
 *   codex     the OpenAI mark, from developers.openai.com's favicon
 *   opencode  packages/identity/mark.svg, via simple-icons `opencode`
 *   pi        pi.dev/favicon.svg
 *
 * Each carries its vendor's brand colour, as two values: the ink for a light
 * background and the ink for a dark one. Three of the four brands are
 * deliberately monochrome — OpenAI's guidelines name black and white as the
 * whole primary palette, and opencode and Pi both ship a white glyph on a
 * near-black tile — so for those the dark value is the vendor's own inverse
 * rather than something invented here. Claude's clay reads on both and does not
 * flip.
 *
 * The pair is handed to CSS as custom properties rather than resolved here: the
 * stylesheet already switches on `prefers-color-scheme`, and a colour picked in
 * JavaScript would need a matchMedia listener and a re-render to follow the
 * reader changing theme mid-session.
 *
 * The only edit made to any of them is on the OpenAI mark, whose coordinates
 * arrive at five decimal places and are rounded to two — a third of the bytes,
 * and a quarter of a pixel at the size this renders.
 *
 * The viewBox travels with the path: these come from four sources and only two
 * of them are 24-unit grids, so normalising the coordinates would mean editing
 * the marks. `fill-rule` is evenodd throughout — the counters in the Claude
 * Code, opencode and Pi marks are all holes, and stating it here means an icon
 * added later cannot render as a solid blob because its subpaths happened to
 * wind the same way.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const marks = {
  claude: {
    // Anthropic's clay, which holds up on both grounds — the one mark here that
    // does not need an inverse.
    light: '#d97757',
    dark: '#d97757',
    viewBox: '0 0 24 24',
    path:
      'M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Z' +
      'm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z'
  },
  codex: {
    // "Black and white as the primary palette" — openai.com/brand.
    light: '#000000',
    dark: '#ffffff',
    viewBox: '0 0 24 24',
    path:
      'M9.94 9.59V8.13C9.94 8.01 9.99 7.92 10.1 7.86L13.03 6.17C13.43 5.94 13.91 5.83 14.4 ' +
      '5.83C16.24 5.83 17.41 7.26 17.41 8.78C17.41 8.89 17.41 9.01 17.4 9.13L14.35 ' +
      '7.35C14.17 7.24 13.99 7.24 13.8 7.35L9.94 9.59ZM16.8 15.28V11.79C16.8 11.57 16.7 ' +
      '11.42 16.52 11.31L12.66 9.07L13.92 8.35C14.03 8.29 14.12 8.29 14.23 8.35L17.17 ' +
      '10.04C18.01 10.53 18.58 11.57 18.58 12.59C18.58 13.75 17.89 14.83 16.8 ' +
      '15.28V15.28ZM9.04 12.2L7.78 11.47C7.67 11.4 7.63 11.31 7.63 11.19V7.81C7.63 6.17 ' +
      '8.89 4.92 10.59 4.92C11.24 4.92 11.83 5.14 12.34 5.52L9.32 7.27C9.13 7.38 9.04 7.53 ' +
      '9.04 7.75V12.2L9.04 12.2ZM11.75 13.77L9.94 12.76V10.61L11.75 9.59L13.55 ' +
      '10.61V12.76L11.75 13.77ZM12.91 18.44C12.26 18.44 11.67 18.22 11.16 17.84L14.18 ' +
      '16.09C14.37 15.98 14.46 15.83 14.46 15.61V11.16L15.74 11.9C15.84 11.96 15.89 12.05 ' +
      '15.89 12.17V15.55C15.89 17.2 14.61 18.44 12.91 18.44ZM9.27 15.01L6.33 13.32C5.49 ' +
      '12.83 4.92 11.79 4.92 10.77C4.92 9.59 5.63 8.53 6.72 8.09V11.59C6.72 11.8 6.81 11.96 ' +
      '7 12.07L10.84 14.29L9.58 15.01C9.47 15.08 9.38 15.08 9.27 15.01ZM9.1 17.53C7.36 ' +
      '17.53 6.09 16.23 6.09 14.61C6.09 14.49 6.1 14.37 6.12 14.25L9.15 16C9.33 16.11 9.51 ' +
      '16.11 9.7 16L13.55 13.77V15.23C13.55 15.35 13.51 15.44 13.4 15.51L10.47 17.2C10.07 ' +
      '17.43 9.59 17.53 9.1 17.53H9.1ZM12.91 19.36C14.77 19.36 16.32 18.04 16.67 ' +
      '16.29C18.39 15.84 19.5 14.23 19.5 12.59C19.5 11.51 19.04 10.47 18.21 9.71C18.29 9.39 ' +
      '18.33 9.07 18.33 8.75C18.33 6.55 16.55 4.91 14.49 4.91C14.08 4.91 13.68 4.97 13.28 ' +
      '5.11C12.59 4.43 11.63 4 10.59 4C8.73 4 7.18 5.32 6.83 7.07C5.11 7.52 4 9.13 4 ' +
      '10.77C4 11.85 4.46 12.89 5.29 13.65C5.21 13.97 5.17 14.29 5.17 14.61C5.17 16.81 6.95 ' +
      '18.46 9.01 18.46C9.42 18.46 9.82 18.39 10.22 18.26C10.91 18.93 11.87 19.36 12.91 ' +
      '19.36Z'
  },
  opencode: {
    // The mark ships as a white glyph on a near-black tile; on a light ground
    // the tile is what goes away, not the ink.
    light: '#141414',
    dark: '#ffffff',
    viewBox: '0 0 24 24',
    path: 'M22 24H2V0h20zM17 4.8H7v14.4h10z'
  },
  pi: {
    // Same arrangement as opencode, over pi.dev's own #09090b.
    light: '#09090b',
    dark: '#ffffff',
    viewBox: '0 0 800 800',
    path:
      'M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z' +
      'M282.65 282.65V400H400V282.65Z' +
      'M517.36 400H634.72V634.72H517.36Z'
  }
};

/**
 * Glyphs for the fixed sections of the page — the ones that are part of agentfx
 * rather than part of somebody's product, and so have no logo to borrow.
 *
 * Keyed by the section's anchor id, which is what `navItems` puts on the entry,
 * so the nav asks for its icon with the same string it links to.
 *
 * These carry no palette. A vendor's mark has a colour it is entitled to and a
 * nav full of them is worth the ink; a section of this app does not, and drawn
 * in `currentColor` the glyph tracks the link through muted, hover and current
 * instead of sitting at one fixed colour through all three.
 */
const sections = {
  // Four bars off a level meter, for the sound library. Drawn as pills — a
  // vertical run capped by a half-circle at each end — because the alternative,
  // stroked lines with round caps, would be the one icon here that renders from
  // its stroke rather than its fill.
  //
  // 3 wide on a 2 gap: at the 16px the sidenav renders these at, a fifth bar
  // would put the whole figure under two device pixels per bar and turn it to
  // mush on a non-retina screen.
  library: {
    viewBox: '0 0 24 24',
    path:
      'M3 10.5a1.5 1.5 0 0 1 3 0V13.5a1.5 1.5 0 0 1-3 0Z' +
      'M8 5.5a1.5 1.5 0 0 1 3 0V18.5a1.5 1.5 0 0 1-3 0Z' +
      'M13 8a1.5 1.5 0 0 1 3 0V16a1.5 1.5 0 0 1-3 0Z' +
      'M18 11a1.5 1.5 0 0 1 3 0V13a1.5 1.5 0 0 1-3 0Z'
  }
};

/**
 * The glyph for an agent id or a fixed section id, as an `<svg>` ready to drop
 * in front of a heading or a nav label — or `null` for a name with nothing on
 * file, which the callers treat as "no icon" rather than as an error. A harness
 * added to the registry has to show up in the UI whether or not anyone has
 * traced its logo yet.
 *
 * Hidden from assistive tech: it sits beside the name it stands for, so
 * announcing it would only repeat what the label already says.
 */
export function icon(name) {
  const brand = marks[name];
  const mark = brand ?? sections[name];
  if (!mark) return null;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', brand ? 'glyph brand' : 'glyph');
  svg.setAttribute('viewBox', mark.viewBox);
  svg.setAttribute('aria-hidden', 'true');
  // Without this, IE-era SVG rules still put the element in the tab order in
  // some browsers; it costs one attribute to keep it out.
  svg.setAttribute('focusable', 'false');
  if (brand) {
    // The stylesheet decides which of the two the current theme wants.
    svg.style.setProperty('--brand', brand.light);
    svg.style.setProperty('--brand-dark', brand.dark);
  }

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', mark.path);
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);

  return svg;
}
