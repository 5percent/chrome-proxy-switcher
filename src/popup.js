const statusEl = document.getElementById("status");
const profilesEl = document.getElementById("profiles");
const openOptionsBtn = document.getElementById("open-options");

function renderState(state) {
  const active = state.profiles.find((p) => p.id === state.activeProfileId);
  statusEl.innerHTML = `
    <div class="label">Current</div>
    <div class="value">${active ? active.name : "Unknown"}</div>
  `;

  profilesEl.innerHTML = "";
  state.profiles.forEach((profile) => {
    const button = document.createElement("button");
    button.textContent = profile.name;
    button.className = profile.id === state.activeProfileId ? "active" : "";
    button.addEventListener("click", () => switchProfile(profile.id));
    profilesEl.appendChild(button);
  });
}

async function fetchState() {
  const { state, error } = await chrome.runtime.sendMessage({
    type: "getState",
  });
  if (error) {
    statusEl.textContent = error;
    return;
  }
  renderState(state);
}

async function switchProfile(profileId) {
  const { state, error } = await chrome.runtime.sendMessage({
    type: "setActiveProfile",
    profileId,
  });
  if (error) {
    statusEl.textContent = error;
    return;
  }
  renderState(state);
}

openOptionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

fetchState();
