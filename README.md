# Agent Deck

The [Codex Micro](https://worklouder.cc/codex-micro) feature set as a Stream Deck plugin
for Linux (OpenDeck), controlling the Codex desktop app.

## Feature mapping

| Codex Micro | Agent Deck |
|---|---|
| 6 RGB Agent Keys (live thread status) | **Agent Status Key** action — the default profile provides 10 stable thread slots with color-only backgrounds so labels stay clear; grey idle · orange (pulsing) working · blue needs input · green done. Press to open that thread via `codex://threads/<id>`. |
| Command Keys (accept / reject / PTT / new chat) | **Command Key** action — presets for Accept (Enter), Reject/Interrupt (Esc), New chat (Ctrl+N), plus custom keystrokes/text/shell. Push-to-talk is true hold-to-talk: Codex dictation records while Ctrl+Shift+D is held, so the deck key holds the shortcut down for as long as you hold the key. |
| Joystick → 4 preset skills (review PR, debug, refactor) | **Skill Key** action (available but not in the default layout) — Review PR, Debug, Refactor, Write tests, Explain, Commit & push, or a custom prompt. Pastes into the composer and (optionally) submits. |
| Dial → reasoning depth | **Reasoning Dial** action — sends Codex's *Cycle reasoning effort* command to the **current thread** (Light → … → Ultra) via `Ctrl+Alt+E`. That command has no default shortcut, so the binding is provisioned in `~/.codex/keybindings.json` (installer writes it). Works as a key (cycle) or a Stream Deck + encoder (Ctrl+Alt+Up / Down). |
| — | **Model Switcher** action — opens Codex's model picker on the current thread (Ctrl+Shift+M, built in). |
| — | **Weekly Usage** action — shows your Codex weekly capacity remaining (calculated from the session's rate-limit data); ring is green/amber/red, press to refresh. In the default profile, thread slot 9 shows it whenever vacant. |

## How it works

- **Thread status** comes from polling `~/.codex/sessions/` rollout files (recent write =
  working, went quiet = done) plus a `notify` hook in `~/.codex/config.toml` for instant
  turn-complete / approval events. Rollout files are deduped by session id — Codex writes
  a new file per resume of the same thread.
- **Thread slots stay stable** while activity changes: existing chats update in place instead
  of being re-sorted on every rollout write. Assignments survive plugin restarts. A new or
  resumed chat fills a vacancy, or replaces only the least-recent slot when the deck is full.
  When capacity drops below ten, only the last-slot session may move into an earlier vacancy
  so the remaining-capacity display can return; all other surviving sessions stay in place.
- **The last thread slot shows weekly capacity remaining while vacant.** A tenth active chat
  replaces that display automatically, and it returns when the slot becomes empty again.
- **Thread labels** show the Codex-generated chat title above the git project name, making
  multiple chats in the same project distinguishable at a glance. New chats briefly fall
  back to the first user message until Codex writes their generated title.
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
| Thread 5 | Thread 6 | Thread 7 | Thread 8 | Thread 9 / Weekly capacity left when empty |
| Accept | Reject | New chat | Voice (PTT) | Stop |

Model, weekly capacity, reasoning, and skill actions remain available in OpenDeck's
action list for custom profiles, but are not part of the default 15-key layout.

## Uninstall

Remove `~/.config/opendeck/plugins/com.thomasburgess.agentdeck.sdPlugin`, the `notify`
line in `~/.codex/config.toml`, and `~/.local/share/agentdeck/`.

## History

An earlier version also controlled the Claude Code desktop app. That was dropped:
Claude desktop has no deep link for switching to local sessions (`claude://code/*` only
accepts cloud `cse_…` ids and `claude://resume` imports a duplicate), and driving its
Ctrl+K switcher with synthetic keys proved too fragile. The code is in git history
(`git log` around 2026-07-15) if it's ever worth revisiting.
