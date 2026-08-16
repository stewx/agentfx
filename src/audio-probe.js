import { spawnSync } from 'node:child_process';
import { encodePowerShell, resolvePlayback } from './player.js';

/**
 * Measuring whether a sound actually reached the speakers.
 *
 * Every other check in agentfx can only report that a player exited 0, and this
 * project has been bitten repeatedly by the gap between those two things: a
 * detached spawn killed before it reached Play(), an .ogg that decoded to
 * nothing, a hidden launcher that never launched. All exited 0.
 *
 * Windows exposes IAudioMeterInformation on the default render endpoint, which
 * reads ~0 in silence and rises while audio renders. Sampling it around a real
 * playback turns "I can't hear anything" into a number, which is the only
 * honest basis for `doctor` to claim audio works.
 *
 * There is no equivalent that is cheap and dependency-free on macOS or Linux,
 * so this is deliberately Windows-only: elsewhere the doctor falls back to
 * reporting the exit status and says which one it did.
 */

/** Just enough COM to read the endpoint's peak meter, volume and mute state. */
const METER_INTEROP = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] [ComImport] public class MMDeviceEnumerator { }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport] public interface IMMDeviceEnumerator {
  int NotImpl1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport] public interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
    [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport] public interface IAudioMeterInformation { int GetPeakValue(out float peak); }

// Every method must be declared in vtable order even though only the last two
// are called: the offsets of GetMute and GetMasterVolumeLevelScalar depend on
// the ones above them being present.
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport] public interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr n); int UnregisterControlChangeNotify(IntPtr n);
  int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float l, ref Guid c);
  int SetMasterVolumeLevelScalar(float l, ref Guid c);
  int GetMasterVolumeLevel(out float l);
  int GetMasterVolumeLevelScalar(out float l);
  int SetChannelVolumeLevel(uint ch, float l, ref Guid c);
  int SetChannelVolumeLevelScalar(uint ch, float l, ref Guid c);
  int GetChannelVolumeLevel(uint ch, out float l);
  int GetChannelVolumeLevelScalar(uint ch, out float l);
  int SetMute(bool m, ref Guid c);
  int GetMute(out bool m);
}

public static class Audio {
  static IAudioMeterInformation meter;
  static IAudioEndpointVolume volume;

  static void Init() {
    if (meter != null) return;
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev; en.GetDefaultAudioEndpoint(0, 0, out dev);
    object o;
    var mid = typeof(IAudioMeterInformation).GUID;
    dev.Activate(ref mid, 1, IntPtr.Zero, out o); meter = (IAudioMeterInformation)o;
    var vid = typeof(IAudioEndpointVolume).GUID;
    dev.Activate(ref vid, 1, IntPtr.Zero, out o); volume = (IAudioEndpointVolume)o;
  }

  public static float Peak() { Init(); float p; meter.GetPeakValue(out p); return p; }
  public static float Volume() { Init(); float v; volume.GetMasterVolumeLevelScalar(out v); return v; }
  public static bool Muted() { Init(); bool m; volume.GetMute(out m); return m; }

  public static float MaxPeak(int ms) {
    Init();
    float max = 0;
    var sw = System.Diagnostics.Stopwatch.StartNew();
    while (sw.ElapsedMilliseconds < ms) {
      float p; meter.GetPeakValue(out p);
      if (p > max) max = p;
      System.Threading.Thread.Sleep(15);
    }
    return max;
  }
}
'@`;

/** Anything above this at the endpoint is audio rendering rather than noise. */
export const AUDIBLE_THRESHOLD = 0.005;

/**
 * A PowerShell single-quoted literal. Single quotes because a path may contain
 * `$` or a backtick, which a double-quoted string would expand — and the
 * strings being quoted here are a sound file's name and a path under the user's
 * profile, neither of which agentfx chose.
 */
const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * The measuring script. Runs the real player as a child so what gets verified
 * is the command agentfx would actually use, not a re-implementation of it.
 *
 * That is why this takes a resolved backend rather than an encoded script: the
 * command a hook fire runs is now usually the compiled player, and a probe that
 * kept measuring PowerShell would be reporting on a code path the user's
 * machine no longer takes.
 *
 * @param {{command: string, args: string[]}} backend from `resolvePlayback`
 */
export function buildProbeScript(backend) {
  const argList = backend.args.map(psLiteral).join(',');

  return [
    METER_INTEROP,
    '$deviceVolume = [Audio]::Volume();',
    '$muted = [Audio]::Muted();',
    // Establish the noise floor first: a peak means nothing without it, and
    // other applications may be playing audio right now.
    '$baseline = [Audio]::MaxPeak(300);',
    `$args = @(${argList});`,
    `$proc = Start-Process -FilePath ${psLiteral(backend.command)} ` +
      '-ArgumentList $args -PassThru -WindowStyle Hidden;',
    '$peak = 0.0;',
    'while (-not $proc.HasExited) { $p = [Audio]::Peak(); if ($p -gt $peak) { $peak = $p }; Start-Sleep -Milliseconds 15 };',
    // Keep listening briefly: the process can exit while the endpoint drains.
    '$sw = [Diagnostics.Stopwatch]::StartNew();',
    'while ($sw.ElapsedMilliseconds -lt 400) { $p = [Audio]::Peak(); if ($p -gt $peak) { $peak = $p }; Start-Sleep -Milliseconds 15 };',
    'Write-Output (ConvertTo-Json -Compress @{ deviceVolume = $deviceVolume; muted = $muted; ' +
      'baseline = $baseline; peak = $peak; exit = $proc.ExitCode });'
  ].join('\n');
}

export function canProbe(platform = process.platform) {
  return platform === 'win32';
}

/**
 * Plays `file` and measures whether anything came out.
 *
 * @returns {{supported: false, reason: string}
 *   | {supported: true, audible: boolean, peak: number, baseline: number,
 *      deviceVolume: number, muted: boolean, exit: number}}
 */
export function probePlayback(file, gain = 0.6, platform = process.platform) {
  if (!canProbe(platform)) {
    return { supported: false, reason: 'peak metering is only available on Windows' };
  }

  const backend = resolvePlayback(file, gain, platform);
  if (!backend) return { supported: false, reason: 'no metered backend for this platform' };

  const script = buildProbeScript(backend);
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
  );

  if (result.error) return { supported: false, reason: result.error.message };

  try {
    // Add-Type compiles C#, which Constrained Language Mode blocks outright —
    // and that is itself one of the conditions the doctor exists to find, so
    // the failure is reported rather than swallowed.
    const parsed = JSON.parse(String(result.stdout).trim().split('\n').pop());
    return {
      supported: true,
      audible: parsed.peak > AUDIBLE_THRESHOLD,
      peak: parsed.peak,
      baseline: parsed.baseline,
      deviceVolume: parsed.deviceVolume,
      muted: parsed.muted,
      exit: parsed.exit
    };
  } catch {
    const stderr = String(result.stderr ?? '').trim().split('\n')[0];
    return { supported: false, reason: stderr || 'the meter returned nothing readable' };
  }
}
