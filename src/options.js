const STORAGE_KEY = "proxySwitcherState";

const listEl = document.getElementById("profile-list");
const addBtn = document.getElementById("add-profile");
const deleteBtn = document.getElementById("delete-profile");
const detailTitleEl = document.getElementById("detail-title");
const detailBodyEl = document.getElementById("detail-body");
const exportBtn = document.getElementById("export-profiles");
const importBtn = document.getElementById("import-profiles");
const importFileEl = document.getElementById("import-file");
const importStatusEl = document.getElementById("import-status");

let state = { profiles: [], activeProfileId: null };
let selectedId = null;

function newRuleId() {
  return `rule-${Math.random().toString(36).slice(2, 8)}`;
}

function makeDefaultRule() {
  return {
    id: newRuleId(),
    urlPattern: "*://*/*",
    protocol: "HTTP",
    domain: "",
    port: "8080",
  };
}

function normalizeRule(rule) {
  if (!rule) return makeDefaultRule();
  return {
    id: rule.id || newRuleId(),
    urlPattern: rule.urlPattern || rule.value || "*://*/*",
    protocol: rule.protocol || "HTTP",
    domain: rule.domain || "",
    port: rule.port ? String(rule.port) : "",
  };
}

function normalizeProfile(profile) {
  if (!profile) return null;
  if (profile.mode === "direct") {
    return { ...profile, rules: [] };
  }
  const rules =
    profile.rules && profile.rules.length
      ? profile.rules.map(normalizeRule)
      : [makeDefaultRule()];
  return { ...profile, rules };
}

function setImportStatus(message, type = "") {
  importStatusEl.textContent = message;
  importStatusEl.classList.remove("text-success", "text-error");
  if (type === "success") importStatusEl.classList.add("text-success");
  if (type === "error") importStatusEl.classList.add("text-error");
}

function uniqueProfileId(seedId, usedIds) {
  let id = seedId || `profile-${Math.random().toString(36).slice(2, 8)}`;
  while (usedIds.has(id)) {
    id = `profile-${Math.random().toString(36).slice(2, 8)}`;
  }
  usedIds.add(id);
  return id;
}

function stripRuleId(rule) {
  const { id, ...rest } = rule;
  return rest;
}

function exportDataPayload() {
  const exportProfiles = state.profiles.filter((p) => p.mode !== "direct");
  const exportActiveId = exportProfiles.some(
    (p) => p.id === state.activeProfileId,
  )
    ? state.activeProfileId
    : null;
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    activeProfileId: exportActiveId,
    profiles: exportProfiles.map((profile) => ({
      ...profile,
      rules: (profile.rules || []).map(stripRuleId),
    })),
  };
}

function triggerDownload(content, fileName) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function normalizeImportedPayload(raw) {
  if (Array.isArray(raw)) {
    return { profiles: raw, activeProfileId: null };
  }
  if (raw && typeof raw === "object" && Array.isArray(raw.profiles)) {
    return {
      profiles: raw.profiles,
      activeProfileId: raw.activeProfileId || null,
    };
  }
  return null;
}

function mergeProfilesIncremental(importedProfiles) {
  const currentProfiles = state.profiles.map((p) => ({ ...p }));
  const usedIds = new Set(currentProfiles.map((p) => p.id));
  const existingById = new Map(currentProfiles.map((p, idx) => [p.id, idx]));
  const existingByName = new Map(
    currentProfiles.map((p, idx) => [
      String(p.name || "")
        .trim()
        .toLowerCase(),
      idx,
    ]),
  );

  let added = 0;
  let updated = 0;
  let skipped = 0;

  importedProfiles.forEach((incomingRaw) => {
    const incoming = normalizeProfile(incomingRaw);
    if (!incoming) {
      skipped += 1;
      return;
    }
    if (incoming.mode === "direct") {
      skipped += 1;
      return;
    }

    const normalizedName = String(incoming.name || "")
      .trim()
      .toLowerCase();
    const indexById = incoming.id ? existingById.get(incoming.id) : undefined;
    const indexByName = normalizedName
      ? existingByName.get(normalizedName)
      : undefined;
    const targetIndex = indexById ?? indexByName;

    if (targetIndex !== undefined) {
      const existing = currentProfiles[targetIndex];
      currentProfiles[targetIndex] = {
        ...incoming,
        id: existing.id,
      };
      updated += 1;
      return;
    }

    const id = uniqueProfileId(incoming.id, usedIds);
    const nextProfile = {
      ...incoming,
      id,
    };
    currentProfiles.push(nextProfile);
    const nextIdx = currentProfiles.length - 1;
    existingById.set(id, nextIdx);
    if (normalizedName) {
      existingByName.set(normalizedName, nextIdx);
    }
    added += 1;
  });

  return { profiles: currentProfiles, added, updated, skipped };
}

async function exportProfiles() {
  const payload = exportDataPayload();
  const content = JSON.stringify(payload, null, 2);
  const date = new Date().toISOString().slice(0, 10);
  triggerDownload(content, `proxy-switcher-export-${date}.json`);
  setImportStatus("导出成功。", "success");
}

function importProfilesClick() {
  importFileEl.value = "";
  importFileEl.click();
}

async function importProfilesFromFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const payload = normalizeImportedPayload(parsed);
    if (!payload) {
      setImportStatus("导入失败：JSON 格式不正确。", "error");
      return;
    }

    const result = mergeProfilesIncremental(payload.profiles || []);
    state = {
      ...state,
      profiles: result.profiles,
      activeProfileId:
        state.activeProfileId ||
        payload.activeProfileId ||
        result.profiles.find((p) => p.mode !== "direct")?.id ||
        result.profiles[0]?.id ||
        null,
    };

    if (!state.profiles.some((p) => p.id === selectedId)) {
      selectedId = state.activeProfileId || state.profiles[0]?.id || null;
    }

    await persistState();
    render();
    setImportStatus(
      `导入完成：新增 ${result.added}，更新 ${result.updated}，跳过 ${result.skipped}。`,
      "success",
    );
  } catch (error) {
    console.error("import failed", error);
    setImportStatus("导入失败：无法解析 JSON。", "error");
  }
}

async function loadState() {
  try {
    const { state: messageState } = await chrome.runtime.sendMessage({
      type: "getState",
    });
    if (messageState) {
      state = messageState;
    }
  } catch (error) {
    console.warn("getState via message failed, falling back", error);
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    if (stored?.[STORAGE_KEY]) {
      state = stored[STORAGE_KEY];
    }
  }

  state = {
    ...state,
    profiles: (state.profiles || [])
      .map((p) => normalizeProfile(p))
      .filter(Boolean),
  };

  if (!selectedId) {
    selectedId = state.activeProfileId || state.profiles[0]?.id || null;
  }
  render();
}

async function persistState() {
  await chrome.storage.sync.set({ [STORAGE_KEY]: state });
}

function render() {
  renderList();
  renderDetail();
}

function renderList() {
  listEl.innerHTML = "";
  state.profiles.forEach((profile) => {
    const li = document.createElement("li");
    li.className = `profile-item ${selectedId === profile.id ? "active" : ""}`;
    li.addEventListener("click", () => selectProfile(profile.id));

    const meta = document.createElement("div");
    meta.className = "profile-meta";
    const name = document.createElement("div");
    name.className = "profile-name";
    name.textContent = profile.name;
    const tags = document.createElement("div");
    tags.className = "profile-tags";
    if (state.activeProfileId === profile.id) {
      const activeTag = document.createElement("span");
      activeTag.className = "tag";
      activeTag.textContent = "最近使用";
      tags.appendChild(activeTag);
    }
    const modeTag = document.createElement("span");
    modeTag.className = "tag";
    modeTag.textContent = profile.mode === "direct" ? "Direct" : "Proxy";
    tags.appendChild(modeTag);

    meta.appendChild(name);
    meta.appendChild(tags);

    const deleteBtnInline = document.createElement("button");
    deleteBtnInline.type = "button";
    deleteBtnInline.className = "ghost-button";
    deleteBtnInline.textContent = "删除";
    deleteBtnInline.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteProfile(profile.id);
    });
    deleteBtnInline.disabled =
      state.profiles.length <= 1 || profile.mode === "direct";

    li.appendChild(meta);
    li.appendChild(deleteBtnInline);
    listEl.appendChild(li);
  });
}

function renderDetail() {
  const profile = state.profiles.find((p) => p.id === selectedId);
  if (!profile) {
    detailTitleEl.textContent = "选择一个代理";
    detailBodyEl.textContent = "左侧选择或创建代理，右侧将展示配置。";
    deleteBtn.disabled = state.profiles.length <= 1;
    return;
  }

  detailTitleEl.textContent = profile.name;
  if (profile.mode === "direct") {
    detailBodyEl.className = "detail-placeholder";
    detailBodyEl.textContent = "Direct 模式无需配置，且不可编辑。";
    deleteBtn.disabled = true;
    return;
  }

  deleteBtn.disabled = state.profiles.length <= 1;
  detailBodyEl.className = "";
  detailBodyEl.innerHTML = "";

  const form = document.createElement("div");

  const nameField = document.createElement("div");
  nameField.className = "field";
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "名称";
  const nameInput = document.createElement("input");
  nameInput.value = profile.name;
  nameInput.addEventListener("input", (event) =>
    renameProfile(profile.id, event.target.value),
  );
  nameField.appendChild(nameLabel);
  nameField.appendChild(nameInput);

  const rulesHeader = document.createElement("div");
  rulesHeader.className = "rules-header";
  const rulesTitle = document.createElement("div");
  rulesTitle.className = "panel-title";
  rulesTitle.textContent = "规则";
  const addRuleBtn = document.createElement("button");
  addRuleBtn.type = "button";
  addRuleBtn.textContent = "新增规则";
  addRuleBtn.addEventListener("click", () => addRule(profile.id));
  rulesHeader.appendChild(rulesTitle);
  rulesHeader.appendChild(addRuleBtn);

  const ruleList = document.createElement("div");
  ruleList.className = "rule-list";

  profile.rules.forEach((rule) => {
    const ruleItem = document.createElement("div");
    ruleItem.className = "rule-item";

    const grid = document.createElement("div");
    grid.className = "rule-grid";

    const urlField = document.createElement("div");
    urlField.className = "field";
    const urlLabel = document.createElement("label");
    urlLabel.textContent = "URL Pattern";
    const urlInput = document.createElement("input");
    urlInput.value = rule.urlPattern;
    urlInput.placeholder = "如 *://*.example.com/*";
    urlInput.addEventListener("input", (event) =>
      updateRule(profile.id, rule.id, "urlPattern", event.target.value),
    );
    urlField.appendChild(urlLabel);
    urlField.appendChild(urlInput);

    const protoField = document.createElement("div");
    protoField.className = "field";
    const protoLabel = document.createElement("label");
    protoLabel.textContent = "Protocol";
    const protoSelect = document.createElement("select");
    ["HTTP", "HTTPS"].forEach((optionValue) => {
      const opt = document.createElement("option");
      opt.value = optionValue;
      opt.textContent = optionValue;
      if (rule.protocol === optionValue) opt.selected = true;
      protoSelect.appendChild(opt);
    });
    protoSelect.addEventListener("change", (event) =>
      updateRule(profile.id, rule.id, "protocol", event.target.value),
    );
    protoField.appendChild(protoLabel);
    protoField.appendChild(protoSelect);

    const domainField = document.createElement("div");
    domainField.className = "field";
    const domainLabel = document.createElement("label");
    domainLabel.textContent = "Target Domain";
    const domainInput = document.createElement("input");
    domainInput.value = rule.domain;
    domainInput.placeholder = "proxy.example.com";
    domainInput.addEventListener("input", (event) =>
      updateRule(profile.id, rule.id, "domain", event.target.value),
    );
    domainField.appendChild(domainLabel);
    domainField.appendChild(domainInput);

    const portField = document.createElement("div");
    portField.className = "field";
    const portLabel = document.createElement("label");
    portLabel.textContent = "Port";
    const portInput = document.createElement("input");
    portInput.type = "number";
    portInput.min = "1";
    portInput.max = "65535";
    portInput.value = rule.port;
    portInput.placeholder = "8080";
    portInput.addEventListener("input", (event) =>
      updateRule(profile.id, rule.id, "port", event.target.value),
    );
    portField.appendChild(portLabel);
    portField.appendChild(portInput);

    const deleteField = document.createElement("div");
    deleteField.className = "field";
    const deleteLabel = document.createElement("label");
    deleteLabel.textContent = " ";
    const deleteRuleBtn = document.createElement("button");
    deleteRuleBtn.type = "button";
    deleteRuleBtn.className = "ghost-button";
    deleteRuleBtn.textContent = "删除";
    deleteRuleBtn.disabled = profile.rules.length <= 1;
    deleteRuleBtn.addEventListener("click", (event) => {
      event.preventDefault();
      deleteRule(profile.id, rule.id);
    });
    deleteField.appendChild(deleteLabel);
    deleteField.appendChild(deleteRuleBtn);

    grid.appendChild(urlField);
    grid.appendChild(protoField);
    grid.appendChild(domainField);
    grid.appendChild(portField);
    grid.appendChild(deleteField);

    ruleItem.appendChild(grid);
    ruleList.appendChild(ruleItem);
  });

  const hint = document.createElement("div");
  hint.className = "muted";
  hint.textContent =
    "每条规则按 url pattern 匹配，命中后使用对应的 target protocol/domain/port 进行转发。至少保留一条规则。";

  form.appendChild(nameField);
  form.appendChild(rulesHeader);
  form.appendChild(ruleList);
  form.appendChild(hint);
  detailBodyEl.appendChild(form);
}

function selectProfile(profileId) {
  selectedId = profileId;
  render();
}

function nextProfileName() {
  const count = state.profiles.length + 1;
  return `New Proxy ${count}`;
}

function newProfileId() {
  return `profile-${Math.random().toString(36).slice(2, 8)}`;
}

async function addProfile() {
  const profile = {
    id: newProfileId(),
    name: nextProfileName(),
    mode: "fixed",
    http: "",
    https: "",
    rules: [makeDefaultRule()],
  };
  state = {
    ...state,
    profiles: [...state.profiles, profile],
  };
  selectedId = profile.id;
  if (!state.activeProfileId) {
    state.activeProfileId = profile.id;
  }
  await persistState();
  render();
}

function renameProfile(profileId, name) {
  state = {
    ...state,
    profiles: state.profiles.map((p) =>
      p.id === profileId ? { ...p, name: name || "" } : p,
    ),
  };
  persistState();
  renderList();
  detailTitleEl.textContent = name || "";
}

async function addRule(profileId) {
  state = {
    ...state,
    profiles: state.profiles.map((p) =>
      p.id === profileId ? { ...p, rules: [...p.rules, makeDefaultRule()] } : p,
    ),
  };
  await persistState();
  renderDetail();
}

async function deleteRule(profileId, ruleId) {
  state = {
    ...state,
    profiles: state.profiles.map((p) => {
      if (p.id !== profileId) return p;
      if (p.rules.length <= 1) return p;
      const rules = p.rules.filter((r) => r.id !== ruleId);
      return { ...p, rules: rules.length ? rules : [makeDefaultRule()] };
    }),
  };
  await persistState();
  renderDetail();
}

async function updateRule(profileId, ruleId, field, value) {
  state = {
    ...state,
    profiles: state.profiles.map((p) => {
      if (p.id !== profileId) return p;
      return {
        ...p,
        rules: p.rules.map((r) =>
          r.id === ruleId ? { ...r, [field]: value } : r,
        ),
      };
    }),
  };
  await persistState();
}

async function deleteProfile(profileId) {
  if (state.profiles.length <= 1) return;
  const target = state.profiles.find((p) => p.id === profileId);
  if (target?.mode === "direct") return;
  const removedActive = state.activeProfileId === profileId;
  state = {
    ...state,
    profiles: state.profiles.filter((p) => p.id !== profileId),
  };
  if (!state.profiles.length) {
    state.activeProfileId = null;
    selectedId = null;
  } else {
    if (removedActive) {
      state.activeProfileId = state.profiles[0].id;
    }
    if (!state.profiles.some((p) => p.id === selectedId)) {
      selectedId = state.activeProfileId || state.profiles[0].id;
    }
  }
  await persistState();
  if (removedActive && state.activeProfileId) {
    try {
      await chrome.runtime.sendMessage({
        type: "setActiveProfile",
        profileId: state.activeProfileId,
      });
    } catch (error) {
      console.warn("setActiveProfile after delete failed", error);
    }
  }
  render();
}

addBtn.addEventListener("click", addProfile);
deleteBtn.addEventListener("click", () => deleteProfile(selectedId));
exportBtn.addEventListener("click", exportProfiles);
importBtn.addEventListener("click", importProfilesClick);
importFileEl.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  await importProfilesFromFile(file);
});

loadState();
