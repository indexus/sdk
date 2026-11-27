// Message shown in place of the heatmap when WebGPU is missing (heat pipeline
// v2, decision 5: a clear message, no fallback renderer). No framework: any
// app can call it with the map container.

const MESSAGES = {
  fr: {
    "no-webgpu":
      "Cette carte nécessite WebGPU, que ce navigateur ne fournit pas. Essayez un navigateur récent qui le prend en charge, par exemple Chrome ou Edge.",
    "insecure-context":
      "Cette carte nécessite WebGPU, disponible seulement sur une page sécurisée (https).",
    "no-adapter":
      "Cette carte nécessite WebGPU, mais aucune carte graphique compatible n’est disponible (accélération matérielle désactivée ?).",
    default: "Cette carte nécessite WebGPU, indisponible sur ce navigateur.",
  },
  en: {
    "no-webgpu":
      "This map requires WebGPU, which this browser does not provide. Try a recent browser that supports it, such as Chrome or Edge.",
    "insecure-context":
      "This map requires WebGPU, which is only available on a secure (https) page.",
    "no-adapter":
      "This map requires WebGPU, but no compatible graphics adapter is available (hardware acceleration disabled?).",
    default: "This map requires WebGPU, which is unavailable in this browser.",
  },
};

export function webgpuUnsupportedText(reason, lang = "fr") {
  const messages = MESSAGES[lang] ?? MESSAGES.fr;
  return messages[reason] ?? messages.default;
}

// Inserts an accessible notice into `container` and returns a function that
// removes it. Calling it again on the same container replaces the notice.
// `text` overrides the built-in wording; `className` lets the app restyle it
// (the inline layout only centres it over the map).
export function showWebGPUUnsupported(
  container,
  { reason = null, lang = "fr", text = null, className = "indexus-webgpu-unsupported" } = {},
) {
  const document = container.ownerDocument;
  container.querySelector(`[data-indexus-webgpu-unsupported]`)?.remove();
  const notice = document.createElement("div");
  notice.className = className;
  notice.setAttribute("data-indexus-webgpu-unsupported", reason ?? "");
  notice.setAttribute("role", "status");
  notice.setAttribute("lang", lang);
  notice.textContent = text ?? webgpuUnsupportedText(reason, lang);
  Object.assign(notice.style, {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    maxWidth: "28rem",
    padding: "0.75rem 1rem",
    zIndex: "2",
    background: "rgba(255, 255, 255, 0.92)",
    color: "#1a1a1a",
    borderRadius: "6px",
    font: "14px/1.4 system-ui, sans-serif",
    textAlign: "center",
  });
  container.append(notice);
  return () => notice.remove();
}
