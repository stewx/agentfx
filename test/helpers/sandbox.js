import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const binPath = path.join(projectRoot, 'bin', 'agentfx.js');
export const bundledSoundFile = (name) =>
  path.join(projectRoot, 'assets', 'sounds', `${name}.wav`);

/**
 * An isolated AGENTFX_HOME + CLAUDE_CONFIG_DIR in a temp directory.
 *
 * Every path helper in src/ reads its environment variable on each call, so
 * setting them here is enough to redirect the whole app — no module cache
 * busting required. Tests must never reach the caller's real config.
 */
export function sandbox(label = 'test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentfx-${label}-`));
  const home = path.join(root, 'agentfx');
  const claudeDir = path.join(root, 'claude');
  const codexDir = path.join(root, 'codex');
  // Antigravity's customization root, with its install directory beside it —
  // the real layout, so `detect` looks for the sibling inside the sandbox
  // rather than in the caller's home.
  const antigravityDir = path.join(root, 'gemini', 'config');
  // PI_CODING_AGENT_DIR points at ~/.pi/agent, not ~/.pi.
  const piDir = path.join(root, 'pi', 'agent');
  const opencodeDir = path.join(root, 'opencode');
  const settingsFile = path.join(claudeDir, 'settings.json');
  const codexHooksFile = path.join(codexDir, 'hooks.json');
  const antigravityHooksFile = path.join(antigravityDir, 'hooks.json');
  const piExtensionFile = path.join(piDir, 'extensions', 'agentfx.ts');
  const opencodePluginFile = path.join(opencodeDir, 'plugin', 'agentfx.js');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(antigravityDir, { recursive: true });
  fs.mkdirSync(piDir, { recursive: true });
  fs.mkdirSync(opencodeDir, { recursive: true });

  // Every agent's config root must be redirected, or a sync that covers all
  // agents would reach the real ones.
  const previous = {
    AGENTFX_HOME: process.env.AGENTFX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    AGENTFX_ANTIGRAVITY_DIR: process.env.AGENTFX_ANTIGRAVITY_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR
  };
  process.env.AGENTFX_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
  // Antigravity documents no override of its own, so this one is agentfx's.
  process.env.AGENTFX_ANTIGRAVITY_DIR = antigravityDir;
  process.env.PI_CODING_AGENT_DIR = piDir;
  process.env.OPENCODE_CONFIG_DIR = opencodeDir;

  /**
   * The file each agent's hooks end up in. One row per agent, because the
   * accessors below are generated from it — adding a fifth agent should mean
   * adding a line here, not another four near-identical methods.
   *
   * `json: true` marks the ones worth handing back parsed; the generated
   * modules are asserted on as text.
   */
  const managed = {
    Settings: { file: settingsFile, json: true },
    CodexHooks: { file: codexHooksFile, json: true },
    AntigravityHooks: { file: antigravityHooksFile, json: true },
    PiExtension: { file: piExtensionFile },
    OpencodePlugin: { file: opencodePluginFile }
  };

  const accessors = {};
  for (const [name, { file, json }] of Object.entries(managed)) {
    const lower = name[0].toLowerCase() + name.slice(1);
    accessors[`read${name}`] = () => {
      const text = fs.readFileSync(file, 'utf8');
      return json ? JSON.parse(text) : text;
    };
    accessors[`raw${name}`] = () => fs.readFileSync(file, 'utf8');
    accessors[`${lower}Exists`] = () => fs.existsSync(file);
    accessors[`write${name}`] = (value) =>
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    accessors[`remove${name}`] = () => fs.rmSync(file, { force: true });
  }

  return {
    root,
    home,
    claudeDir,
    codexDir,
    antigravityDir,
    settingsFile,
    codexHooksFile,
    antigravityHooksFile,
    piDir,
    piExtensionFile,
    opencodeDir,
    opencodePluginFile,
    configFile: path.join(home, 'config.json'),
    logFile: path.join(home, 'agentfx.log'),
    /** Env for spawning the real CLI as a subprocess. */
    env: {
      ...process.env,
      AGENTFX_HOME: home,
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexDir,
      AGENTFX_ANTIGRAVITY_DIR: antigravityDir,
      PI_CODING_AGENT_DIR: piDir,
      OPENCODE_CONFIG_DIR: opencodeDir
    },

    ...accessors,

    writeConfig(value) {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(value, null, 2));
    },
    readConfig() {
      return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    },

    cleanup() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

/** A config with a bound event, muted so tests never make noise. */
export function boundConfig(bindings, extra = {}) {
  return {
    version: 1,
    enabled: true,
    masterVolume: 0,
    hookCommand: ['agentfx'],
    sounds: [],
    bindings: { claude: bindings },
    agents: {},
    ...extra
  };
}
