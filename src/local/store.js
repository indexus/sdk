import { Item } from "../tree/item.js";

class Store {
  constructor() {
    this.clear();
  }

  clear() {
    this.elements = [];
    this.head = 0;
    this.count = 0;
    this.sorted = true;
    this.onlyTerminal = true;
  }

  get length() {
    return this.elements.length - this.head;
  }

  // Query callers need an array. Preparing and streaming use at() directly.
  get list() {
    return this.head ? this.elements.slice(this.head) : this.elements;
  }

  at(index) {
    return this.elements[this.head + index];
  }

  add(element) {
    this.elements.push(element);
    this.count += element.count();
    this.sorted = this.length <= 1;
    if (!(element instanceof Item) || element._terminal === false) this.onlyTerminal = false;
  }

  concat(list) {
    list.forEach((element) => this.add(element));
  }

  remove(selected, count) {
    if (selected === this.length) {
      this.clear();
      return;
    }
    for (let i = 0; i < selected; i++) this.elements[this.head++] = undefined;
    this.count -= count;
  }

  sort() {
    if (this.sorted) return;
    if (this.head) {
      this.elements = this.elements.slice(this.head);
      this.head = 0;
    }
    this.elements.sort((a, b) => a.distance() - b.distance());
    this.sorted = true;
  }
}

export { Store };
