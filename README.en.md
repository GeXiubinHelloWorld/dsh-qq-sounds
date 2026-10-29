# dsh-qq-sounds

**QQ-style sounds for DeepSeek Harness.** When DSH finishes a task it plays the QQ "friend message" blip; when it needs your approval or an answer it plays the QQ "system message" tone — so you don't have to stare at the window.

[中文](README.md) | English

## What it does

| When | Default sound |
|---|---|
| Task finished (`turn/end` · completed) | QQ `msg.wav` |
| Needs approval / permission (`approval/asked`) | QQ `system.wav`, **repeats until handled** |
| Needs an answer (`ask_user_question`) | QQ `system.wav`, **repeats until handled** |
| Task errored (`turn/end` · error) | built-in low tone (off by default) |

- **Uses your own QQ sound files.** The host half auto-detects the QQ install directory (registry uninstall entries + common paths) and reads `Misc\Sound\Classic\*.wav`; you can also type any local audio path.
- **Works without QQ.** Two built-in "QQ-like" synthesized tones ship with the plugin (no Tencent audio inside).
- **Repeat reminders** for unhandled approvals / questions (default 25–30s, 4–6 times), stopped by a click, returning to the window, or the attempt cap.
- **Quiet by design:** quiet hours (cross-midnight), "only when DSH is not focused", 0–100% volume.
- **Away from the desk:** optional desktop notification (click to focus) + 🔔 in the window title.
- **Per-event configuration:** each of the four events has its own sound, mute, or off switch.

## Install

Via the DSH GUI: **Plugins → Add plugin** → `dsh-qq-sounds` → restart DSH → **Settings → QQ 提醒音**.

Or:

```sh
dsh plugin --profile <your-profile> add dsh-qq-sounds
# or from source
dsh plugin --profile <your-profile> add github:GeXiubinHelloWorld/dsh-qq-sounds
```

`<your-profile>` is the directory name under `~/.dsh/profiles/` (usually `web` or `desktop`). A restart is required: the bundle list is only read at boot.

## First run

1. Restart DSH.
2. **Settings → QQ 提醒音** should show "✓ 音频已解锁". If not, click anywhere on the page (browsers require a user gesture before playing audio).
3. The QQ section should show your `Misc\Sound\Classic` directory. If it doesn't, click **重新检测** or type the QQ install directory by hand.
4. Preview `msg` / `system`, then tune repeat reminders and quiet hours.

## How it works

```
Host process
  ├─ ctx.on("session/event") → detect completed / approval / question / error
  │                          → filter master switch, per-event switch, quiet hours, 5s debounce
  │                          → append to a 64-entry ring log (id cursor + bootId)
  └─ ctx.webServer.register("/api/qq-sounds/{config,detect,poll,audio,health}")   (loopback only)
Browser (the GUI page)
  └─ polls /api/qq-sounds/poll?since=<cursor> every 1.2s → play / notify / badge
```

No `@deepseek-ai/*` imports on the host side: only `node:` built-ins plus the public `webServer` service, so the plugin installs into any profile without peer-dependency resolution problems.

## Privacy & security

- All five routes accept **loopback requests only**; remote callers get 403.
- Only audio files (`wav/mp3/ogg/m4a/aac/flac/webm`) up to 4 MB can be read; everything else is rejected.
- The plugin makes **no outbound network requests** and sends no telemetry.
- Event log is memory-only (64 entries), never persisted or uploaded.

## Licensing

Plugin code is MIT. **QQ sound files are Tencent's copyrighted assets** — this plugin does not bundle, copy, or redistribute them; it only reads the copy inside your own QQ installation at play time. Only self-made synthesized tones ship in this repository and on npm.

## Development

```
dsh-qq-sounds/
├─ package.json        # dsh.bundle.patch + dsh.client (platform: web)
├─ cordis.patch.yml    # profile patch layer: insert id=qq-sounds
├─ lib/host.js         # host half
├─ lib/client.js       # browser half (prebuilt ModuleLoader bundle, no build step)
└─ test/               # node --test: host logic, route E2E, client load & render
```

```sh
node --test test/
```

Editing `lib/client.js` is hot-swapped by DSH's client HMR (refresh the page); `lib/host.js`, `package.json` and `cordis.patch.yml` need a restart.
