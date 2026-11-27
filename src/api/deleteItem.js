import { peerUrl, requestPeer, waitForRetry } from "./transport.js";

/** Delete a canonical record; retry backpressure once without retaining an aborted timer. */
export async function deleteItem(
  protocol,
  peer,
  collection,
  root,
  location,
  reference,
  options = {},
) {
  const url = peerUrl(protocol, peer.ip(), peer.port(), "/item/delete", options.gateway);
  const send = () =>
    requestPeer(url, options, {
      method: "post",
      data: { item: { collection, location, id: reference }, root },
    });
  try {
    await send();
  } catch (error) {
    const retryAfter = error?.response?.headers?.["retry-after"];
    if (error?.response?.status !== 503 || !retryAfter) throw error;
    await waitForRetry(Math.max(1, Number(retryAfter)) * 1000, options.signal);
    await send();
  }
}
