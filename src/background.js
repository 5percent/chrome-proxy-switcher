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
  const domain = rule.domain || "";
  const port = rule.port ? String(rule.port) : "";
  const matchValue = matchType === MATCH_TYPE_HOST ? host : urlPattern;

  if (!matchValue || !domain || !port) return null;

  return {
    matchType,
    urlPattern: matchType === MATCH_TYPE_URL ? urlPattern : "",
    host: matchType === MATCH_TYPE_HOST ? host : "",
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

function shellPatternToRegExp(pattern) {
  const escaped = String(pattern).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function shExpMatchLocal(value, pattern) {
  try {
    return shellPatternToRegExp(pattern).test(String(value));
  } catch (_error) {
    return false;
  }
}

function dnsDomainIsLocal(host, suffix) {
  return String(host).endsWith(String(suffix));
}

function parseUrlForDebug(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;

  try {
    const url = new URL(rawUrl);
    return {
      url: url.toString(),
      host: normalizeHostValue(url.hostname),
      protocol: url.protocol,
      path: `${url.pathname}${url.search}${url.hash}`,
    };
  } catch (_error) {
    return null;
  }
}

function evaluateRuleMatch(rule, target) {
  if (!rule || !target) {
    return { matched: false, reason: "missing_input" };
  }

  if (rule.matchType === MATCH_TYPE_HOST) {
    const exact = target.host === rule.host;
    const subdomain = dnsDomainIsLocal(target.host, `.${rule.host}`);
    return {
      matched: exact || subdomain,
      reason: exact
        ? "exact_host"
        : subdomain
          ? "subdomain_host"
          : "host_mismatch",
    };
  }

  const matched = shExpMatchLocal(target.url, rule.urlPattern);
  return {
    matched,
    reason: matched ? "url_pattern" : "pattern_mismatch",
  };
}

function explainRule(rule) {
  if (rule.matchType === MATCH_TYPE_HOST) {
    return `host = ${rule.host} or any subdomain`;
  }

  return `url matches ${rule.urlPattern}`;
}

function evaluateProfileMatch(profile, rawUrl) {
  const target = parseUrlForDebug(rawUrl);
  if (!target) {
    return {
      ok: false,
      error: "Invalid URL",
    };
  }

  if (!profile || isSystemProfile(profile)) {
    return {
      ok: true,
      target,
      matched: false,
      action: "DIRECT",
      reason: "system_profile",
      ruleResults: [],
    };
  }

  const rules = (profile.rules || []).map(normalizeRule).filter(Boolean);
  const ruleResults = rules.map((rule, index) => {
    const result = evaluateRuleMatch(rule, target);
    return {
      index,
      rule,
      matched: result.matched,
      reason: result.reason,
      explanation: explainRule(rule),
      proxy: `PROXY ${rule.domain}:${rule.port}; DIRECT`,
    };
  });

  const hit = ruleResults.find((item) => item.matched);
  return {
    ok: true,
    target,
    matched: Boolean(hit),
    action: hit ? hit.proxy : "DIRECT",
    reason: hit ? hit.reason : "no_rule_matched",
    matchedRuleIndex: hit?.index ?? null,
    ruleResults,
  };
}

function getProxySettings() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.get({ incognito: false }, (details) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(details);
    });
  });
}

async function getDebugState() {
  const state = await getState();
  const activeProfile =
    state.profiles.find((profile) => profile.id === state.activeProfileId) ||
    state.profiles[0] ||
    null;
  const normalizedProfile = activeProfile
    ? normalizeProfile(activeProfile)
    : null;
  const proxySettings = await getProxySettings();

  return {
    activeProfileId: normalizedProfile?.id || null,
    activeProfileName: normalizedProfile?.name || null,
    isSystemProfile: isSystemProfile(normalizedProfile),
    proxySettings,
    pacScript: normalizedProfile ? buildPacScript(normalizedProfile) : null,
    rules: normalizedProfile?.rules || [],
  };
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
      const proxyValue = `PROXY ${rule.domain}:${rule.port}; DIRECT`;
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

  if (message?.type === "getDebugState") {
    getDebugState()
      .then((debugState) => sendResponse({ debugState }))
      .catch((error) => {
        console.error("getDebugState failed", error);
        sendResponse({ error: error?.message || "Unknown error" });
      });
    return true;
  }

  if (message?.type === "testProxyMatch") {
    getState()
      .then((state) => {
        const profile =
          state.profiles.find((item) => item.id === message.profileId) ||
          state.profiles.find((item) => item.id === state.activeProfileId) ||
          state.profiles[0] ||
          null;

        return sendResponse({
          result: evaluateProfileMatch(profile, message.url),
          profileId: profile?.id || null,
          profileName: profile?.name || null,
        });
      })
      .catch((error) => {
        console.error("testProxyMatch failed", error);
        sendResponse({ error: error?.message || "Unknown error" });
      });
    return true;
  }

  return false;
});
