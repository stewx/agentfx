import { runDoctor } from '../doctor/index.js';
import { MARKS } from './format.js';
import { version } from './version.js';

/**
 * `agentfx doctor` — walks the chain and reports what it established. Exits
 * non-zero when something is definitely broken, so it can gate a script; a
 * warning alone is not a failure.
 */
export async function commandDoctor(options) {
  const { sections, failures, warnings } = await runDoctor({
    agent: options.agent,
    silent: options.silent
  });

  console.log(`agentfx ${version} — diagnostics\n`);
  for (const section of sections) {
    console.log(`  ${section.title}`);
    for (const check of section.checks) {
      const mark = `    ${MARKS[check.level]} `;
      // Labels are mostly short, but settings-file checks are labelled with a
      // full path. Wrapping those onto their own line keeps the column of
      // details readable instead of ragged.
      if (check.label.length > 22) console.log(`${mark}${check.label}\n${' '.repeat(mark.length)}  ${check.detail}`);
      else console.log(`${mark}${check.label.padEnd(22)} ${check.detail}`);
    }
    console.log('');
  }

  if (failures) {
    process.exitCode = 1;
    console.log(`${failures} problem(s) found${warnings ? `, ${warnings} warning(s)` : ''}.`);
    return;
  }
  console.log(warnings ? `No problems found, ${warnings} warning(s).` : 'No problems found.');
}
