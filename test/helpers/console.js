/**
 * Capturing what a command printed.
 *
 * The modules in `src/cli/` return nothing: what they print *is* their
 * behaviour, so unit-testing them at all means intercepting the two functions
 * they write through. Restoring in a `finally` matters more here than usual —
 * a test that threw while `console.log` was swapped would take the runner's own
 * reporting down with it.
 *
 * `node --test` runs the tests inside one file sequentially, so a global swap
 * is safe; it is the *files* that run in parallel, and those are separate
 * processes.
 */

/**
 * Runs `fn` with console captured, and hands back everything it emitted.
 *
 * `process.exitCode` is captured and restored too, because `doctor`, `sync` and
 * `uninstall` all report failure by setting it — and in a test process that
 * means a test which deliberately exercises a failure would leave the whole
 * suite exiting non-zero while every assertion passed.
 *
 * @param {() => unknown | Promise<unknown>} fn
 * @returns {Promise<{lines: string[], errorLines: string[], stdout: string,
 *   stderr: string, exitCode: number|undefined, line: (re: RegExp) => string|undefined,
 *   linesMatching: (re: RegExp) => string[]}>}
 */
export async function captureConsole(fn) {
  const original = { log: console.log, error: console.error };
  const before = process.exitCode;
  const lines = [];
  const errorLines = [];

  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => errorLines.push(args.join(' '));

  let exitCode;
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.error = original.error;
    exitCode = process.exitCode;
    process.exitCode = before;
  }

  return {
    lines,
    errorLines,
    stdout: lines.join('\n'),
    stderr: errorLines.join('\n'),
    exitCode,
    /** The one stdout line matching `re` — for asserting on a row of a report. */
    line: (re) => lines.find((entry) => re.test(entry)),
    linesMatching: (re) => lines.filter((entry) => re.test(entry))
  };
}

/**
 * The same, for a command expected to reject. Returns the error alongside the
 * output, so a test can assert on both what was printed before the failure and
 * what the failure said.
 */
export async function captureConsoleError(fn) {
  let error;
  const captured = await captureConsole(async () => {
    try {
      await fn();
    } catch (err) {
      error = err;
    }
  });
  return { ...captured, error };
}
