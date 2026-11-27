import { API } from "../api/index.js";
import { Network } from "../network/index.js";

// Session for applications using the configured /api gateway. Authentication
// and bootstrap are shared by consumers; data still goes through Network.
export class GatewaySession {
  constructor({
    origin = globalThis.location?.origin,
    request = globalThis.fetch,
    concurrency = 8,
    cacheSize = 20000,
    contentRecords = false,
  } = {}) {
    if (!origin || typeof request !== "function")
      throw new Error("GatewaySession requires an origin and fetch");
    this.origin = new URL(origin).origin;
    this.request = request.bind(globalThis);
    this.concurrency = concurrency;
    this.cacheSize = cacheSize;
    this.contentRecords = contentRecords === true;
    this.settings = null;
    this.authentication = null;
    this.connection = null;
    this.bearer = "";
    this.validUntil = 0;
  }

  async _json(path, options) {
    const response = await this.request(new URL(path, this.origin), {
      ...options,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Indexus gateway ${path}: HTTP ${response.status}`);
    return response.json();
  }

  async _settings() {
    if (!this.settings) {
      this.settings = Promise.all([this._json("/api/health"), this._json("/api/mesh")])
        .then(([health, mesh]) => {
          if (!health.network_id) throw new Error("No active Indexus network");
          const hosts = new Set();
          const add = (host) => {
            if (typeof host === "string" && host.trim()) hosts.add(host.trim());
          };
          for (const host of mesh.hosts ?? []) add(host);
          for (const node of mesh.nodes ?? [])
            if (node.up) {
              if (node.host) add(node.host);
              else if (node.ip && node.p2p) add(`${node.ip}|${node.p2p}`);
            }
          add(mesh.bootstrap);
          add(health.bootstrap);
          if (!hosts.size) throw new Error("No Indexus bootstrap hosts");
          return {
            networkId: health.network_id,
            networkLabel: health.network_label || health.network_id,
            hosts: [...hosts],
            protocol: health.p2p_protocol || "http",
            gateway: new URL("/api/p2p", this.origin).href,
          };
        })
        .catch((error) => {
          this.settings = null;
          throw error;
        });
    }
    return this.settings;
  }

  async _authenticate() {
    if (this.bearer && Date.now() < this.validUntil) return this.bearer;
    if (!this.authentication) {
      this.authentication = this._json("/api/token", { method: "POST" })
        .then((data) => {
          if (typeof data.token !== "string" || !data.token)
            throw new Error("Indexus token missing");
          this.bearer = data.token;
          this.validUntil = Date.now() + 240000;
          return this.bearer;
        })
        .finally(() => {
          this.authentication = null;
        });
    }
    return this.authentication;
  }

  async configuration() {
    const settings = await this._settings();
    const bearer = await this._authenticate();
    globalThis.__INDEXUS_NETWORK_ID__ = settings.networkId;
    globalThis.__INDEXUS_BEARER__ = bearer;
    return { ...settings, hosts: [...settings.hosts], bearer };
  }

  async network() {
    const config = await this.configuration();
    if (!this.connection) {
      this.connection = (async () => {
        const network = new Network(
          config.protocol,
          new API(),
          config.hosts,
          this.concurrency,
          this.cacheSize,
          {
            gateway: config.gateway,
            contentRecords: this.contentRecords,
            seedPeers: [],
            navigation: "direct",
            meshDiscoveryIntervalMs: 10000,
          },
        );
        await network.whenReady();
        if (!network.listPeers().length) throw new Error("No reachable Indexus peer");
        return network;
      })().catch((error) => {
        this.connection = null;
        throw error;
      });
    }
    return this.connection;
  }
}
