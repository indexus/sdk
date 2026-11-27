// What the heat worker tells the main thread about its network: peers (and a
// wider table worth a second read), request activity batched per 200 ms so a
// drill is not one render per /sets, and read metrics once a second.

const ACTIVITY_FLUSH_MS = 200;
const ACTIVITY_BATCH_MAX = 64;

function routingKey(network) {
  try {
    return network.routingKeyHash();
  } catch {
    return null;
  }
}

/**
 * @param {object} network
 * @param {{post: Function, visible: () => boolean, onWider: () => void}} hooks
 *   onWider: the peer table grew
 */
export function watchNetwork(network, { post, visible, onWider }) {
  let activity = [];
  let activityTimer = null;
  let metricsTimer = null;
  let peerCount = network.listPeers().length;

  const publishPeers = (peers) =>
    post({ type: "NETWORK_PEERS", payload: { peers, routingKey: routingKey(network) } });

  network.setActivityHandler((event) => {
    if (!visible()) return;
    activity.push(event);
    if (activity.length > ACTIVITY_BATCH_MAX) activity.shift();
    if (activityTimer !== null) return;
    activityTimer = setTimeout(() => {
      activityTimer = null;
      const events = activity;
      activity = [];
      if (events.length === 0) return;
      post({ type: "NETWORK_ACTIVITY", payload: { events, latest: events.at(-1) } });
    }, ACTIVITY_FLUSH_MS);
  });
  network.setPeersHandler((peers) => {
    const list = Array.isArray(peers) ? peers : [];
    publishPeers(list);
    if (list.length > peerCount) onWider();
    peerCount = list.length;
  });
  network.setMetricsHandler((snap) => {
    if (visible()) post({ type: "NETWORK_METRICS", payload: snap });
  });

  return {
    /** After whenReady: the table the session starts with. */
    ready() {
      const peers = network.listPeers();
      peerCount = peers.length;
      publishPeers(peers);
    },

    /** Metrics flow while the map is visible. */
    update() {
      clearInterval(metricsTimer);
      metricsTimer = null;
      if (!visible()) {
        clearTimeout(activityTimer);
        activityTimer = null;
        activity = [];
        return;
      }
      const publish = () => post({ type: "NETWORK_METRICS", payload: network.readMetrics() });
      publish();
      metricsTimer = setInterval(publish, 1000);
    },

    stop() {
      clearTimeout(activityTimer);
      clearInterval(metricsTimer);
    },
  };
}
