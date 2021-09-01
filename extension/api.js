
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyGlobalGetters(this, ["ChannelWrapper", "WebExtensionPolicy"]);
XPCOMUtils.defineLazyServiceGetter(
  this,
  "ProxyService",
  "@mozilla.org/network/protocol-proxy-service;1",
  "nsIProtocolProxyService"
);
ChromeUtils.defineModuleGetter(
  this,
  "AddonManager",
  "resource://gre/modules/AddonManager.jsm"
);
const { Utils } = ChromeUtils.import(
  "resource://services-settings/Utils.jsm"
);

const PROXY_DIRECT = "direct";
const DISABLE_HOURS = 48;
const MAX_DISABLED_PI = 5;
const MAX_DIRECT_FAILURES = 5;
const PREF_MONITOR_DATA = "extensions.proxyMonitor";
const PREF_PROXY_FAILOVER = "network.proxy.failover_direct";
const BECONSERVATIVE_SUPPORTED = Services.vc.compare(Services.appinfo.version, "93.0a1") >= 0;

const REMOTE_SERVICES_ERROR = "remote-settings:sync-error"
const CONTENT_SERVICES = new Map([
  ["remote-settings", Utils.SERVER_URL],
]);

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
 * Watch for notifications from services where content failures such as a
 * content signature failure.
 * 
 * If we have these failures, a following request will bypass proxies.
 */
const ContentMonitor = {
  contentErrors: new Map(),

  startup() {
    Services.obs.addObserver(this, REMOTE_SERVICES_ERROR);
  },

  shutdown() {
    Services.obs.removeObserver(this, REMOTE_SERVICES_ERROR);
  },

  observe (subject, topic, data) {
    switch (topic) {
      case REMOTE_SERVICES_ERROR:
        let e = subject.wrappedJSObject.error;
        if (e.name.includes("SignatureError")) {
          this.contentErrors.set("remote-settings", Date.now());
        }
        break;
      case  "remote-settings:changes-poll-end":
        // If we expand the covered services this will change, but for
        // now, we just clear the content errors when we have a success.
        this.contentErrors = new Map();
      default:
        break;
    }
  },
  
  checkErrors(url) {
    // If we have content errors, bypass proxy.  We wont have any specific proxyInfo data
    // for content errors since they happen after a request is finished.
    for (let [source, timestamp] of this.contentErrors) {
      let baseUrl = CONTENT_SERVICES.get(source);
      if (baseUrl && url.startsWith(baseUrl)) {
        let old = hoursSince(timestamp) >= DISABLE_HOURS;
        if (!old) {
          return true;
        }
        this.contentErrors.delete(source);
        break;
      }
    }
    return false;
  }
}

/**
 * ProxyMonitor monitors system and protected requests for failures
 * due to bad or unavailable proxy configurations.
 * 
 * 1. Any proxied system request without a direct failover will have one added.
 * 
 * 2. If a proxied system request fails, the proxy configuration in use will
 * be disabled.  On later requests, disabled proxies are removed from the proxy chain.
 * Disabled proxy configurations remain disabled for 48 hours to allow any necessary
 * requests to operate for a period of time.
 * 
 * 3. If too many proxy configurations get disabled, we completely disable proxies
 * for these requests.  This state remains for 48 hours.
 * 
 * 4. If we've removed all proxies or otherwise force a direct connection, and several
 * of the direct connections fail, we'll try (once) proxies again to see if it was
 * an intermittent failure.  Otherwise the above rules continue to apply.
 * 
 * If we've disabled proxies, we continue to watch the requests for failures in
 * "direct" connection mode.  If we continue to fail with direct connections,
 * we fall back to allowing proxies again.
 */
const ProxyMonitor = {
  started: false,
  errors: new Map(),
  disabledTime: 0,
  directFailures: 0,

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
      let isSystem = BECONSERVATIVE_SUPPORTED
        ? channel.QueryInterface(Ci.nsIHttpChannelInternal)?.beConservative 
        : channel.loadInfo?.loadingPrincipal?.isSystemPrincipal
      if (!isSystem) {
        return;
      }

      // Proxies are configured so we want to monitor for non-connection errors 
      // such as invalid proxy servers.  We also monitor for direct connection 
      // failures if we end up pruning all proxies below.
      let wrapper = ChannelWrapper.get(channel);
      wrapper.addEventListener("error", this);
      wrapper.addEventListener("stop", this);

      // We've disabled PIs but are still failing with direct connections try
      // the proxies again for a request, it may be connectivity issues or a down server.
      // If the request succeeds with the proxy, and it is a disabled proxy, it will
      // get enabled again, reducing errors.size.
      if (this.directFailures > MAX_DIRECT_FAILURES && this.errors.size) {
        log(`too many direct connect failures, retry default proxies rid ${wrapper.id}`);
        this.directFailures = 0;
        return;
      }

      // If we've received invalid signatures, we'll go direct until there is a successful
      // content request.  The directFailure logic above will retry proxies on occasion to
      // prevent permenant failure if the system network requires proxy to get out.
      if (ContentMonitor.checkErrors(wrapper.finalURL)) {
        log(`content signature failures, remove proxies and try direct rid ${wrapper.id}`);
        proxyInfo = null;
        return;
      }

      // If we have to many proxyInfo objects disabled we simply bypass proxy
      // entirely.
      if (this.tooManyFailures()) {
        log(`too many proxy config failures, remove proxies and try direct rid ${wrapper.id}`);
        proxyInfo = null;
        return;
      }
      this.dumpProxies(proxyInfo, `starting proxyInfo rid ${wrapper.id}`);

      let enabledProxies = this.pruneProxyInfo(proxyInfo);
      if (!enabledProxies.length) {
        // No proxies are left enabled, we can bail out.
        log(`all proxies disabled, try direct`);
        proxyInfo = null;
        return;
      }
  
      proxyInfo = enabledProxies[0];
      let lastFailover = enabledProxies.pop();

      if (lastFailover.failoverProxy || lastFailover.type != PROXY_DIRECT) {
        // Ensure there is always a direct failover for our critical requests.  This
        // catches connection failures such as those to non-existant or non-http ports.
        // The "error" handler added above catches http connections that are not proxy servers.
        lastFailover.failoverProxy = ProxyService.newProxyInfo(
          PROXY_DIRECT, "", 0, "", "", 0, 0, null
        );
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

  disableProxyInfo(proxyInfo) {
    this.dumpProxies(proxyInfo, "disableProxyInfo");
    let key = this.getProxyInfoKey(proxyInfo);
    if (!key) {
      this.directFailures++;
      log(`direct request failure ${this.directFailures}`);
      return;
    }
    log(`disable ${key}`);
    this.errors.set(key, { time: Date.now() });
    // If lots of proxies have failed, we
    // disable all proxies for a while to ensure system
    // requests have the best oportunity to get
    // through.
    if (this.errors.size >= MAX_DISABLED_PI) {
      this.disabledTime = Date.now();
    }
  },

  enableProxyInfo(proxyInfo) {
    let key = this.getProxyInfoKey(proxyInfo);
    if (key && this.errors.has(key)) {
      log(`enable ${key}`);
      this.errors.delete(key);
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
      case "stop":
        let status = wrapper.statusCode;
        if (status >= 200 && status < 400) {
          this.enableProxyInfo(channel.proxyInfo);
        }
        break;
    }
  },

  reset() {
    this.directFailures = 0;
    this.disabledTime = 0;
    this.errors = new Map();
  },

  store() {
    let data = JSON.stringify({
      directFailures: this.directFailures,
      disabledTime: this.disabledTime,
      errors: Array.from(this.errors),
    });
    Services.prefs.setStringPref(PREF_MONITOR_DATA, data);
  },

  restore() {
    let failovers = Services.prefs.getStringPref(PREF_MONITOR_DATA, null);
    if (failovers) {
      failovers = JSON.parse(failovers);
      this.directFailures = failovers.directFailures;
      this.disabledTime = failovers.disabledTime;
      this.errors = new Map(failovers.errors);
    }
  },

  startup() {
    if (this.started) {
      return;
    }
    // Register filter with a very high position, this will sort to the last filter called.
    ProxyService.registerChannelFilter(
      ProxyMonitor,
      Number.MAX_SAFE_INTEGER
    );
    this.started = true;
    this.restore();
    log("started");
  },

  shutdown() {
    if (!this.started) {
      return;
    }
    ProxyService.unregisterFilter(ProxyMonitor);
    this.started = false;
    this.store();
    log("stopped");
  }
}

/**
 * Listen for changes in addons and pref to start or stop the ProxyMonitor.
 */
const monitor = {
  startup() {
    if (this.failoverEnabled) {
      AddonManager.addAddonListener(this);
      if (this.hasProxyExtension()) {
        ProxyMonitor.startup();
        ContentMonitor.startup();
      }
    }
  },

  shutdown() {
    AddonManager.removeAddonListener(this);
    ProxyMonitor.shutdown();
    ContentMonitor.shutdown();
  },

  observe() {
    if (monitor.failoverEnabled) {
      monitor.startup();
    } else {
      monitor.shutdown();
    }
  },

  hasProxyExtension() {
    for (let policy of WebExtensionPolicy.getActiveExtensions()) {
      if (policy.hasPermission("proxy")) {
        return true;
      }
    }
    return false;
  },

  get failoverEnabled() {
    return Services.prefs.getBoolPref(PREF_PROXY_FAILOVER, true);
  },

  shouldMonitor(addon) {
    return addon.type == "extension" 
      && !addon.isSystem 
      && WebExtensionPolicy.getByID(addon.id).hasPermission("proxy");
  },

  onEnabled(addon) {
    if (this.shouldMonitor(addon)) {
      ProxyMonitor.startup();
    }
  },

  onDisabled(addon) {
    if (!this.hasProxyExtension()) {
      ProxyMonitor.shutdown();
    }
  },

  onInstalled(addon) {
    if (this.shouldMonitor(addon)) {
      ProxyMonitor.startup();
    }
  },

  onUninstalled(addon) {
    if (!this.hasProxyExtension()) {
      ProxyMonitor.shutdown();
    }
  },
};

this.failover = class extends ExtensionAPI {
  onStartup() {
    monitor.startup();
    Services.prefs.addObserver(PREF_PROXY_FAILOVER, monitor);
  }

  onShutdown() {
    monitor.shutdown();
    Services.prefs.removeObserver(PREF_PROXY_FAILOVER, monitor);
  }
};
