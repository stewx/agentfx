/**
 * A single diagnostic result.
 *
 * `fail` sets a non-zero exit code so `agentfx doctor` can gate a script;
 * `warn` never does. `info` states something that is neither good nor bad but
 * is worth knowing when you are reading the rest of the report.
 */
const check = (level, label, detail) => ({ level, label, detail });

export const ok = (label, detail) => check('ok', label, detail);
export const warn = (label, detail) => check('warn', label, detail);
export const fail = (label, detail) => check('fail', label, detail);
export const info = (label, detail) => check('info', label, detail);
