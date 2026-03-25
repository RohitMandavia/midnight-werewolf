const wsProto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsProto}://${location.host}/ws`);

const $ = (s) => document.querySelector(s);
const state = {
  me: null,
  code: null,
  lobby: null,
  role: null,
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

function renderPlayers(players) {
  $("#playersList").innerHTML = players
    .map((p) => `<li>${p.name}${p.is_admin ? " (admin)" : ""}</li>`)
    .join("");
}

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

function renderGame(st) {
  state.lobby = st;
  $("#lobbyCode").textContent = st.code;
  const me = st.players.find((p) => p.id === state.me);
  const iAmAdmin = !!me?.is_admin;
  $("#meTag").textContent = iAmAdmin ? "Admin" : "Player";
  $("#adminPanel").classList.toggle("hidden", !iAmAdmin);
  renderPlayers(st.players);
  syncRoleCheckboxes(st.selected_roles || []);

  if (!st.started || !st.step) {
    $("#phaseTitle").textContent = "Waiting...";
    $("#phaseMessage").textContent = "The admin will start the game.";
    $("#phaseTimer").textContent = "";
    return;
  }
  $("#phaseTitle").textContent = st.step.title;
  $("#phaseMessage").textContent = st.step.message;
}

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
    state.role = data.role;
    $("#myRole").textContent = data.role || "Hidden";
    return;
  }
  if (data.type === "state") {
    renderGame(data.state);
    startTimer();
  }
});

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
$("#resetBtn").addEventListener("click", () => send({ type: "reset_game" }));

