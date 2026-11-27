import { test } from "node:test";
import assert from "node:assert/strict";
import { showWebGPUUnsupported, webgpuUnsupportedText } from "./unsupported.js";

// Just enough DOM for one container.
function fakeContainer() {
  const children = [];
  const element = () => {
    const node = {
      attributes: {},
      style: {},
      textContent: "",
      className: "",
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      remove() {
        const i = children.indexOf(node);
        if (i >= 0) children.splice(i, 1);
      },
    };
    return node;
  };
  return {
    children,
    ownerDocument: { createElement: element },
    append(node) {
      children.push(node);
    },
    querySelector: () =>
      children.find((node) => "data-indexus-webgpu-unsupported" in node.attributes) ?? null,
  };
}

test("the notice is an accessible status, localised by reason, replaceable and removable", () => {
  const container = fakeContainer();
  showWebGPUUnsupported(container, { reason: "no-webgpu" });
  const remove = showWebGPUUnsupported(container, { reason: "no-adapter", lang: "en" });
  assert.equal(container.children.length, 1, "a second call replaces the first notice");
  const [notice] = container.children;
  assert.equal(notice.attributes.role, "status");
  assert.equal(notice.attributes.lang, "en");
  assert.equal(notice.textContent, webgpuUnsupportedText("no-adapter", "en"));
  assert.match(notice.textContent, /WebGPU/);
  remove();
  assert.equal(container.children.length, 0);
});

test("text is overridable and unknown reasons or languages fall back to the generic French message", () => {
  const container = fakeContainer();
  showWebGPUUnsupported(container, { text: "Carte indisponible." });
  assert.equal(container.children[0].textContent, "Carte indisponible.");
  assert.equal(webgpuUnsupportedText("???", "de"), webgpuUnsupportedText(null, "fr"));
  assert.notEqual(
    webgpuUnsupportedText("no-webgpu", "fr"),
    webgpuUnsupportedText("no-webgpu", "en"),
  );
});
