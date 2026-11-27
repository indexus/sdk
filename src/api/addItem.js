import { peerUrl, requestPeer } from "./transport.js";

/** Write the canonical record identity and metrics; payload remains optional. */
export async function addItem(
  protocol,
  peer,
  collection,
  root,
  location,
  metrics,
  reference,
  options = {},
) {
  await requestPeer(peerUrl(protocol, peer.ip(), peer.port(), "/item", options.gateway), options, {
    method: "post",
    data: {
      item: {
        collection,
        location,
        metrics,
        id: reference,
        ...(options.payload === undefined ? {} : { payload: options.payload }),
      },
      root,
      current: location,
    },
  });
}
