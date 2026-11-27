import { Peer } from "../wire/peer.js";
import { peerUrl, requestPeer } from "./transport.js";

export async function getNeighbors(protocol, peer, origin, options = {}) {
  const { data } = await requestPeer(
    peerUrl(protocol, peer.ip(), peer.port(), "/neighbors", options.gateway),
    options,
    { params: { origin } },
  );
  return (data?.neighbors || []).map(
    (contact) =>
      new Peer(
        contact.name,
        contact.ips || {},
        contact.port,
        contact.ip || Object.keys(contact.ips || {})[0] || peer.ip(),
      ),
  );
}
