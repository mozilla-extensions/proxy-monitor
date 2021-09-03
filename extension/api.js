
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyGlobalGetters(this, ["ChannelWrapper"]);
const { WebExtensionPolicy } = Cu.getGlobalForObject(Services);

XPCOMUtils.defineLazyServiceGetter(
  this,
  "ProxyService",
  "@mozilla.org/network/protocol-proxy-service;1",
  "nsIProtocolProxyService"
);

ChromeUtils.defineModuleGetter(
  this,
  "ExtensionParent",
  "resource://gre/modules/ExtensionParent.jsm",
);

XPCOMUtils.defineLazyGetter(
  this,
  "Management",
  () => ExtensionParent.apiManager
);
ChromeUtils.defineModuleGetter(
  this,
  "ExtensionPreferencesManager",
  "resource://gre/modules/ExtensionPreferencesManager.jsm"
);

ChromeUtils.defineModuleGetter(
  this,
  "ExtensionParent",
  "resource://gre/modules/ExtensionParent.jsm",
);

XPCOMUtils.defineLazyGetter(
  this,
  "Management",
  () => ExtensionParent.apiManager
);

const PROXY_DIRECT = "direct";
const DISABLE_HOURS = 48;
const MAX_DISABLED_PI = 5;
const PREF_MONITOR_DATA = "extensions.proxyMonitor";
const PREF_PROXY_FAILOVER = "network.proxy.failover_direct";

const PROXY_CONFIG_TYPES = [
  "direct",
  "manual",
  "pac",
  "wpad",
  "system"
];

function hoursSince(dt2, dt1 = Date.now()) {
  var diff = (dt2 - dt1) / 1000;
  diff /= (60 * 60);
  return Math.abs(Math.round(diff));
}

const DEBUG_LOG=1
function log(msg) {
  if (DEBUG_LOG) {
    console.log(`proxy-monitor: ${msg}`);
  }
}

/**
 * ProxyMonitor monitors system and protected requests for failures
 * due to bad or unavailable proxy configurations.
 * 
 * In a system with multiple layers of proxy configuration, if there is a 
 * failing proxy we try to remove just that confuration from the chain.  However if 
 * we get too many failures, we'll make a direct connection the top "proxy".
 * 
 * 1. Any proxied system request without a direct failover will have one added.
 * 
 * 2. If a proxied system request fails, the proxy configuration in use will
 * be disabled.  On later requests, disabled proxies are removed from the proxy chain.
 * Disabled proxy configurations remain disabled for 48 hours to allow any necessary
 * requests to operate for a period of time. When disabled proxies are used as a
 * failover to a direct request (step 3 or 4 below), the proxy can be detected
 * as functional and be re-enabled despite not having reached the 48 hours.
 * Likewise, if the proxy fails again it is disabled for another 48 hours.
 * 
 * 3. If too many proxy configurations got disabled, we make a direct config first
 * with failover to all other proxy configurations (essentially skipping step 2).
 * This state remains for 48 hours and can be extended if the failure condition
 * is detected again, i.e. when 5 distinct proxies fail within 48 hours.
 * 
 * 4. If we've removed all proxies we make a direct config first and failover to 
 * the other proxy configurations, similar to step 3.
 * 
 * If we've disabled proxies, we continue to watch the requests for failures in
 * "direct" connection mode.  If we continue to fail with direct connections,
 * we fall back to allowing proxies again.
 */
const ProxyMonitor = {
  errors: new Map(),
  disabledTime: 0,

  newDirectProxyInfo(failover = null) {
    return ProxyService.newProxyInfo(
      PROXY_DIRECT, "", 0, "", "", 0, 0, failover
    );
  },

  async applyFilter(channel, defaultProxyInfo, proxyFilter) {
    let proxyInfo = defaultProxyInfo;
    // onProxyFilterResult must be called, so we wrap in a try/finally.
    try {
      if (!proxyInfo) {
        // If no proxy is in use, exit early.
        return;
      }
      // If this is not a system request we will allow existing
      // proxy behavior.
      if (!channel.loadInfo?.loadingPrincipal?.isSystemPrincipal) {
        return;
      }

      // Proxies are configured so we want to monitor for non-connection errors 
      // such as invalid proxy servers.  We also monitor for direct connection 
      // failures if we end up pruning all proxies below.
      let wrapper = ChannelWrapper.get(channel);
      wrapper.addEventListener("error", this);
      wrapper.addEventListener("start", this);

      // If we have to many proxyInfo objects disabled we try direct first and
      // failover to the proxy config.
      if (this.tooManyFailures()) {
        log(`too many proxy config failures, prepend direct rid ${wrapper.id}`);
        // A lot of failures are happening, prepend a direct proxy. If direct connections
        // fail, the configured proxies will act as failover.
        proxyInfo = this.newDirectProxyInfo(defaultProxyInfo);
        return;
      }
      this.dumpProxies(proxyInfo, `starting proxyInfo rid ${wrapper.id}`);

      let enabledProxies = this.pruneProxyInfo(proxyInfo);
      if (!enabledProxies.length) {
        // No proxies are left enabled, prepend a direct proxy. If direct connections
        // fail, the configured proxies will act as failover.  In this case the
        // defaultProxyInfo chain was not changed.
        log(`all proxies disabled, prepend direct`);
        proxyInfo = this.newDirectProxyInfo(defaultProxyInfo);
        return;
      }
  
      proxyInfo = enabledProxies[0];
      let lastFailover = enabledProxies.pop();

      if (lastFailover.failoverProxy || lastFailover.type != PROXY_DIRECT) {
        // Ensure there is always a direct failover for our critical requests.  This
        // catches connection failures such as those to non-existant or non-http ports.
        // The "error" handler added above catches http connections that are not proxy servers.
        lastFailover.failoverProxy = this.newDirectProxyInfo();
        log(`direct failover added to proxy chain rid ${wrapper.id}`);
      }
      // A little debug output
      this.dumpProxies(proxyInfo, `pruned proxyInfo rid ${wrapper.id}`);
    } finally {
      // This must be called.
      proxyFilter.onProxyFilterResult(proxyInfo);
    }
  },

  // Verify the entire proxy failover chain is clean.  There may be multiple
  // sources for proxyInfo in the chain, so we remove any disabled entries
  // and continue to use configurations that have not yet failed.
  pruneProxyInfo(proxyInfo) {
    let enabledProxies = [];
    let pi = proxyInfo;
    while (pi) {
      if (!this.proxyDisabled(pi)) {
        enabledProxies.push(pi);
      }
      pi = pi.failoverProxy;
    }
    // Re-link the proxy chain.
    // failoverProxy cannot be set to undefined or null, we fixup the last failover
    // later with a direct failover if necessary.
    for (let i = 0; i < enabledProxies.length - 2; i++) {
      enabledProxies[i].failoverProxy = enabledProxies[i + 1];
    }
    return enabledProxies;
  },

  dumpProxies(proxyInfo, msg) {
    if (!DEBUG_LOG) {
      return;
    }
    log(msg);
    let pi = proxyInfo;
    while (pi) {
      log(`  ${pi.type}:${pi.host}:${pi.port}`);
      pi = pi.failoverProxy;
    }
  },

  tooManyFailures() {
    // If we have lots of PIs that are failing in a short period of time then
    // we back off proxy for a while.
    if (this.disabledTime && hoursSince(this.disabledTime) >= DISABLE_HOURS) {
      this.recordEvent("timeout", "proxyBypass");
      this.reset();
    }
    return !!this.disabledTime;
  },

  proxyDisabled(proxyInfo) {
    let key = this.getProxyInfoKey(proxyInfo);
    if (!key) {
      return false;
    }

    let err = this.errors.get(key);
    if (!err) {
      return false;
    }

    // We keep a proxy config disabled for 48 hours to give
    // our daily update checks time to complete again.
    if (hoursSince(err.time) >= DISABLE_HOURS) {
      this.errors.delete(key);
      this.recordEvent("timeout", "proxyInfo");
      return false;
    }

    // This is harsh, but these requests are too important.
    return true;
  },

  getProxyInfoKey(proxyInfo) {
    if (!proxyInfo || proxyInfo.type == PROXY_DIRECT) {
      return;
    }
    let { type, host, port } = proxyInfo;
    return `${type}:${host}:${port}`;
  },

  async getProxySource(proxyInfo) {
    try {
      // sourceId is set when using proxy.onRequest
      if (proxyInfo.sourceId) {
        return {
          source: proxyInfo.sourceId,
          type: "api"
        };
      }
    } catch(e) {
      // sourceId fx92 and later, otherwise exception.
    }
    let type = PROXY_CONFIG_TYPES[ProxyService.proxyConfigType] || "unknown";
    let source;
    // Is this proxied by an extension that set proxy prefs?
    let setting = await ExtensionPreferencesManager.getSetting("proxy.settings");
    if (setting) {
      let levelOfControl = await ExtensionPreferencesManager.getLevelOfControl(
        setting.id,
        "proxy.settings"
      );
      if (levelOfControl == "controlled_by_this_extension") {
        source = setting.id;
      }
    }
    // If we have a policy it will have set the prefs.
    if (Services.policies.status === Services.policies.ACTIVE) {
      let policies = Services.policies.getActivePolicies()?.filter(p => p.Proxy);
      if (policies?.length) {
        return {
          source: "policy",
          type,
        };
      }
    }
    return {
      source: source || "prefs",
      type,
    };
  },

  async logProxySource(state, proxyInfo) {
    let { source, type } = await this.getProxySource(proxyInfo);
    this.recordEvent(state, "proxyInfo", type, { source });
  },

  recordEvent(method, obj, type = null, source = {}) {
    try {
      Services.telemetry.recordEvent(
        "proxyMonitor",
        method,
        obj,
        type,
        source
      );
      log(`event: ${method} ${obj} ${type} ${JSON.stringify(source)}`);
    } catch (err) {
      // If the telemetry throws just log the error so it doesn't break any
      // functionality.
      Cu.reportError(err);
    }
  },

  disableProxyInfo(proxyInfo) {
    this.dumpProxies(proxyInfo, "disableProxyInfo");
    let key = this.getProxyInfoKey(proxyInfo);
    if (!key) {
      log(`direct request failure`);
      return;
    }
    // remove old entries
    for (let [k ,err] of this.errors) {
      if (hoursSince(err.time) >= DISABLE_HOURS) {
        this.errors.delete(k);
      }
    }
    this.errors.set(key, { time: Date.now() });
    this.logProxySource("disabled", proxyInfo);
    // If lots of proxies have failed, we
    // disable all proxies for a while to ensure system
    // requests have the best oportunity to get
    // through.
    if (!this.disabledTime && this.errors.size >= MAX_DISABLED_PI) {
      this.disabledTime = Date.now();
      this.recordEvent("start", "proxyBypass");
    }
  },

  enableProxyInfo(proxyInfo) {
    let key = this.getProxyInfoKey(proxyInfo);
    if (key && this.errors.has(key)) {
      this.errors.delete(key);
      this.logProxySource("enabled", proxyInfo);
    }
  },

  handleEvent(event) {
    let wrapper = event.currentTarget; // channel wrapper
    let { channel } = wrapper;
    if (!(channel instanceof Ci.nsIProxiedChannel)) {
      log(`got ${event.type} event but not a proxied channel`);
      return;
    }

    log(`request event ${event.type} rid ${wrapper.id} status ${wrapper.statusCode}`);
    switch (event.type) {
      case "error":
        this.disableProxyInfo(channel.proxyInfo);
        break;
      case "start":
        let status = wrapper.statusCode;
        if (status >= 200 && status < 400) {
          this.enableProxyInfo(channel.proxyInfo);
        }
        break;
    }
  },

  reset() {
    this.disabledTime = 0;
    this.errors = new Map();
  },

  store() {
    if (!this.disabledTime && !this.errors.size) {
      Services.prefs.clearUserPref(PREF_MONITOR_DATA);
      return;
    }
    let data = JSON.stringify({
      disabledTime: this.disabledTime,
      errors: Array.from(this.errors),
    });
    Services.prefs.setStringPref(PREF_MONITOR_DATA, data);
  },

  restore() {
    let failovers = Services.prefs.getStringPref(PREF_MONITOR_DATA, null);
    if (failovers) {
      failovers = JSON.parse(failovers);
      this.disabledTime = failovers.disabledTime;
      this.errors = new Map(failovers.errors);
    } else {
      this.disabledTime = 0;
      this.errors = new Map();
    }
  },

  startup() {
    // Register filter with a very high position, this will sort to the last filter called.
    ProxyService.registerChannelFilter(
      ProxyMonitor,
      Number.MAX_SAFE_INTEGER
    );
    this.restore();
    log("started");
  },

  shutdown() {
    ProxyService.unregisterFilter(ProxyMonitor);
    this.store();
    log("stopped");
  }
}

/**
 * Listen for changes in addons and pref to start or stop the ProxyMonitor.
 */
const monitor = {
  running: false,

  startup() {
    if (!this.failoverEnabled) {
      return;
    }

    Management.on("startup", this.handleEvent);
    Management.on("shutdown", this.handleEvent);
    Management.on("change-permissions", this.handleEvent);
    if (this.hasProxyExtension()) {
      monitor.startMonitors();
    }
  },

  shutdown() {
    Management.off("startup", this.handleEvent);
    Management.off("shutdown", this.handleEvent);
    Management.off("change-permissions", this.handleEvent);
    monitor.stopMonitors();
  },

  get failoverEnabled() {
    return Services.prefs.getBoolPref(PREF_PROXY_FAILOVER, true);
  },

  observe() {
    if (monitor.failoverEnabled) {
      monitor.startup();
    } else {
      monitor.shutdown();
    }
  },

  startMonitors() {
    if (!monitor.running) {
      ProxyMonitor.startup();
      monitor.running = true;
    }
  },

  stopMonitors() {
    if (monitor.running) {
      ProxyMonitor.shutdown();
      monitor.running = false;
    }
  },

  hasProxyExtension(ignore) {
    for (let policy of WebExtensionPolicy.getActiveExtensions()) {
      if (policy.id != ignore 
          && !policy.extension?.isAppProvided 
          && policy.hasPermission("proxy")) {
        return true;
      }
    }
    return false;
  },

  handleEvent(kind, ...args) {
    switch (kind) {
      case "startup": {
        let [extension] = args;
        if (!monitor.running 
            && !extension.isAppProvided 
            && extension.hasPermission("proxy")) {
          monitor.startMonitors();
        }
        break;
      }
      case "shutdown": {
        if (Services.startup.shuttingDown) {
          // Let normal shutdown handle things.
          break;
        }
        let [extension] = args;
        // Policy is still active, pass the id to ignore it.
        if (monitor.running 
            && !extension.isAppProvided 
            && !monitor.hasProxyExtension(extension.id)) {
          monitor.stopMonitors();
        }
        break;
      }
      case "change-permissions": {
        if (monitor.running) {
          break;
        }
        let { extensionId, added } = args[0];
        if (!added?.permissions.includes("proxy")) {
          return;
        }
        let extension = WebExtensionPolicy.getByID(extensionId)?.extension;
        if (extension && !extension.isAppProvided) {
          monitor.startMonitors();
        }
        break;
      }
    }
  },
};

this.failover = class extends ExtensionAPI {
  onStartup() {
    Services.telemetry.registerEvents("proxyMonitor", {
      proxyMonitor: {
        methods: ["enabled", "disabled", "start", "timeout"],
        objects: [
          "proxyInfo",
          "proxyBypass"
        ],
        extra_keys: ["source"],
        record_on_release: true,
      },
    });

    monitor.startup();
    Services.prefs.addObserver(PREF_PROXY_FAILOVER, monitor);
  }

  onShutdown() {
    monitor.shutdown();
    Services.prefs.removeObserver(PREF_PROXY_FAILOVER, monitor);
  }
};
