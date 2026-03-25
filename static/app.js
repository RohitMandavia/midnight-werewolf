const wsProto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsProto}://${location.host}/ws`);

const $ = (s) => document.querySelector(s);
const state = {
  me: null,
  code: null,
  lobby: null,
  role: null,           // my original role
  currentRole: null,    // my role after possible swaps
  selectedTargets: [],  // targets chosen during night action
  actionDone: false,    // whether I already submitted this phase
};

let timerInterval = null;

function send(payload) {
  ws.send(JSON.stringify(payload));
}

function showError(msg) {
  const e1 = $("#errorMsg");
  if (e1) e1.textContent = msg || "";
  const e2 = $("#errorMsgGame");
  if (e2) e2.textContent = msg || "";
}

function openGame() {
  $("#joinCard").classList.add("hidden");
  $("#gameCard").classList.remove("hidden");
}

// ─── Role card flip ───────────────────────────────────────────────────────────

function revealMyRole(role) {
  if (!role) return;
  const card = $("#myRoleCard");
  const img = $("#myRoleImg");
  const name = $("#myRoleName");
  img.src = `/static/images/${role.toLowerCase()}.svg`;
  img.alt = role;
  name.textContent = role;
  card.classList.add("revealed");
  $("#tapHint").classList.add("hidden");
}

// Tap the card to reveal (only works once role is assigned)
$("#myRoleCard").addEventListener("click", () => {
  if (state.currentRole) revealMyRole(state.currentRole);
});

// ─── Circle / poker-table layout ─────────────────────────────────────────────

function renderTable(players, playerOrder, myId, step) {
  const circle = $("#playerCircle");
  circle.innerHTML = "";

  const tableEl = $("#tableArea");
  const W = tableEl.offsetWidth || 300;
  const H = tableEl.offsetHeight || (W * 0.7);

  // Ellipse radii — keep seats inside the circle, with padding
  const rx = W * 0.38;
  const ry = H * 0.38;
  const cx = W / 2;
  const cy = H / 2;

  // Order players by player_order from server (stable seats)
  const orderedPlayers = playerOrder
    .map((id) => players.find((p) => p.id === id))
    .filter(Boolean);
  // Add any players not yet in order (shouldn't happen but be safe)
  players.forEach((p) => { if (!playerOrder.includes(p.id)) orderedPlayers.push(p); });

  const n = orderedPlayers.length;
  orderedPlayers.forEach((player, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    const x = cx + rx * Math.cos(angle);
    const y = cy + ry * Math.sin(angle);

    const seat = document.createElement("div");
    seat.className = "player-seat";
    if (player.id === myId) seat.classList.add("is-me");
    seat.dataset.playerId = player.id;
    seat.style.left = `${x}px`;
    seat.style.top = `${y}px`;

    const cardDiv = document.createElement("div");
    cardDiv.className = "seat-card";
    const img = document.createElement("img");
    img.src = "/static/images/card-back.svg";
    img.alt = player.name;
    cardDiv.appendChild(img);

    const nameEl = document.createElement("div");
    nameEl.className = "seat-name";
    nameEl.textContent = player.name + (player.is_admin ? " ★" : "");

    seat.appendChild(cardDiv);
    seat.appendChild(nameEl);
    circle.appendChild(seat);
  });

  // Apply interactivity based on current night phase
  applyNightPhaseInteractivity(players, myId, step);
}

// ─── Night action interactivity ───────────────────────────────────────────────

function clearNightUI() {
  // Remove selectable/selected/inactive from all seats and center cards
  document.querySelectorAll(".player-seat").forEach((s) => {
    s.classList.remove("selectable", "selected", "inactive");
  });
  document.querySelectorAll(".center-card").forEach((c) => {
    c.classList.remove("selectable", "selected");
  });
  $("#nightActionPanel").classList.add("hidden");
  $("#confirmActionBtn").classList.add("hidden");
  $("#actionResult").textContent = "";
  state.selectedTargets = [];
}

function getRequiredTargetCount(role) {
  if (role === "Seer") return null; // special: 1 player OR 2 center
  if (role === "Robber") return 1;
  if (role === "Troublemaker") return 2;
  return 0;
}

function getActionInstruction(role) {
  if (role === "Seer") return "Tap ONE player card to peek at their role, OR tap TWO center cards.";
  if (role === "Robber") return "Tap ONE other player's card to swap roles with them.";
  if (role === "Troublemaker") return "Tap TWO other players to swap their roles.";
  return "";
}

function updateConfirmButton() {
  const step = state.lobby?.step;
  if (!step?.interactive) return;
  const role = step.role;
  const n = state.selectedTargets.length;
  let ready = false;
  if (role === "Seer") {
    const allCenter = state.selectedTargets.every((t) => t.startsWith("center_"));
    const allPlayer = state.selectedTargets.every((t) => !t.startsWith("center_"));
    ready = (n === 1 && allPlayer) || (n === 2 && allCenter);
  } else if (role === "Robber") {
    ready = n === 1;
  } else if (role === "Troublemaker") {
    ready = n === 2;
  }
  $("#confirmActionBtn").classList.toggle("hidden", !ready);
}

function handleSeatClick(playerId) {
  if (state.actionDone) return;
  const step = state.lobby?.step;
  if (!step?.interactive) return;
  const role = step.role;

  // Toggle selection
  const idx = state.selectedTargets.indexOf(playerId);
  if (idx !== -1) {
    state.selectedTargets.splice(idx, 1);
  } else {
    // Seer: can't mix player + center; enforce
    if (role === "Seer") {
      const hasCenters = state.selectedTargets.some((t) => t.startsWith("center_"));
      if (hasCenters) {
        // Clear centers if switching to player
        state.selectedTargets = [];
      }
      if (state.selectedTargets.length >= 1) {
        // Seer only picks 1 player
        state.selectedTargets = [playerId];
      } else {
        state.selectedTargets.push(playerId);
      }
    } else if (role === "Robber") {
      state.selectedTargets = [playerId];
    } else if (role === "Troublemaker") {
      if (state.selectedTargets.length >= 2) state.selectedTargets.shift();
      state.selectedTargets.push(playerId);
    }
  }

  // Re-render selected state on seat elements
  document.querySelectorAll(".player-seat").forEach((el) => {
    const pid = el.dataset.playerId;
    el.classList.toggle("selected", state.selectedTargets.includes(pid));
  });
  updateConfirmButton();
}

function handleCenterClick(key) {
  if (state.actionDone) return;
  const step = state.lobby?.step;
  if (!step?.interactive || step.role !== "Seer") return;

  // Seer only: clear any player selections first
  const hasPlayers = state.selectedTargets.some((t) => !t.startsWith("center_"));
  if (hasPlayers) state.selectedTargets = [];

  const idx = state.selectedTargets.indexOf(key);
  if (idx !== -1) {
    state.selectedTargets.splice(idx, 1);
  } else {
    if (state.selectedTargets.length >= 2) state.selectedTargets.shift();
    state.selectedTargets.push(key);
  }

  document.querySelectorAll(".center-card").forEach((el) => {
    el.classList.toggle("selected", state.selectedTargets.includes(el.dataset.key));
  });
  updateConfirmButton();
}

function applyNightPhaseInteractivity(players, myId, step) {
  if (!step?.role) return;

  const isMyTurn = step.role === state.role; // original role determines turn
  const isAutoRole = step.role === "Werewolf" || step.role === "Insomniac";
  const isInteractive = step.interactive === true;

  if (!isMyTurn || isAutoRole || state.actionDone) {
    // Everyone else: all seats inactive, no center interaction
    document.querySelectorAll(".player-seat").forEach((el) => el.classList.add("inactive"));
    document.querySelectorAll(".center-card img").forEach((img) => {
      img.style.opacity = "0.4";
      img.style.cursor = "default";
    });
    return;
  }

  if (isInteractive) {
    // Show action panel
    const panel = $("#nightActionPanel");
    panel.classList.remove("hidden");
    $("#actionInstruction").textContent = getActionInstruction(step.role);

    // Make other players selectable; self is inactive
    document.querySelectorAll(".player-seat").forEach((el) => {
      if (el.dataset.playerId === myId) {
        el.classList.add("inactive");
      } else {
        el.classList.add("selectable");
      }
    });

    // Center cards: only selectable for Seer
    if (step.role === "Seer") {
      document.querySelectorAll(".center-card").forEach((el) => {
        el.classList.add("selectable");
      });
    }

    // Wire click handlers (delegate via parent)
  }
}

// Delegate clicks on the player circle
$("#playerCircle").addEventListener("click", (e) => {
  const seat = e.target.closest(".player-seat");
  if (seat && seat.classList.contains("selectable")) {
    handleSeatClick(seat.dataset.playerId);
  }
});

// Delegate clicks on center cards
$("#centerCards").addEventListener("click", (e) => {
  const card = e.target.closest(".center-card");
  if (card && card.classList.contains("selectable")) {
    handleCenterClick(card.dataset.key);
  }
});

// Submit night action
$("#confirmActionBtn").addEventListener("click", () => {
  if (!state.selectedTargets.length) return;
  send({ type: "night_action", targets: state.selectedTargets });
  state.actionDone = true;
  $("#confirmActionBtn").classList.add("hidden");
  $("#actionInstruction").textContent = "Action submitted. Waiting...";
  // Remove selectability
  document.querySelectorAll(".player-seat.selectable").forEach((el) => el.classList.remove("selectable"));
  document.querySelectorAll(".center-card.selectable").forEach((el) => el.classList.remove("selectable"));
});

// ─── Timer ───────────────────────────────────────────────────────────────────

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!state.lobby?.step || !state.lobby?.step_started_at) {
      $("#phaseTimer").textContent = "";
      return;
    }
    const secs = state.lobby.step.seconds || 0;
    if (secs >= 9999) {
      $("#phaseTimer").textContent = "No timer";
      return;
    }
    const elapsed = Math.floor(Date.now() / 1000 - state.lobby.step_started_at);
    const left = Math.max(0, secs - elapsed);
    $("#phaseTimer").textContent = `${left}s`;
  }, 300);
}

// ─── Main render ─────────────────────────────────────────────────────────────

function getSelectedRoles() {
  return Array.from(document.querySelectorAll('.roles input[type="checkbox"]:checked')).map((i) => i.value);
}

function syncRoleCheckboxes(selected) {
  const checks = Array.from(document.querySelectorAll('.roles input[type="checkbox"]'));
  checks.forEach((c) => (c.checked = false));
  const used = {};
  for (const role of selected || []) {
    for (const c of checks) {
      if (c.value !== role) continue;
      const key = `${role}:${c.parentElement.textContent}`;
      if (used[key]) continue;
      c.checked = true;
      used[key] = true;
      break;
    }
  }
}

function renderGame(st) {
  const prevStep = state.lobby?.step_index;
  state.lobby = st;

  // Reset action state when phase changes
  if (prevStep !== st.step_index) {
    state.actionDone = false;
    clearNightUI();
  }

  $("#lobbyCode").textContent = st.code;
  const me = st.players.find((p) => p.id === state.me);
  const iAmAdmin = !!me?.is_admin;
  $("#meTag").textContent = iAmAdmin ? "Admin" : "Player";
  $("#adminPanel").classList.toggle("hidden", !iAmAdmin);
  syncRoleCheckboxes(st.selected_roles || []);

  // Render circle table
  renderTable(st.players, st.player_order || [], state.me, st.step);

  if (!st.started || !st.step) {
    $("#phaseTitle").textContent = "Waiting...";
    $("#phaseMessage").textContent = "The admin will start the game.";
    $("#phaseTimer").textContent = "";
    return;
  }

  $("#phaseTitle").textContent = st.step.title;
  $("#phaseMessage").textContent = st.step.message;

  // Apply interactive night phase UI (only when step is interactive and it's my turn)
  if (st.step.interactive && st.step.role === state.role && !state.actionDone) {
    applyNightPhaseInteractivity(st.players, state.me, st.step);
  }
}

// ─── WebSocket message handler ───────────────────────────────────────────────

ws.addEventListener("message", (evt) => {
  const data = JSON.parse(evt.data);

  if (data.type === "error") {
    showError(data.message);
    return;
  }

  if (data.type === "joined") {
    state.me = data.player_id;
    state.code = data.code;
    showError("");
    openGame();
    return;
  }

  if (data.type === "private_role") {
    state.currentRole = data.role;
    // First private_role sets the original role (before any swaps)
    if (!state.role && data.role) {
      state.role = data.role;
    }
    // If role changed (Robber swapped us), re-reveal
    if (data.role && data.role !== state.currentRole) {
      revealMyRole(data.role);
    }
    return;
  }

  if (data.type === "state") {
    renderGame(data.state);
    startTimer();
    return;
  }

  // Night action results (auto-resolve: Werewolf / Insomniac)
  if (data.type === "night_result") {
    const panel = $("#nightActionPanel");
    panel.classList.remove("hidden");
    $("#actionInstruction").textContent = "";
    $("#actionResult").textContent = data.message;
    return;
  }

  // Night action acknowledgement (player tapped and submitted)
  if (data.type === "action_ack") {
    $("#actionResult").textContent = data.message;
    // If Robber got a new role, update and flip card
    if (data.your_new_role) {
      state.currentRole = data.your_new_role;
      revealMyRole(data.your_new_role);
    }
    return;
  }

  if (data.type === "action_error") {
    showError(data.message);
    // Re-enable action so player can try again
    state.actionDone = false;
    return;
  }
});

// ─── Button listeners ────────────────────────────────────────────────────────

$("#createBtn").addEventListener("click", () => {
  const name = $("#nameInput").value.trim() || "Player";
  send({ type: "create_lobby", name });
});

$("#joinBtn").addEventListener("click", () => {
  const name = $("#nameInput").value.trim() || "Player";
  const code = $("#codeInput").value.trim().toUpperCase();
  if (!code) return showError("Enter lobby code.");
  send({ type: "join_lobby", name, code });
});

$("#saveRolesBtn").addEventListener("click", () => {
  const roles = getSelectedRoles();
  if (!roles.length) return showError("Select at least one role.");
  send({ type: "set_roles", roles });
});

$("#startBtn").addEventListener("click", () => send({ type: "start_game" }));
$("#nextBtn").addEventListener("click", () => send({ type: "next_step" }));
$("#resetBtn").addEventListener("click", () => {
  state.role = null;
  state.currentRole = null;
  state.actionDone = false;
  // Reset role card
  const card = $("#myRoleCard");
  card.classList.remove("revealed");
  $("#myRoleImg").src = "";
  $("#myRoleName").textContent = "";
  $("#tapHint").classList.remove("hidden");
  clearNightUI();
  send({ type: "reset_game" });
});
