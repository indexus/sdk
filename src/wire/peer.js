import { decodeFixed } from "../tree/index.js";

/** A Go peer name is Indexus-encoded, not base64 URL-encoded transport data. */
class Peer {
  constructor(name, ips, port, ip) {
    this._id = decodeFixed(name);
    this._hash = name;
    this._ips = ips;
    this._port = port;
    this._ip = ip;
  }

  id() {
    return this._id;
  }
  hash() {
    return this._hash;
  }
  ips() {
    return this._ips;
  }
  port() {
    return this._port;
  }
  ip() {
    return this._ip;
  }
}

export { Peer };
