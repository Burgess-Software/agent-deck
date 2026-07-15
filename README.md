# Agent Deck

The [Codex Micro](https://worklouder.cc/codex-micro) feature set as a Stream Deck plugin
for Linux (OpenDeck), controlling **both** the Claude Code desktop app and the Codex
desktop app.

## Feature mapping

| Codex Micro | Agent Deck |
|---|---|
| 6 RGB Agent Keys (live thread status) | **Agent Status Key** action — one per session slot; grey idle · orange (pulsing) working · blue needs input · green done. Press to focus that agent's window. |
| Command Keys (accept / reject / PTT / new chat) | **Command Key** action — presets for Accept (Enter), Reject/Interrupt (Esc), New chat (Ctrl+N), push-to-talk via each app's native dictation toggle (Ctrl+D in Claude Code, Ctrl+Shift+D in Codex), plus custom keystrokes/text/shell. |
| Joystick → 4 preset skills (review PR, debug, refactor) | **Skill Key** action — Review PR, Debug, Refactor, Write tests, Explain, Commit & push, or a custom prompt. Pastes into the app's chat input and (optionally) submits. |
| Dial → reasoning depth | **Reasoning Dial** action — cycles the *real* config: `effortLevel` in `~/.claude/settings.json`, `model_reasoning_effort` in `~/.codex/config.toml`. Works as a key (cycle) or a Stream Deck + encoder (rotate). |
| 6 layers + AppSense | **Target App Toggle** action — one key flips every "follow target" key between Claude and Codex. OpenDeck profiles cover the rest. |

## How it works

- **Claude Code status** comes from hooks (`SessionStart`, `UserPromptSubmit`,
  `Notification`, `Stop`, `SessionEnd`) installed in `~/.claude/settings.json`, which
  write per-session state files to `~/.local/share/agentdeck/state/claude/`.
- **Codex status** comes from polling `~/.codex/sessions/` rollout files (recent write =
  working, went quiet = done) plus a `notify` hook in `~/.codex/config.toml` for instant
  turn-complete / approval events.
- **Window focus** uses KWin's D-Bus scripting API (Wayland-native windows included).
- **Keystrokes** go through `ydotool`; **prompts** are injected via `wl-copy` + Ctrl+V
  (clipboard is restored afterwards).

## Install

```bash
node scripts/install.mjs   # icons, OpenDeck symlink, Claude hooks, Codex notify
# then restart OpenDeck
```

Requirements: OpenDeck, node ≥ 22, `ydotool` (with `ydotoold` running), `wl-clipboard`,
KDE Plasma (Wayland). Config backups are written next to the originals
(`*.bak-agentdeck-<date>`).

## Suggested 15-key layout (Stream Deck MK.1)

| | | | | |
|---|---|---|---|---|
| Agent 0 | Agent 1 | Agent 2 | Agent 3 | Agent 4 |
| Accept | Reject | New chat | Voice (PTT) | **Target toggle** |
| Review PR | Debug | Refactor | Tests | **Reasoning dial** |

Push-to-talk focuses the target app and sends its native dictation shortcut
(Ctrl+D in Claude Code, Ctrl+Shift+D in Codex). A custom shell command can
override it via the key's settings.

## Uninstall

Remove the symlink `~/.config/opendeck/plugins/com.thomasburgess.agentdeck.sdPlugin`,
the `agent-deck` hook entries in `~/.claude/settings.json`, the `notify` line in
`~/.codex/config.toml`, and `~/.local/share/agentdeck/`.
