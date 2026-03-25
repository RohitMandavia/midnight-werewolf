# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8001 --reload
```

Access at `http://localhost:8001`. Players on the same Wi-Fi join via `http://<local-ip>:8001` (find IP with `ipconfig getifaddr en0`).

## Architecture

**Single-file backend** (`app.py`) — FastAPI + WebSockets with all game logic in one module. No database; all state lives in the in-memory `lobbies` dict.

**Real-time communication** — every state change calls `emit_state(lobby)`, which broadcasts a `state` message to all players and sends each player a private `private_role` message with their current role. The frontend never polls; it only reacts to WebSocket messages.

**Night phase flow:**
1. `run_script()` is an async task that advances through `lobby.script` (list of steps) on timers.
2. When a step has `"interactive": true` (Seer, Robber, Troublemaker), players with that original role can submit a `night_action` message with `targets`.
3. Auto-resolve roles (Werewolf, Insomniac) fire automatically in `run_script()` before `emit_state`.
4. Role resolvers (`resolve_seer`, `resolve_robber`, `resolve_troublemaker`) mutate `lobby.current_roles` and send private `action_ack` messages.

**Role identity:** `original_roles` = roles at game start (determines who acts). `current_roles` = live roles after swaps (what Insomniac/Reveal shows). Center cards stored as `current_roles["center_0/1/2"]`.

**Frontend** (`static/app.js`) — vanilla JS, single WebSocket connection. `renderGame()` is the main render function called on every `state` message. Circle table layout uses trigonometric positioning (angle per seat → CSS `left`/`top` on absolute-positioned seats inside a relative container).

## WebSocket message protocol

| Direction | Type | Key fields |
|---|---|---|
| client→server | `create_lobby` | `name` |
| client→server | `join_lobby` | `name`, `code` |
| client→server | `set_roles` | `roles[]` |
| client→server | `start_game` | — |
| client→server | `next_step` | — |
| client→server | `reset_game` | — |
| client→server | `night_action` | `targets[]` (player IDs or `center_0/1/2`) |
| server→client | `state` | full lobby state (no role info) |
| server→client | `private_role` | `role` (current role for that player) |
| server→client | `night_result` | `role`, `message`, `reveals` (auto-resolve) |
| server→client | `action_ack` | `role`, `message`, `reveals`, `your_new_role?` |
| server→client | `action_error` | `message` |

## Images

Role card images live in `static/images/{role_lowercase}.png` (e.g. `werewolf.png`). The card back is `static/images/card-back.png`. All are 200×300px. Swap files in place to update art without any code changes.
