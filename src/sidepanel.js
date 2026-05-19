const MATCH_TYPE_HOST = "host";

const effectiveStateEl = document.getElementById("effective-state");
const profileSelectEl = document.getElementById("profile-select");
const testUrlEl = document.getElementById("test-url");
const runTestBtn = document.getElementById("run-test");
const testResultEl = document.getElementById("test-result");
const pacScriptEl = document.getElementById("pac-script");
const rulesSummaryEl = document.getElementById("rules-summary");
const refreshBtn = document.getElementById("refresh-debug");
const openOptionsBtn = document.getElementById("open-options");

let state = { profiles: [], activeProfileId: null };
let debugState = null;

function formatProxySettingsSummary(details) {
  if (!details) return "未读取到 Chrome proxy.settings。";

  const mode = details.value?.mode || "unknown";
  const levelOfControl = details.levelOfControl || "unknown";
  return `mode=${mode}, levelOfControl=${levelOfControl}, incognitoSpecific=${details.incognitoSpecific ? "yes" : "no"}`;
}

function getSelectedProfileId() {
  return (
    profileSelectEl.value ||
    state.activeProfileId ||
    state.profiles[0]?.id ||
    ""
  );
}

function createRuleResultText(item) {
  const status = item.matched ? "HIT" : "MISS";
  const matchValue =
    item.rule.matchType === MATCH_TYPE_HOST
      ? item.rule.host
      : item.rule.urlPattern;
  return `${status} #${item.index + 1} ${item.rule.matchType}=${matchValue} -> ${item.proxy} (${item.reason})`;
}

function renderProfileSelect() {
  const currentValue = getSelectedProfileId();
  profileSelectEl.innerHTML = "";

  state.profiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    if (profile.id === currentValue) {
      option.selected = true;
    }
    profileSelectEl.appendChild(option);
  });

  if (!profileSelectEl.value && state.activeProfileId) {
    profileSelectEl.value = state.activeProfileId;
  }
}

function renderEffectiveState() {
  const selectedProfile = state.profiles.find(
    (profile) => profile.id === getSelectedProfileId(),
  );
  const activeProfileName = debugState?.activeProfileName || "未知";
  const proxySummary = formatProxySettingsSummary(debugState?.proxySettings);

  effectiveStateEl.innerHTML = "";

  const header = document.createElement("div");
  header.className = "section-header";
  const title = document.createElement("h2");
  title.textContent = "当前生效状态";
  header.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "status-grid";

  [
    ["当前已激活 Profile", activeProfileName],
    ["当前测试 Profile", selectedProfile?.name || "未知"],
    ["Chrome Proxy", proxySummary],
    ["PAC 状态", debugState?.pacScript ? "已生成" : "无 PAC"],
  ].forEach(([label, value]) => {
    const item = document.createElement("div");
    item.className = "status-item";
    const labelEl = document.createElement("div");
    labelEl.className = "status-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("div");
    valueEl.className = "status-value";
    valueEl.textContent = value;
    item.appendChild(labelEl);
    item.appendChild(valueEl);
    grid.appendChild(item);
  });

  effectiveStateEl.appendChild(header);
  effectiveStateEl.appendChild(grid);

  if (selectedProfile && selectedProfile.id !== state.activeProfileId) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent =
      "命中测试会按当前测试 Profile 推演；浏览器真实生效的仍是上面的已激活 Profile。";
    effectiveStateEl.appendChild(note);
  }
}

function renderRulesSummary() {
  rulesSummaryEl.innerHTML = "";
  const rules = debugState?.rules || [];

  if (!rules.length) {
    const empty = document.createElement("div");
    empty.className = "muted-block";
    empty.textContent = "当前无规则。";
    rulesSummaryEl.appendChild(empty);
    return;
  }

  rules.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "rule-row";
    const title = document.createElement("div");
    title.className = "rule-title";
    const matchValue =
      rule.matchType === MATCH_TYPE_HOST ? rule.host : rule.urlPattern;
    title.textContent = `#${index + 1} ${rule.matchType}: ${matchValue}`;
    const meta = document.createElement("div");
    meta.className = "rule-meta";
    meta.textContent = `proxy=PROXY ${rule.domain}:${rule.port}`;
    row.appendChild(title);
    row.appendChild(meta);
    rulesSummaryEl.appendChild(row);
  });
}

function renderPacScript() {
  pacScriptEl.textContent = debugState?.pacScript || "当前无 PAC 内容。";
}

function renderTestResult(result, error) {
  testResultEl.classList.remove("text-error");

  if (error) {
    testResultEl.textContent = error;
    testResultEl.classList.add("text-error");
    return;
  }

  if (!result?.ok) {
    testResultEl.textContent = "输入完整 URL 后，可查看命中规则或未命中原因。";
    return;
  }

  const output = [
    `测试 Profile: ${result.profileName || "未知"}`,
    `URL: ${result.target?.url || ""}`,
    `Host: ${result.target?.host || ""}`,
    `最终动作: ${result.action}`,
    `结果: ${result.matched ? "命中" : "未命中"}`,
    `原因: ${result.reason}`,
    "",
    ...(result.ruleResults || []).map(createRuleResultText),
  ];
  testResultEl.textContent = output.join("\n");
}

async function fetchState() {
  const { state: nextState, error } = await chrome.runtime.sendMessage({
    type: "getState",
  });
  if (error) {
    throw new Error(error);
  }
  state = nextState || { profiles: [], activeProfileId: null };
}

async function fetchDebugState() {
  const { debugState: nextDebugState, error } =
    await chrome.runtime.sendMessage({ type: "getDebugState" });
  if (error) {
    throw new Error(error);
  }
  debugState = nextDebugState || null;
}

async function refreshAll() {
  try {
    await fetchState();
    await fetchDebugState();
    renderProfileSelect();
    renderEffectiveState();
    renderPacScript();
    renderRulesSummary();
    renderTestResult(null, "");
  } catch (error) {
    effectiveStateEl.innerHTML = `<div class="muted-block text-error">${error?.message || "Unknown error"}</div>`;
    pacScriptEl.textContent = "加载失败。";
    rulesSummaryEl.innerHTML = "";
  }
}

async function runTest() {
  const url = testUrlEl.value.trim();
  if (!url) {
    renderTestResult(null, "请输入完整 URL，例如 https://github.com/");
    return;
  }

  try {
    const { result, profileName, error } = await chrome.runtime.sendMessage({
      type: "testProxyMatch",
      profileId: getSelectedProfileId(),
      url,
    });

    if (error) {
      renderTestResult(null, error);
      return;
    }

    renderTestResult({ ...(result || {}), profileName }, "");
  } catch (error) {
    renderTestResult(null, error?.message || "Unknown error");
  }
}

refreshBtn.addEventListener("click", refreshAll);
runTestBtn.addEventListener("click", runTest);
profileSelectEl.addEventListener("change", renderEffectiveState);
openOptionsBtn.addEventListener("click", () =>
  chrome.runtime.openOptionsPage(),
);

refreshAll();
