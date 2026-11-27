import { Peer } from "../wire/peer.js";
import { BinarySearchTree } from "../tree/binarySearchTree.js";

function checkId(id, what = "id") {
  if (!(id instanceof Uint8Array)) throw new Error(`${what} must be a Uint8Array`);
}

/** The routing table: peers by id in a binary trie, nearest by shared prefix. */
class Table {
  constructor() {
    this._bst = new BinarySearchTree();
  }

  insert(id, peer) {
    checkId(id, "Peer ID");
    this._bst.insert(0, id, peer);
  }

  /** @returns {Peer | null} the peer whose id shares the longest prefix with `id` */
  nearest(id) {
    checkId(id);
    const peer = this._bst.nearest(0, id);
    return peer instanceof Peer ? peer : null;
  }

  /** @returns {boolean} true when the table is left empty */
  remove(id) {
    checkId(id);
    return this._bst.remove(0, id);
  }

  /** @returns {Peer[]} peers currently in the routing table */
  peers() {
    const out = [];
    this._bst.traverse(0, new Uint8Array(64), (_idx, _id, peer) => {
      if (peer instanceof Peer) out.push(peer);
    });
    return out;
  }
}

export { Table };
