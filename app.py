import asyncio
import json
import random
import string
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates


BASE_DIR = Path(__file__).parent
app = FastAPI(title="Midnight Werewolf")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


ROLES = [
    "Werewolf",
    "Seer",
    "Robber",
    "Troublemaker",
    "Insomniac",
    "Villager",
    "Villager",
    "Villager",
    "Villager",
    "Villager",
]

# Roles that need an interactive tap action from the player
INTERACTIVE_ROLES = {"Seer", "Robber", "Troublemaker"}
# Roles auto-resolved when their phase starts (no tap needed)
AUTO_ROLES = {"Werewolf", "Insomniac"}


def make_code() -> str:
    return "".join(random.choice(string.ascii_uppercase) for _ in range(5))


def role_script(selected_roles: list[str]) -> list[dict]:
    role_set = set(selected_roles)
    steps = [
        {"title": "Night Starts", "message": "Everyone close your eyes.", "seconds": 8},
        {
            "title": "Werewolves",
            "message": "Werewolves: open your eyes and find each other.",
            "seconds": 10,
            "role": "Werewolf",
            "interactive": False,
        },
    ]
    if "Seer" in role_set:
        steps.append(
            {
                "title": "Seer",
                "message": "Seer: tap a player card to peek their role, or tap two center cards.",
                "seconds": 15,
                "role": "Seer",
                "interactive": True,
            }
        )
    if "Robber" in role_set:
        steps.append(
            {
                "title": "Robber",
                "message": "Robber: tap a player card to swap roles with them.",
                "seconds": 15,
                "role": "Robber",
                "interactive": True,
            }
        )
    if "Troublemaker" in role_set:
        steps.append(
            {
                "title": "Troublemaker",
                "message": "Troublemaker: tap two other players to swap their roles.",
                "seconds": 15,
                "role": "Troublemaker",
                "interactive": True,
            }
        )
    if "Insomniac" in role_set:
        steps.append(
            {
                "title": "Insomniac",
                "message": "Insomniac: checking your final role...",
                "seconds": 8,
                "role": "Insomniac",
                "interactive": False,
            }
        )

    steps.extend(
        [
            {"title": "Wake Up", "message": "Everyone opens eyes. Discuss now.", "seconds": 60},
            {"title": "Vote", "message": "Time to vote who is a werewolf.", "seconds": 20},
            {"title": "Reveal", "message": "Reveal roles and check if village wins.", "seconds": 9999},
        ]
    )
    return steps


@dataclass
class Player:
    id: str
    name: str
    role: str | None = None


@dataclass
class Lobby:
    code: str
    players: dict[str, Player] = field(default_factory=dict)
    admin_id: str | None = None
    selected_roles: list[str] = field(default_factory=lambda: ["Werewolf", "Werewolf", "Seer", "Villager"])
    started: bool = False
    step_index: int = -1
    step_started_at: float | None = None
    script: list[dict] = field(default_factory=list)
    task: asyncio.Task | None = None
    # New fields for interactive night actions
    center_cards: list[str] = field(default_factory=list)
    original_roles: dict[str, str] = field(default_factory=dict)   # player_id -> role at game start
    current_roles: dict[str, str] = field(default_factory=dict)    # player_id -> live role (mutated)
    night_actions_done: set = field(default_factory=set)            # player_ids who completed action
    player_order: list[str] = field(default_factory=list)           # stable seat order for circle UI


lobbies: dict[str, Lobby] = {}
connections: dict[str, WebSocket] = {}


def lobby_state(lobby: Lobby) -> dict:
    return {
        "code": lobby.code,
        "players": [
            {"id": p.id, "name": p.name, "is_admin": p.id == lobby.admin_id}
            for p in lobby.players.values()
        ],
        "started": lobby.started,
        "selected_roles": lobby.selected_roles,
        "step_index": lobby.step_index,
        "step": lobby.script[lobby.step_index] if lobby.started and lobby.step_index >= 0 else None,
        "step_started_at": lobby.step_started_at,
        "player_order": lobby.player_order,
        "center_card_count": len(lobby.center_cards),
    }


async def send_to_player(player_id: str, payload: dict):
    ws = connections.get(player_id)
    if ws:
        await ws.send_text(json.dumps(payload))


async def broadcast(lobby: Lobby, payload: dict):
    for player in list(lobby.players.values()):
        ws = connections.get(player.id)
        if ws:
            await ws.send_text(json.dumps(payload))


async def emit_state(lobby: Lobby):
    await broadcast(lobby, {"type": "state", "state": lobby_state(lobby)})
    for player in lobby.players.values():
        # Send current role (post-swap) rather than original assigned role
        current_role = lobby.current_roles.get(player.id, player.role) if lobby.started else None
        await send_to_player(
            player.id,
            {"type": "private_role", "role": current_role},
        )


def ensure_admin(lobby: Lobby):
    if lobby.admin_id in lobby.players:
        return
    lobby.admin_id = next(iter(lobby.players.keys()), None)


def assign_roles(lobby: Lobby):
    roles = list(lobby.selected_roles)
    n_players = len(lobby.players)
    # Need player count + 3 center cards
    total_needed = n_players + 3
    while len(roles) < total_needed:
        roles.append("Villager")
    random.shuffle(roles)

    player_list = list(lobby.players.values())
    for idx, player in enumerate(player_list):
        player.role = roles[idx]

    lobby.center_cards = roles[n_players:n_players + 3]

    # Build role dicts
    lobby.original_roles = {p.id: p.role for p in player_list}
    lobby.current_roles = {p.id: p.role for p in player_list}
    # Also track center cards in current_roles using stable keys
    for i, card in enumerate(lobby.center_cards):
        lobby.current_roles[f"center_{i}"] = card

    # Set stable player order for circle UI
    lobby.player_order = [p.id for p in player_list]


# ---------------------------------------------------------------------------
# Night action auto-resolvers (no player tap needed)
# ---------------------------------------------------------------------------

async def auto_resolve_werewolf(lobby: Lobby):
    """Send each werewolf the list of other werewolves."""
    werewolf_ids = [pid for pid, role in lobby.current_roles.items() if role == "Werewolf" and pid in lobby.players]
    werewolf_names = [lobby.players[pid].name for pid in werewolf_ids]

    for pid in werewolf_ids:
        others = [name for wid, name in zip(werewolf_ids, werewolf_names) if wid != pid]
        if others:
            msg = f"Your fellow werewolves: {', '.join(others)}"
        else:
            msg = "You are the only werewolf. You may peek at one center card (but no tap needed — just remember)."
        await send_to_player(pid, {
            "type": "night_result",
            "role": "Werewolf",
            "message": msg,
            "reveals": {wid: "Werewolf" for wid in werewolf_ids},
        })


async def auto_resolve_insomniac(lobby: Lobby):
    """Send each insomniac their current (final) role."""
    for pid, player in lobby.players.items():
        if lobby.original_roles.get(pid) == "Insomniac":
            final_role = lobby.current_roles.get(pid, "Insomniac")
            await send_to_player(pid, {
                "type": "night_result",
                "role": "Insomniac",
                "message": f"Your final role is: {final_role}",
                "reveals": {pid: final_role},
            })


# ---------------------------------------------------------------------------
# Night action resolvers (player taps a card)
# ---------------------------------------------------------------------------

async def resolve_seer(lobby: Lobby, player_id: str, targets: list[str]) -> bool:
    """Seer peeks at 1 player OR 2 center cards."""
    center_keys = {f"center_{i}" for i in range(3)}
    player_ids = set(lobby.players.keys())

    is_one_player = len(targets) == 1 and targets[0] in player_ids and targets[0] != player_id
    is_two_centers = len(targets) == 2 and all(t in center_keys for t in targets)

    if not is_one_player and not is_two_centers:
        await send_to_player(player_id, {
            "type": "action_error",
            "message": "Tap ONE player card, or TWO center cards.",
        })
        return False

    reveals = {t: lobby.current_roles[t] for t in targets if t in lobby.current_roles}
    if is_one_player:
        target_name = lobby.players[targets[0]].name
        msg = f"{target_name}'s role is: {lobby.current_roles.get(targets[0], '?')}"
    else:
        msgs = [f"Center {i+1}: {lobby.current_roles.get(t, '?')}" for i, t in enumerate(targets)]
        msg = " | ".join(msgs)

    await send_to_player(player_id, {
        "type": "action_ack",
        "role": "Seer",
        "message": msg,
        "reveals": reveals,
    })
    return True


async def resolve_robber(lobby: Lobby, player_id: str, targets: list[str]) -> bool:
    """Robber swaps roles with one player, then sees their new role."""
    if len(targets) != 1 or targets[0] not in lobby.players or targets[0] == player_id:
        await send_to_player(player_id, {
            "type": "action_error",
            "message": "Tap ONE other player card to rob.",
        })
        return False

    target_id = targets[0]
    # Swap current roles
    lobby.current_roles[player_id], lobby.current_roles[target_id] = (
        lobby.current_roles[target_id],
        lobby.current_roles[player_id],
    )
    new_role = lobby.current_roles[player_id]
    target_name = lobby.players[target_id].name

    await send_to_player(player_id, {
        "type": "action_ack",
        "role": "Robber",
        "message": f"You swapped with {target_name}. Your new role is: {new_role}",
        "reveals": {player_id: new_role},
        "your_new_role": new_role,
    })
    return True


async def resolve_troublemaker(lobby: Lobby, player_id: str, targets: list[str]) -> bool:
    """Troublemaker swaps two other players' roles (without seeing them)."""
    player_ids = set(lobby.players.keys()) - {player_id}
    if len(targets) != 2 or not all(t in player_ids for t in targets) or targets[0] == targets[1]:
        await send_to_player(player_id, {
            "type": "action_error",
            "message": "Tap TWO other player cards to swap.",
        })
        return False

    t1, t2 = targets
    lobby.current_roles[t1], lobby.current_roles[t2] = lobby.current_roles[t2], lobby.current_roles[t1]
    name1 = lobby.players[t1].name
    name2 = lobby.players[t2].name

    await send_to_player(player_id, {
        "type": "action_ack",
        "role": "Troublemaker",
        "message": f"You swapped {name1} and {name2}'s roles.",
        "reveals": {},
    })
    return True


async def handle_night_action(lobby: Lobby, player_id: str, targets: list[str]):
    """Dispatch a player's night action to the correct resolver."""
    if not lobby.started or lobby.step_index < 0:
        return
    step = lobby.script[lobby.step_index]
    if not step.get("interactive"):
        return

    player = lobby.players.get(player_id)
    if not player:
        return

    # The acting role must match this phase
    acting_role = step.get("role")
    player_current_role = lobby.current_roles.get(player_id)
    # Use original role to determine who acts (role assignment is at game start)
    player_original_role = lobby.original_roles.get(player_id)

    if player_original_role != acting_role:
        await send_to_player(player_id, {
            "type": "action_error",
            "message": "It's not your turn to act.",
        })
        return

    if player_id in lobby.night_actions_done:
        await send_to_player(player_id, {
            "type": "action_error",
            "message": "You already submitted your action.",
        })
        return

    success = False
    if acting_role == "Seer":
        success = await resolve_seer(lobby, player_id, targets)
    elif acting_role == "Robber":
        success = await resolve_robber(lobby, player_id, targets)
    elif acting_role == "Troublemaker":
        success = await resolve_troublemaker(lobby, player_id, targets)

    if success:
        lobby.night_actions_done.add(player_id)
        # Broadcast updated state so role card updates if needed
        await emit_state(lobby)


async def run_script(lobby: Lobby):
    while lobby.started and lobby.step_index < len(lobby.script):
        step = lobby.script[lobby.step_index]

        # Auto-resolve roles that don't require a tap
        role = step.get("role")
        if role == "Werewolf":
            await auto_resolve_werewolf(lobby)
        elif role == "Insomniac":
            await auto_resolve_insomniac(lobby)

        # Clear done actions for this new phase
        lobby.night_actions_done = set()

        await emit_state(lobby)
        if step["seconds"] >= 9999:
            return
        await asyncio.sleep(step["seconds"])
        lobby.step_index += 1
        lobby.step_started_at = time.time()
    await emit_state(lobby)


def ensure_admin(lobby: Lobby):
    if lobby.admin_id in lobby.players:
        return
    lobby.admin_id = next(iter(lobby.players.keys()), None)


@app.get("/", response_class=HTMLResponse)
async def index():
    return templates.get_template("index.html").render()


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    player_id = None
    lobby: Lobby | None = None
    try:
        while True:
            data = json.loads(await ws.receive_text())
            msg_type = data.get("type")

            if msg_type == "create_lobby":
                name = (data.get("name") or "Player").strip()[:24]
                player_id = uuid.uuid4().hex[:8]
                code = make_code()
                while code in lobbies:
                    code = make_code()
                lobby = Lobby(code=code)
                player = Player(id=player_id, name=name)
                lobby.players[player_id] = player
                lobby.admin_id = player_id
                lobbies[code] = lobby
                connections[player_id] = ws
                await send_to_player(player_id, {"type": "joined", "player_id": player_id, "code": code})
                await emit_state(lobby)
                continue

            if msg_type == "join_lobby":
                name = (data.get("name") or "Player").strip()[:24]
                code = (data.get("code") or "").strip().upper()
                lobby = lobbies.get(code)
                if not lobby:
                    await ws.send_text(json.dumps({"type": "error", "message": "Lobby not found."}))
                    continue
                if lobby.started:
                    await ws.send_text(json.dumps({"type": "error", "message": "Game already started."}))
                    continue
                player_id = uuid.uuid4().hex[:8]
                player = Player(id=player_id, name=name)
                lobby.players[player_id] = player
                connections[player_id] = ws
                await send_to_player(player_id, {"type": "joined", "player_id": player_id, "code": code})
                await emit_state(lobby)
                continue

            if not player_id or not lobby:
                await ws.send_text(json.dumps({"type": "error", "message": "Join a lobby first."}))
                continue

            if msg_type == "set_roles":
                if player_id != lobby.admin_id:
                    continue
                roles = data.get("roles") or []
                cleaned = [r for r in roles if r in {"Werewolf", "Seer", "Robber", "Troublemaker", "Insomniac", "Villager"}]
                lobby.selected_roles = cleaned or ["Werewolf", "Werewolf", "Seer", "Villager"]
                await emit_state(lobby)

            elif msg_type == "start_game":
                if player_id != lobby.admin_id:
                    continue
                if len(lobby.players) < 2:
                    await send_to_player(player_id, {"type": "error", "message": "Need at least 2 players."})
                    continue
                lobby.started = True
                assign_roles(lobby)
                lobby.script = role_script(lobby.selected_roles)
                lobby.step_index = 0
                lobby.step_started_at = time.time()
                lobby.task = asyncio.create_task(run_script(lobby))

            elif msg_type == "next_step":
                if player_id != lobby.admin_id or not lobby.started:
                    continue
                if lobby.step_index < len(lobby.script) - 1:
                    lobby.step_index += 1
                    lobby.step_started_at = time.time()
                    await emit_state(lobby)

            elif msg_type == "reset_game":
                if player_id != lobby.admin_id:
                    continue
                if lobby.task:
                    lobby.task.cancel()
                lobby.started = False
                lobby.step_index = -1
                lobby.step_started_at = None
                lobby.script = []
                lobby.center_cards = []
                lobby.original_roles = {}
                lobby.current_roles = {}
                lobby.night_actions_done = set()
                lobby.player_order = []
                for p in lobby.players.values():
                    p.role = None
                await emit_state(lobby)

            elif msg_type == "night_action":
                if lobby.started:
                    targets = data.get("targets") or []
                    await handle_night_action(lobby, player_id, targets)

    except WebSocketDisconnect:
        pass
    finally:
        if player_id:
            connections.pop(player_id, None)
        if lobby and player_id and player_id in lobby.players:
            lobby.players.pop(player_id, None)
            ensure_admin(lobby)
            if not lobby.players:
                if lobby.task:
                    lobby.task.cancel()
                lobbies.pop(lobby.code, None)
            else:
                await emit_state(lobby)
