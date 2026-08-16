/**
 * The `--help` text.
 *
 * The agent and scope lists below are written out rather than derived from the
 * registry on purpose: `agentfx play` must not pay to load every adapter just
 * so an unrelated command can print their names. Keep them in step by hand when
 * an agent is added — `test/e2e/cli.test.js` asserts on parts of this text.
 */
export function buildHelp(version) {
  return `agentfx ${version} — sound effects for AI agent hooks

Usage
  agentfx                        Open the web UI to configure sounds
  agentfx play <agent> <event>   Play the sound bound to an event (used by hooks)
                                 Add --verbose --wait to diagnose missing sound
  agentfx sync                   Rewrite agent config files from your bindings
  agentfx uninstall              Remove every agentfx hook from every agent config
  agentfx status                 Show what is configured and where
  agentfx doctor                 Diagnose why you are not hearing anything

  agentfx target list            List the settings files agentfx manages
  agentfx target add             Manage another settings file (see --scope)
  agentfx target rm <id>         Stop managing one, cleaning up its hooks first

Agents
  claude                         Claude Code — ~/.claude/settings.json
  codex                          Codex CLI — ~/.codex/hooks.json
  opencode                       opencode — ~/.config/opencode/plugin/agentfx.js
  pi                             Pi — ~/.pi/agent/extensions/agentfx.ts

Scopes (for target add)
  user                        ~/.claude/settings.json — every project (default)
  local                       <dir>/.claude/settings.local.json — one project, gitignored
  project                     <dir>/.claude/settings.json — one project, committed
  custom                      any path, given with --dir

Options
  -p, --port <n>              Port for the web UI (default 4477)
      --no-open               Do not launch a browser
      --agent <id>            Target agent for serve/sync (default: claude)
      --scope <scope>         Scope for \`target add\` (default: user)
      --dir <path>            Project directory for \`target add\` (default: cwd)
      --verbose               With play: explain what it resolved and did
      --wait                  With play: block until the sound finishes
      --silent                With doctor: skip the playback test
      --purge                 With uninstall: also delete your sounds and config
  -h, --help                  Show this help
  -v, --version               Show version

Removing agentfx
  Run \`agentfx uninstall\` BEFORE \`npm uninstall -g agentfx\`. npm does not run
  uninstall lifecycle scripts, so removing the package cannot clean up the hooks
  it added — do it first, while the command still exists.
`;
}
