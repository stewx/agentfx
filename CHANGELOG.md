# Changelog

All notable changes to agentfx, newest first. Versions follow [semver][].

[semver]: https://semver.org/spec/v2.0.0.html

## 0.3.1 - 2026-08-17

- Fix Codex hooks never firing: Codex skips any hook declaring `async: true` — a
  flag it documents but has not implemented — so every Codex sound was dropped
  while the file still validated and `doctor` still reported the hooks installed
  Codex hooks are now written synchronously with a 3-second timeout, the cap
  Codex applies to `SessionEnd`

## 0.3.0 - 2026-08-16

- Add Antigravity CLI support: hooks are written to Antigravity's customization
  root — `~/.gemini/config/hooks.json`, or `<dir>/.agents/hooks.json` for one
  project — under an `agentfx` hook group, leaving any other hook in the file
  untouched
  Its `Stop`, `PreInvocation` and `PostInvocation` hooks are written flat and
  the tool events grouped, as Antigravity requires, and the command is written
  unquoted because it runs hooks without a shell
- `agentfx doctor` reports a hook command Antigravity cannot run — one whose
  path contains a space, which its whitespace split cannot survive
- Brand marks in the web UI can carry a gradient, which is how Antigravity's
  gets its colours

## 0.2.1 - 2026-08-16

- Add script to bump versions and update changelog

