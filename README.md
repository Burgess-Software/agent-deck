# Agent Deck

The [Codex Micro](https://worklouder.cc/codex-micro) feature set as a Stream Deck plugin
for Linux (OpenDeck), controlling the Codex desktop app.

## Feature mapping

| Codex Micro | Agent Deck |
|---|---|
| 6 RGB Agent Keys (live thread status) | **Agent Status Key** action — one per thread slot; grey idle · orange (pulsing) working · blue needs input · green done. Press to open that thread via `codex://threads/<id>`. |
| Command Keys (accept / reject / PTT / new chat) | **Command Key** action — presets for Accept (Enter), Reject/Interrupt (Esc), New chat (Ctrl+N), plus custom keystrokes/text/shell. Push-to-talk is true hold-to-talk: Codex dictation records while Ctrl+Shift+D is held, so the deck key holds the shortcut down for as long as you hold the key. |
| Joystick → 4 preset skills (review PR, debug, refactor) | **Skill Key** action — Review PR, Debug, Refactor, Write tests, Explain, Commit & push, or a custom prompt. Pastes into the composer and (optionally) submits. |
| Dial → reasoning depth | **Reasoning Dial** action — sends Codex's *Cycle reasoning effort* command to the **current thread** (Light → … → Ultra). That command has no default shortcut, so bind one in Codex → Settings → Keyboard Shortcuts and enter the same combo in the key's settings (default `ctrl+alt+r`). Works as a key (cycle) or a Stream Deck + encoder (increase/decrease). |

## How it works

- **Thread status** comes from polling `~/.codex/sessions/` rollout files (recent write =
  working, went quiet = done) plus a `notify` hook in `~/.codex/config.toml` for instant
  turn-complete / approval events. Rollout files are deduped by session id — Codex writes
  a new file per resume of the same thread.
- **Thread switching** uses the `codex://threads/<id>` deep link.
- **Window focus** uses KWin's D-Bus scripting API (Wayland-native windows included).
- **Keystrokes** go through `ydotool`, guarded by an active-window check so nothing lands
  in other apps; **prompts** are injected via `wl-copy` + Ctrl+V (clipboard restored).

## Install

```bash
node scripts/install.mjs                     # icons, OpenDeck copy, Codex notify
node scripts/gen-profile.mjs <sd-device-id>  # optional: pre-built 15-key profile
# then restart OpenDeck
```

Requirements: OpenDeck, node ≥ 22, `ydotool` (with `ydotoold` running), `wl-clipboard`,
KDE Plasma (Wayland). Config backups are written next to the originals
(`*.bak-agentdeck-<date>`). Re-run install after editing plugin source.

## 15-key layout (Stream Deck MK.1)

| | | | | |
|---|---|---|---|---|
| Thread 0 | Thread 1 | Thread 2 | Thread 3 | Thread 4 |
| Accept | Reject | New chat | Voice (PTT) | Stop |
| Review PR | Debug | Refactor | Tests | **Reasoning dial** |

## Uninstall

Remove `~/.config/opendeck/plugins/com.thomasburgess.agentdeck.sdPlugin`, the `notify`
line in `~/.codex/config.toml`, and `~/.local/share/agentdeck/`.

## History

An earlier version also controlled the Claude Code desktop app. That was dropped:
Claude desktop has no deep link for switching to local sessions (`claude://code/*` only
accepts cloud `cse_…` ids and `claude://resume` imports a duplicate), and driving its
Ctrl+K switcher with synthetic keys proved too fragile. The code is in git history
(`git log` around 2026-07-15) if it's ever worth revisiting.
