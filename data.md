# Proxy Monitor Pings

This add-on will collect information about whether a proxy configuration is 
bypassed, and how that configuration was configured.  It does not collect
information about the specific proxy, such as IP address, etc.

- Category: "proxyMonitor"
- Methods:
  - "enabled" a proxy configuration has been re-enabled after a successful request using it
  - "disabed" a proxy configuration has been disabled after a request failure using it
  - "start" a proxy bypass has started
  - "timeout" the configured bypass (full or single proxy config) period has passed
- Objects
  - "proxyBypass" a direct bypass has started or ended
  - "proxyInfo" a single specific proxy configuration
- Type: 
  - The type of the proxy configuration if "proxyInfo"
    - "api" The source is the proxy.onRequest API listener
    - "direct", "manual", "pac", "wpad", "system" The type of proxy configuration defined in preferences, possibly through extension settings
  - The type of bypass if "proxyBypass"
    - "global" all proxies are disabled
    - "extension" a specific extension is disabled, identified by "source"
- extra keys: 
  - "source" The source of the proxy configuration
    - values: 
      - The `extension id` if the proxy is from an extension through an API or by modifying preferences through settings.
      - "policy" if the proxy is configured in enterprise policy
      - "prefs" if the proxy is configured through preferences

## Example log entry

```js
"dynamic": {
  "events": [
    [
      9976336,
      "proxyMonitor",
      "disabled",
      "proxyInfo",
      "api",
      {
        "source": "48aaef5585debab891fd011b163f4ed7771ffe8e@temporary-addon"
      }
    ]
  ]
}
```
