const STORAGE_KEY = "proxySwitcherState";

const MATCH_TYPE_URL = "urlPattern";
const MATCH_TYPE_HOST = "host";

const defaultState = {
  profiles: [
    {
      id: "direct",
      name: "System Proxy",
      mode: "system",
      rules: [],
    },
    {
      id: "sample-http",
      name: "Sample HTTP Proxy",
      mode: "fixed",
      rules: [
        {
          urlPattern: "*://*/*",
          protocol: "HTTP",
          domain: "127.0.0.1",
          port: "8080",
        },
      ],
    },
  ],
  activeProfileId: "direct",
};

function isSystemProfile(profile) {
  return profile?.mode === "system" || profile?.mode === "direct";
}

function normalizeHostValue(value) {
  if (!value || typeof value !== "string") return "";

  let host = value.trim().toLowerCase();
  if (!host) return "";

  host = host.replace(/^[a-z]+:\/\//i, "");
  host = host.split(/[/?#]/)[0] || "";
  host = host.replace(/^\*\./, "").replace(/^\./, "");

  if (host.includes(":")) {
    const isIpv6Literal = host.startsWith("[") && host.endsWith("]");
    if (!isIpv6Literal && host.indexOf(":") === host.lastIndexOf(":")) {
      host = host.split(":")[0];
    }
  }

  return host;
}

function getRuleMatchType(rule) {
  return rule?.matchType === MATCH_TYPE_HOST ? MATCH_TYPE_HOST : MATCH_TYPE_URL;
}

function normalizeRule(rule) {
  if (!rule) return null;
  const matchType = getRuleMatchType(rule);
  const urlPattern = rule.urlPattern || rule.value || "";
  const host = normalizeHostValue(
    rule.host || rule.urlPattern || rule.value || "",
  );
  const protocol = (rule.protocol || "HTTP").toUpperCase();
  const domain = rule.domain || "";
  const port = rule.port ? String(rule.port) : "";
  const matchValue = matchType === MATCH_TYPE_HOST ? host : urlPattern;

  if (!matchValue || !domain || !port) return null;

  return {
    matchType,
    urlPattern: matchType === MATCH_TYPE_URL ? urlPattern : "",
    host: matchType === MATCH_TYPE_HOST ? host : "",
    protocol,
    domain,
    port,
  };
}

function parseLegacyProxyAddress(address) {
  if (!address || typeof address !== "string") return null;
  const trimmed = address.trim();
  if (!trimmed) return null;

  const withoutScheme = trimmed.replace(/^[a-z]+:\/\//i, "");
  const parts = withoutScheme.split(":");
  if (parts.length < 2) return null;

  const port = parts.pop();
  const domain = parts.join(":");
  if (!domain || !port) return null;
  return { domain, port };
}

function migrateLegacyRules(profile) {
  const endpoint =
    parseLegacyProxyAddress(profile.http) ||
    parseLegacyProxyAddress(profile.https);
  if (!endpoint) return [];

  const legacyRules = Array.isArray(profile.rules) ? profile.rules : [];
  const patterns = legacyRules
    .map((rule) => rule?.urlPattern || rule?.value)
    .filter(Boolean);
  const matchedPatterns = patterns.length ? patterns : ["*://*/*"];

  return matchedPatterns.map((urlPattern) => ({
    urlPattern,
    protocol: "HTTP",
    domain: endpoint.domain,
    port: String(endpoint.port),
  }));
}

function normalizeProfile(profile) {
  if (!profile) return null;
  if (isSystemProfile(profile)) {
    return {
      ...profile,
      id: profile.id || "direct",
      name:
        !profile.name || profile.name === "Direct (Off)"
          ? "System Proxy"
          : profile.name,
      mode: "system",
      rules: [],
    };
  }

  let rules = (profile.rules || []).map(normalizeRule).filter(Boolean);
  if (!rules.length) {
    rules = migrateLegacyRules(profile);
  }
  return { ...profile, rules };
}

async function getState() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const state = stored[STORAGE_KEY] || defaultState;
  return {
    ...state,
    profiles: (state.profiles || [])
      .map((p) => normalizeProfile(p))
      .filter(Boolean),
  };
}

async function setState(nextState) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: nextState });
}

function escapePac(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildPacCondition(rule) {
  if (rule.matchType === MATCH_TYPE_HOST) {
    const exactHost = escapePac(rule.host);
    const subdomainSuffix = escapePac(`.${rule.host}`);
    return `host === "${exactHost}" || dnsDomainIs(host, "${subdomainSuffix}")`;
  }

  return `shExpMatch(url, "${escapePac(rule.urlPattern)}")`;
}

function buildPacScript(profile) {
  if (isSystemProfile(profile)) {
    return "function FindProxyForURL(url, host) { return 'DIRECT'; }";
  }

  const rules = (profile.rules || []).map(normalizeRule).filter(Boolean);
  if (!rules.length) {
    return "function FindProxyForURL(url, host) { return 'DIRECT'; }";
  }

  const ruleBlocks = rules
    .map((rule) => {
      const token = rule.protocol === "HTTPS" ? "HTTPS" : "PROXY";
      const proxyValue = `${token} ${rule.domain}:${rule.port}; DIRECT`;
      return `if (${buildPacCondition(rule)}) return "${escapePac(proxyValue)}";`;
    })
    .join("\n  ");

  return `function FindProxyForURL(url, host) {
  if (isPlainHostName(host)) return \"DIRECT\";
  ${ruleBlocks}
  return \"DIRECT\";
}`;
}

async function applyProfile(profile) {
  if (!profile) return;
  // 清理扩展写入的代理配置；System 模式下让 Chrome 回退到系统代理。
  await chrome.proxy.settings.clear({ scope: "regular" });

  if (isSystemProfile(profile)) {
    return;
  }

  const pacScript = buildPacScript(profile);
  await chrome.proxy.settings.set({
    scope: "regular",
    value: {
      mode: "pac_script",
      pacScript: { data: pacScript },
    },
  });
}

async function activateProfile(profileId) {
  const state = await getState();
  const profile =
    state.profiles.find((p) => p.id === profileId) || state.profiles[0];
  await applyProfile(profile);
  const nextState = { ...state, activeProfileId: profile.id };
  await setState(nextState);
  return nextState;
}

async function ensureInitialState() {
  const state = await getState();
  if (!state || !state.profiles || !state.profiles.length) {
    await setState(defaultState);
    await applyProfile(defaultState.profiles[0]);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureInitialState();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureInitialState();
  const state = await getState();
  const active =
    state.profiles.find((p) => p.id === state.activeProfileId) ||
    state.profiles[0];
  await applyProfile(active);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getState") {
    getState()
      .then((state) => sendResponse({ state }))
      .catch((error) => {
        console.error("getState failed", error);
        sendResponse({ error: error?.message || "Unknown error" });
      });
    return true;
  }

  if (message?.type === "setActiveProfile") {
    activateProfile(message.profileId)
      .then((state) => sendResponse({ state }))
      .catch((error) => {
        console.error("setActiveProfile failed", error);
        sendResponse({ error: error?.message || "Unknown error" });
      });
    return true;
  }

  return false;
});
