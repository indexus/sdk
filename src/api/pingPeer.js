import { Peer } from "../wire/peer.js";
import { peerUrl, requestPeer } from "./transport.js";

/** Bootstrap discovery is bounded by the same deadline as other RPCs. */
export async function pingPeer(protocol, ip, port, options = {}) {
  const { data } = await requestPeer(
    peerUrl(protocol, ip, port, "/ping", options.gateway),
    options,
    {
      method: "post",
      data: {},
    },
  );
  const contact = data.contact;
  return new Peer(contact.name, contact.ips, contact.port, ip);
}
