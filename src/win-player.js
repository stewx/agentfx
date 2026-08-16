import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { agentfxHome } from './paths.js';

/**
 * A compiled stand-in for the PowerShell player, because PowerShell is the
 * delay.
 *
 * Measured on Windows 11, one hook fire from `node` to the first sample leaving
 * the endpoint: `powershell.exe` startup 530ms, `Add-Type -AssemblyName
 * presentationCore` a further 314ms, MediaPlayer construction 54ms, Open and
 * decode 245ms. ~85% of a 1.23s delay was spent getting to the point where the
 * audio stack existed at all, and none of it is tunable — `-NoProfile` is
 * already set and there is no flag left.
 *
 * The same work in a compiled executable reaches Play() in ~215ms, because a
 * 5KB .NET binary starts in ~50ms rather than 530ms and links WPF at load
 * instead of compiling an Add-Type request for it.
 *
 * What this is *not* is a second implementation of playback. It is the same WPF
 * MediaPlayer, opened, guarded, gated and awaited in the same order as
 * `windowsCommand` in `player.js` — the parity is asserted in
 * `test/unit/win-player.test.js`, statement by statement, so the two cannot
 * drift into disagreeing about what "played" means. Everything subtle lives
 * there and is commented there: why MediaEnded rather than NaturalDuration, why
 * the Dispatcher has to be pumped, why a failed open must exit non-zero.
 *
 * Nothing is shipped in the package. `package.json` has no dependencies and no
 * build step, and this does not change that: the C# is a string, compiled on
 * demand with the `csc.exe` that comes with .NET Framework 4 into the user's own
 * `~/.agentfx`, exactly as `launch-hidden.vbs` is written there. If any part of
 * that is unavailable — no csc, a locked-down machine, a policy that blocks
 * running a self-compiled binary — every function here returns null and
 * `playSound` uses the PowerShell path unchanged.
 */

/**
 * The player: a `waveOut` fast path for PCM WAV, and WPF MediaPlayer for
 * everything else.
 *
 * The two exist because `MediaPlayer.Open()` measured **165–280ms for every
 * file, WAV and MP3 alike, and does not amortize** — opening the same file
 * twice in one process costs it twice. That is not decoding; it is Media
 * Foundation building a topology, and a WAV needs none of it. Reading the file,
 * parsing RIFF and handing the PCM to `waveOut` measured **0ms, 0ms and 39ms**,
 * the last being `waveOutOpen` itself. At the audio endpoint, playing the same
 * `alert.wav`: 350–355ms through WPF against 233–247ms through waveOut.
 *
 * Volume is applied by scaling the samples rather than with
 * `waveOutSetVolume`, which is a property of the device handle and a worse
 * thing to be adjusting. Scaling is exact and cannot leak into another stream.
 * It is only correct for 16-bit PCM, so anything else falls through to WPF
 * unless the gain is 1.0 and no scaling is needed at all.
 *
 * `WHDR_DONE` is a better end-of-playback signal than `MediaEnded`: the device
 * sets it when it has consumed the buffer, so there is no duration to be lied
 * to about — which is the whole class of bug documented on the WPF path below.
 *
 * The WPF half mirrors the PowerShell script in `player.js`; read that one for
 * the reasoning, which applies here unchanged and is not repeated. `[STAThread]`
 * is required because WPF media objects have thread affinity and PowerShell's
 * main thread is already STA, so the script never had to say so. And the file
 * and gain arrive as argv rather than being baked in, which is what lets one
 * compiled binary serve every sound — otherwise the cache would miss on every
 * distinct volume and compile far more often than it played.
 */
export const PLAYER_CS = `using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Media;
using System.Windows.Threading;

static class AfxPlay {
    /* ---------------- waveOut fast path ---------------- */

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX {
        public short wFormatTag, nChannels;
        public int nSamplesPerSec, nAvgBytesPerSec;
        public short nBlockAlign, wBitsPerSample, cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR {
        public IntPtr lpData; public int dwBufferLength, dwBytesRecorded;
        public IntPtr dwUser; public int dwFlags, dwLoops;
        public IntPtr lpNext; public IntPtr reserved;
    }

    [DllImport("winmm.dll")] static extern int waveOutOpen(
        out IntPtr h, int dev, ref WAVEFORMATEX f, IntPtr cb, IntPtr inst, int flags);
    [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr h, ref WAVEHDR w, int n);
    [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr h, ref WAVEHDR w, int n);
    [DllImport("winmm.dll")]
    static extern int waveOutUnprepareHeader(IntPtr h, ref WAVEHDR w, int n);
    [DllImport("winmm.dll")] static extern int waveOutReset(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutClose(IntPtr h);

    const int WAVE_MAPPER = -1;
    const int WHDR_DONE = 1;
    const int WAVE_FORMAT_PCM = 1;

    /**
     * 0 played, 1 failed, -1 not eligible — take the WPF path instead.
     * "Not eligible" is not an error: it is every format waveOut cannot be
     * handed directly, which is most of them.
     */
    static int PlayWav(string file, double gain) {
        byte[] raw;
        try { raw = File.ReadAllBytes(file); } catch { return -1; }
        if (raw.Length < 44) return -1;
        if (Encoding_ASCII(raw, 0, 4) != "RIFF" || Encoding_ASCII(raw, 8, 4) != "WAVE") return -1;

        var fmt = new WAVEFORMATEX();
        int dataAt = -1, dataLen = 0;
        bool haveFmt = false;
        int p = 12;
        while (p + 8 <= raw.Length) {
            string id = Encoding_ASCII(raw, p, 4);
            int len = BitConverter.ToInt32(raw, p + 4);
            if (len < 0) return -1;
            if (id == "fmt " && len >= 16) {
                fmt.wFormatTag = BitConverter.ToInt16(raw, p + 8);
                fmt.nChannels = BitConverter.ToInt16(raw, p + 10);
                fmt.nSamplesPerSec = BitConverter.ToInt32(raw, p + 12);
                fmt.nAvgBytesPerSec = BitConverter.ToInt32(raw, p + 16);
                fmt.nBlockAlign = BitConverter.ToInt16(raw, p + 20);
                fmt.wBitsPerSample = BitConverter.ToInt16(raw, p + 22);
                fmt.cbSize = 0;
                haveFmt = true;
            } else if (id == "data") {
                dataAt = p + 8;
                // A truncated file declares more than it carries; trust the file.
                dataLen = Math.Min(len, raw.Length - dataAt);
                break;
            }
            p += 8 + len + (len & 1);
        }
        if (!haveFmt || dataAt < 0 || dataLen <= 0) return -1;

        // WAVE_FORMAT_EXTENSIBLE and the compressed tags are not raw PCM, and
        // sample scaling is only defined here for signed 16-bit.
        if (fmt.wFormatTag != WAVE_FORMAT_PCM) return -1;
        bool needScaling = gain < 0.999;
        if (needScaling && fmt.wBitsPerSample != 16) return -1;

        var pcm = new byte[dataLen];
        Buffer.BlockCopy(raw, dataAt, pcm, 0, dataLen);
        if (needScaling) {
            for (int i = 0; i + 1 < pcm.Length; i += 2) {
                short s = (short)(BitConverter.ToInt16(pcm, i) * gain);
                pcm[i] = (byte)(s & 0xFF);
                pcm[i + 1] = (byte)((s >> 8) & 0xFF);
            }
        }

        IntPtr device;
        // A busy or absent device falls through to WPF rather than failing:
        // it costs one more attempt and covers the case where they disagree.
        if (waveOutOpen(out device, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, 0) != 0) {
            return -1;
        }

        IntPtr buffer = IntPtr.Zero;
        var hdr = new WAVEHDR();
        int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
        try {
            buffer = Marshal.AllocHGlobal(pcm.Length);
            Marshal.Copy(pcm, 0, buffer, pcm.Length);
            hdr.lpData = buffer;
            hdr.dwBufferLength = pcm.Length;
            if (waveOutPrepareHeader(device, ref hdr, hdrSize) != 0) return 1;
            if (waveOutWrite(device, ref hdr, hdrSize) != 0) return 1;

            // Bounded like the WPF path, and for the same reason: nothing else
            // stops a device that accepts the buffer and never reports it done.
            int capMs = 30000;
            if (fmt.nAvgBytesPerSec > 0) {
                capMs = (int)Math.Min(
                    (long)pcm.Length * 1000 / fmt.nAvgBytesPerSec * 2 + 1000, 30000);
            }
            var clock = System.Diagnostics.Stopwatch.StartNew();
            while ((hdr.dwFlags & WHDR_DONE) == 0 && clock.ElapsedMilliseconds < capMs) {
                System.Threading.Thread.Sleep(5);
            }
            waveOutUnprepareHeader(device, ref hdr, hdrSize);
            return 0;
        } finally {
            waveOutReset(device);
            waveOutClose(device);
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
        }
    }

    static string Encoding_ASCII(byte[] b, int at, int len) {
        return System.Text.Encoding.ASCII.GetString(b, at, len);
    }

    /* ---------------- WPF path, for everything else ---------------- */

    [STAThread]
    static int Main(string[] argv) {
        if (argv.Length < 2) return 2;
        try {
            string file = argv[0];
            double gain = double.Parse(argv[1], CultureInfo.InvariantCulture);
            if (gain < 0) gain = 0;
            if (gain > 1) gain = 1;

            int direct = PlayWav(file, gain);
            if (direct >= 0) return direct;

            var player = new MediaPlayer();

            // Opening is asynchronous and reports through MediaOpened /
            // MediaFailed, which are Dispatcher events: only ever delivered
            // while a frame is pumped. Without this an undecodable file is
            // indistinguishable from a successful play.
            var opening = new DispatcherFrame();
            bool opened = false;
            player.MediaOpened += delegate { opened = true; opening.Continue = false; };
            player.MediaFailed += delegate { opening.Continue = false; };

            // A file that never opens must not pump forever.
            var openTimeout = new DispatcherTimer();
            openTimeout.Interval = TimeSpan.FromSeconds(5);
            openTimeout.Tick += delegate { opening.Continue = false; };
            openTimeout.Start();
            player.Open(new Uri(file));
            Dispatcher.PushFrame(opening);
            openTimeout.Stop();

            // Before Play, so a partial failure is never reported as success.
            if (!opened) return 1;

            player.Volume = gain;

            // Play() returns immediately, so whatever this waits for *is* how
            // much of the sound is heard. MediaEnded is the only signal tied to
            // the audio rather than to a claim about its length; subscribed
            // before Play, and pumped like every other Dispatcher event.
            var playing = new DispatcherFrame();
            player.MediaEnded += delegate { playing.Continue = false; };
            player.Play();

            // NaturalDuration is a stall bound and never the playback length:
            // an MP3 with no Xing header has it extrapolated from the first
            // frame's bitrate and stated as certain, measured 34% and 40%
            // short. Doubled so an under-report cannot cut a clip off, and only
            // ever reached when MediaEnded does not arrive at all.
            int stallMs = 30000;
            if (player.NaturalDuration.HasTimeSpan) {
                stallMs = (int)Math.Min(
                    player.NaturalDuration.TimeSpan.TotalMilliseconds * 2 + 1000, 30000);
            }
            var stallGuard = new DispatcherTimer();
            stallGuard.Interval = TimeSpan.FromMilliseconds(stallMs);
            stallGuard.Tick += delegate { playing.Continue = false; };
            stallGuard.Start();
            Dispatcher.PushFrame(playing);
            stallGuard.Stop();

            player.Stop();
            player.Close();
            return 0;
        } catch {
            // WPF is absent on Server Core and trimmed images. Exiting non-zero
            // keeps that diagnosable through --wait rather than falling back to
            // a player that ignores volume.
            return 1;
        }
    }
}
`;

/**
 * Assemblies the player needs, and where the .NET Framework keeps them.
 *
 * They have to be located rather than named: `csc.exe` resolves framework
 * references from the Reference Assemblies directory, which is not present on
 * every Windows 11 install (it is absent on the machine this was developed on),
 * and it does not resolve from the GAC by simple name. PresentationCore is
 * architecture-specific so it lives under GAC_32/GAC_64 rather than GAC_MSIL,
 * which is why every root is searched for every assembly instead of assuming.
 */
const REQUIRED_ASSEMBLIES = ['PresentationCore', 'WindowsBase', 'System.Xaml'];

function gacRoots(env = process.env) {
  const windir = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const gac = path.join(windir, 'Microsoft.NET', 'assembly');
  // GAC_MSIL first: an architecture-neutral copy is the better reference, and
  // for two of the three assemblies it is the only one.
  return ['GAC_MSIL', 'GAC_64', 'GAC_32'].map((bucket) => path.join(gac, bucket));
}

/**
 * Absolute path to `name`.dll, or null. The version directory is globbed rather
 * than hard-coded: it carries the public key token, which differs per assembly
 * (`31bf3856ad364e35` for WPF, `b77a5c561934e089` for System.Xaml) and would be
 * one more thing to get wrong for no benefit.
 */
function findAssembly(name, roots = gacRoots()) {
  for (const root of roots) {
    const dir = path.join(root, name);
    let versions;
    try {
      versions = fs.readdirSync(dir).filter((v) => v.startsWith('v4.')).sort().reverse();
    } catch {
      continue;
    }
    for (const version of versions) {
      const dll = path.join(dir, version, `${name}.dll`);
      if (fs.existsSync(dll)) return dll;
    }
  }
  return null;
}

/** Every required assembly, or null if even one is missing. */
export function findAssemblies(roots = gacRoots()) {
  const found = REQUIRED_ASSEMBLIES.map((name) => findAssembly(name, roots));
  return found.every(Boolean) ? found : null;
}

/**
 * The C# compiler that ships with .NET Framework 4 — present on stock Windows
 * 10 and 11, so nothing has to be installed. 64-bit first, purely so the
 * compiled binary matches the PresentationCore that will be loaded at runtime.
 */
export function findCsc(env = process.env) {
  const windir = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  for (const framework of ['Framework64', 'Framework']) {
    const csc = path.join(windir, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(csc)) return csc;
  }
  return null;
}

/**
 * The binary is named after a hash of its own source, which is what makes
 * staleness impossible to get wrong: editing PLAYER_CS changes the filename, so
 * an existing file is by construction the current one and "does it exist" is
 * the whole check. It also makes the check one `stat` on the hot path, and lets
 * a half-installed old build sit harmlessly beside a new one.
 */
export function playerExeName() {
  const hash = crypto.createHash('sha256').update(PLAYER_CS).digest('hex').slice(0, 12);
  return `afxplay-${hash}.exe`;
}

export function playerExePath() {
  return path.join(agentfxHome(), playerExeName());
}

/**
 * Written when the binary cannot be produced, so the cost of finding that out
 * is paid once rather than on every hook fire. `warm()` clears it, which is how
 * a machine that later gains .NET recovers without the user knowing this file
 * exists.
 */
export function skipMarkerPath() {
  return path.join(agentfxHome(), 'afxplay.unavailable');
}

/** Old builds from a previous PLAYER_CS, which nothing will ever run again. */
function removeSupersededBuilds(keep) {
  try {
    for (const entry of fs.readdirSync(agentfxHome())) {
      if (/^afxplay-[0-9a-f]{12}\.exe$/.test(entry) && entry !== keep) {
        fs.rmSync(path.join(agentfxHome(), entry), { force: true });
      }
    }
  } catch {}
}

/**
 * Compiles the player. ~600ms, and only ever on a cache miss.
 *
 * @returns {string|null} the binary's path, or null with the skip marker set
 */
function compilePlayer(deps = {}) {
  const { csc = findCsc(), assemblies = findAssemblies(), run = spawnSync } = deps;
  const exe = playerExePath();

  if (!csc || !assemblies) {
    markUnavailable(csc ? 'WPF assemblies not found' : 'csc.exe not found');
    return null;
  }

  try {
    fs.mkdirSync(agentfxHome(), { recursive: true });
    const source = path.join(agentfxHome(), 'afxplay.cs');
    fs.writeFileSync(source, PLAYER_CS, 'utf8');

    // Compiled to a private name and renamed into place: rename is atomic on
    // NTFS, so a concurrent hook fire either sees no binary or sees a complete
    // one. Writing /out: straight to the real path would let a second fire find
    // and run a half-written executable.
    const pending = `${exe}.${process.pid}.tmp`;
    const result = run(
      csc,
      [
        '/nologo',
        // winexe, not exe: a console subsystem binary allocates a console when
        // the parent has none, which is the flashing-command-prompt regression
        // that `cmd start` was dropped for.
        '/target:winexe',
        '/optimize+',
        `/out:${pending}`,
        ...assemblies.map((dll) => `/r:${dll}`),
        source
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 60_000 }
    );

    if (result.error || result.status !== 0) {
      fs.rmSync(pending, { force: true });
      markUnavailable(result.error ? result.error.message : `csc exited ${result.status}`);
      return null;
    }

    fs.renameSync(pending, exe);
    removeSupersededBuilds(path.basename(exe));
    return exe;
  } catch (err) {
    markUnavailable(err.message);
    return null;
  }
}

function markUnavailable(reason) {
  try {
    fs.mkdirSync(agentfxHome(), { recursive: true });
    fs.writeFileSync(skipMarkerPath(), `${new Date().toISOString()} ${reason}\n`, 'utf8');
  } catch {}
}

/**
 * The compiled player if it is ready to run, else null.
 *
 * The hot path passes nothing, and then this is one `stat` in the common case
 * and never compiles: a hook fire must not pay 600ms because it happened to be
 * the first one. `warm()` is what builds it, from `sync` and `doctor`, where
 * blocking is free and expected.
 *
 * @param {{compile?: boolean}} options compile on a miss instead of declining
 */
export function ensurePlayerExe({ compile = false } = {}, deps = {}) {
  if (process.platform !== 'win32') return null;

  const exe = playerExePath();
  try {
    if (fs.statSync(exe).isFile()) return exe;
  } catch {}

  if (!compile) return null;
  try {
    if (fs.statSync(skipMarkerPath()).isFile()) return null;
  } catch {}

  return compilePlayer(deps);
}

/**
 * Builds the player now, retrying even if it failed before. Called from `sync`
 * and `doctor` so that by the time a hook fires the binary is already there,
 * and so a machine that has since gained .NET stops being written off.
 *
 * @returns {{ok: true, exe: string} | {ok: false, reason: string}}
 */
export function warmPlayerExe(deps = {}) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not Windows' };

  const ready = ensurePlayerExe({}, deps);
  if (ready) return { ok: true, exe: ready };

  fs.rmSync(skipMarkerPath(), { force: true });
  const exe = compilePlayer(deps);
  if (exe) return { ok: true, exe };

  let reason = 'could not compile the fast player';
  try {
    reason = fs.readFileSync(skipMarkerPath(), 'utf8').trim().split(' ').slice(1).join(' ');
  } catch {}
  return { ok: false, reason };
}
