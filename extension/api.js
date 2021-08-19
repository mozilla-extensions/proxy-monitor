
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyGlobalGetters(this, ["ChannelWrapper"]);
XPCOMUtils.defineLazyServiceGetter(
  this,
  "ProxyService",
  "@mozilla.org/network/protocol-proxy-service;1",
  "nsIProtocolProxyService"
);

const directProxy = ["direct", "system"];
const DISABLE_HOURS = 48;
const MAX_DISABLED_PI = 10;
const MAX_DIRECT_FAILURES = 20;
const PREF_MONITOR_DATA = "extensions.proxyMonitor";

function hoursSince(dt2, dt1 = Date.now()) {
  var diff = (dt2 - dt1) / 1000;
  diff /= (60 * 60);
  return Math.abs(Math.round(diff));
}

/**
 * ProxyMonitor monitors system and protected requests for failures
 * due to bad or unavailable proxy configurations.
 * 
 * Any proxy configuration that fails is disabled.  On later requests,
 * disabled proxies are removed from the proxy chain.  Disabled proxy
 * configurations remain disabled for 48 hours to allow any necessary
 * requests to operate for a period of time.
 * 
 * If too many proxy configurations get disabled, we completely disable proxies
 * for these requests.  This state remains for 48 hours.
 * 
 * If we've disabled proxies, we continue to watch the requests for failures in
 * "direct" connection mode.  If we continue to fail with direct connections,
 * we fall back to allowing proxies again.
 */
const ProxyMonitor = {
  errors: new Map(),
  disabledTime: 0,
  directFailures: 0,

  async applyFilter(channel, defaultProxyInfo, proxyFilter) {
    let proxyInfo = defaultProxyInfo;
    try {
      if (!proxyInfo) {
        // If no proxy is in use, exit early.
        return;
      }
      let wrapper = ChannelWrapper.get(channel);
      // If this is not a system request or internal service, we will allow existing
      // proxy behavior.
      if (wrapper.canModify) {
        return;
      }

      // Monitor for non-connection errors such as invalid proxy servers.
      wrapper.addEventListener("error", this);
      wrapper.addEventListener("stop", this);

      // If we have to many proxyInfo objects disabled we simply bypass proxy
      // entirely.
      if (this.tooManyFailures()) {
        proxyInfo = null;
        return;
      }

      // Verify the entire proxy failover chain is clean.  There may be multiple
      // sources for proxyInfo in the chain, so we remove any disabled entries
      // and continue to use configurations that have not yet failed.

      // Prune our disabled PIs.  Flatten to an array, and re-link the chain.
      let piList = [];
      let pi = proxyInfo;
      while (pi) {
        if (!this.proxyDisabled(pi)) {
          piList.push(pi);
        }
        pi = pi.failoverProxy;
      }
      if (!piList.length) {
        // No proxies are enabled, we can bail out.
        proxyInfo = null;
        return;
      }
      // There is at least one PI left enabled.
      // failoverProxy cannot be set to undefined, so || null
      for (let i = 0; i++; i < Math.max(piList.length - 2, 0)) {
        piList[pi].failoverProxy = piList[pi + 1] || null; // undefined when > length
      }
      proxyInfo = piList[0];
      let failover = piList.pop();

      // A little debug output
      // pi = proxyInfo;
      // while (pi) {
      //   console.log(this.getProxyInfoKey(pi));
      //   pi = pi.failoverProxy;
      // }

      if (!directProxy.includes(failover.type)) {
        // Ensure there is always a direct failover for our critical requests.  This
        // catches connection failures such as those to non-existant or non-http ports.
        failover.failoverProxy = ProxyService.newProxyInfo(
          "direct", "", 0, "", "", 0, 0, null
        );
        // console.log(`failover: direct failover added after proxy ${failover.type}:${failover.host}:${failover.port} for "${wrapper.finalURI.spec}"`);
      }
    } finally {
      // This must be called.
      proxyFilter.onProxyFilterResult(proxyInfo);
    }
  },

  tooManyFailures() {
    if (this.directFailures > MAX_DIRECT_FAILURES && this.errors.size) {
      // We've disabled PIs but are still failing with direct connections, so
      // we reset everything and start over.
      this.reset();
    }
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

    console.log(`failover: proxy disabled ${key}`);
    // This is harsh, but these requests are too important.
    return true;
  },

  getProxyInfoKey(proxyInfo) {
    if (!proxyInfo) {
      return;
    }
    let { type, host, port } = proxyInfo;
    if (!directProxy.includes(type)) {
      return `${type}:${host}:${port}`;
    }
  },

  disableProxyInfo(proxyInfo) {
    let key = this.getProxyInfoKey(proxyInfo);
    if (!key) {
      this.directFailures++;
      return;
    }
    let err = this.errors.get(key);
    if (err) {
      err.count++;
      err.time = Date.now();
    } else {
      err = { count: 1, time: Date.now() };
    }
    this.errors.set(key, err);
    // If lots of proxies fail constantly, we
    // disable for a while to ensure system
    // requests have the best oportunity to get
    // through.
    if (this.errors.size >= MAX_DISABLED_PI) {
      this.disabledTime = Date.now();
    }
  },

  enableProxyInfo(proxyInfo) {
    let key = this.getProxyInfoKey(proxyInfo);
    if (key && this.errors.has(key)) {
      this.errors.delete(key);
    }
  },

  handleEvent(event) {
    let wrapper = event.currentTarget; // channel wrapper
    let { channel } = wrapper;
    if (!(channel instanceof Ci.nsIProxiedChannel) || !channel.proxyInfo) {
      return;
    }

    switch (event.type) {
      case "error":
        this.disableProxyInfo(channel.proxyInfo);
        break;
      case "stop":
        let status = channel.statusCode;
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
  }
}

this.failover = class extends ExtensionAPI {
  async onStartup() {
    // Register filter with a very high position, this will sort to the last filter called.
    ProxyService.registerChannelFilter(
      ProxyMonitor,
      Number.MAX_SAFE_INTEGER
    );
    ProxyMonitor.restore();
  }
  onShutdown() {
    ProxyService.unregisterFilter(ProxyMonitor);
    ProxyMonitor.store();
  }
};
