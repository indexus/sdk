import { checkRead, canceledRead } from "../utilities/sharedRead.js";
import { getHostFromIP } from "../utilities/network.js";

/** Shared address, authorization, cancellation and deadline policy for peer RPCs. */
export function peerUrl(protocol, ip, port, path, gateway) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (typeof gateway === "string" && gateway) {
    const host = encodeURIComponent(String(ip || "").trim() || "127.0.0.1");
    return `${gateway.replace(/\/$/, "")}/${host}/${port}${suffix}`;
  }
  return `${protocol}://${getHostFromIP(ip)}:${port}${suffix}`;
}

// These local reads must answer from the selected peer, even through a gateway.
export function requestLocalPeer(protocol, peer, path, params, options) {
  const url = peerUrl(protocol, peer.ip(), peer.port(), path, options.gateway);
  return requestPeer(url, options, { params, redirect: "error" });
}

export function authHeaders(extra = {}) {
  const token = globalThis.__INDEXUS_BEARER__ || globalThis.process?.env?.INDEXUS_BEARER;
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

// Errors keep the shape the read path tests (network/helpers.js
// transientReadFailure): `response.status` for an HTTP error, `code`
// ECONNABORTED for a timeout, ERR_CANCELED for an abort, ERR_NETWORK when no
// answer came.
function transportError(message, code, response) {
  return Object.assign(new Error(message), { code, ...(response && { response }) });
}

function headersObject(headers) {
  const out = {};
  for (const [key, value] of headers) out[key.toLowerCase()] = value;
  return out;
}

async function readData(response, responseType) {
  if (responseType === "arraybuffer") return response.arrayBuffer();
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : text;
  } catch {
    return text;
  }
}

/**
 * One peer RPC with fetch. `config`: `method` (default get), `data` (sent as
 * JSON), `params` (query), `headers`, `timeout`, `responseType`
 * ("arraybuffer", else JSON or text). Resolves `{status, headers, data}` with
 * lowercased header names; a non-2xx status rejects with `error.response`.
 */
export async function requestPeer(url, options = {}, config = {}) {
  const limit = options.timeoutMs ?? config.timeout ?? 15000;
  const timeout = Number.isFinite(limit) ? Math.max(1, limit) : 15000;
  const signal = options.signal;
  if (signal?.aborted) throw canceledRequest();
  if (config.params) url += (url.includes("?") ? "&" : "?") + new URLSearchParams(config.params);
  const headers = authHeaders(config.headers);
  const init = { method: (config.method ?? "get").toUpperCase(), headers };
  if (config.redirect) init.redirect = config.redirect;
  if (config.data !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(config.data);
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const answer = await fetch(url, { ...init, signal: controller.signal });
    const response = {
      status: answer.status,
      headers: headersObject(answer.headers),
      data: await readData(answer, config.responseType),
    };
    if (answer.ok) return response;
    const code = answer.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST";
    throw transportError(`Request failed with status code ${answer.status}`, code, response);
  } catch (error) {
    if (error?.response) throw error;
    if (timedOut) throw transportError(`timeout of ${timeout}ms exceeded`, "ECONNABORTED");
    if (signal?.aborted) throw canceledRequest();
    throw transportError(error?.message ?? "Network Error", "ERR_NETWORK");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function canceledRequest() {
  return Object.assign(new Error("canceled"), { name: "CanceledError", code: "ERR_CANCELED" });
}

export function waitForRetry(ms, signal) {
  checkRead(signal);
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(canceledRead(signal));
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
