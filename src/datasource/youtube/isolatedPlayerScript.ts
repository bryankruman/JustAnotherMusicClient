// Player JavaScript is supplied by YouTube. Execute it in an opaque-origin,
// script-only data frame rather than in the Tauri application window.
const FRAME_HTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; frame-src 'none'; form-action 'none'"><script>
window.addEventListener('message', function(event) {
  if (event.source !== window.parent || !event.data || event.data.kind !== 'evaluate') return;
  var id = event.data.id;
  try {
    if (typeof event.data.code !== 'string' || event.data.code.length > 524288) throw new Error('player script too large');
    var value = new Function(event.data.code)();
    if (!value || typeof value !== 'object') throw new Error('invalid player result');
    var result = {};
    for (var key of ['sig', 'n']) {
      if (typeof value[key] === 'string') {
        if (value[key].length > 8192) throw new Error('player result too large');
        result[key] = value[key];
      }
    }
    window.parent.postMessage({ kind: 'result', id: id, value: result }, '*');
  } catch (error) {
    window.parent.postMessage({ kind: 'result', id: id, error: String(error && error.message || error) }, '*');
  }
});
window.parent.postMessage({ kind: 'ready' }, '*');
</script>`;

type Pending = { resolve: (value: Record<string, string>) => void; reject: (error: Error) => void; timeout: number };
let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

function ensureFrame(): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve, reject) => {
    const created = document.createElement("iframe");
    created.sandbox.add("allow-scripts");
    created.setAttribute("aria-hidden", "true");
    created.style.display = "none";
    created.src = `data:text/html;charset=utf-8,${encodeURIComponent(FRAME_HTML)}`;
    frame = created;
    function onReady(event: MessageEvent) {
      if (event.source !== created.contentWindow || event.origin !== "null" || event.data?.kind !== "ready") return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onReady);
      resolve();
    }
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onReady);
      created.remove();
      if (frame === created) frame = null;
      ready = null;
      reject(new Error("Isolated player frame did not start."));
    }, 5_000);
    window.addEventListener("message", onReady);
    document.body.appendChild(created);
  });
  return ready;
}

window.addEventListener("message", (event) => {
  if (event.source !== frame?.contentWindow || event.origin !== "null" || event.data?.kind !== "result") return;
  const id = event.data.id;
  if (!Number.isSafeInteger(id)) return;
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  window.clearTimeout(request.timeout);
  if (typeof event.data.error === "string") {
    request.reject(new Error(event.data.error.slice(0, 256)));
  } else {
    const value = event.data.value;
    if (!value || typeof value !== "object") {
      request.reject(new Error("Invalid isolated player result."));
      return;
    }
    const safe: Record<string, string> = {};
    for (const key of ["sig", "n"]) {
      if (typeof value[key] === "string" && value[key].length <= 8192) safe[key] = value[key];
    }
    request.resolve(safe);
  }
});

export async function evaluatePlayerScript(code: string): Promise<Record<string, string>> {
  if (code.length > 524288) throw new Error("Player script exceeds the 512 KB limit.");
  await ensureFrame();
  return new Promise<Record<string, string>>((resolve, reject) => {
    const id = ++nextId;
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("Isolated player evaluation timed out."));
    }, 10_000);
    pending.set(id, { resolve, reject, timeout });
    frame?.contentWindow?.postMessage({ kind: "evaluate", id, code }, "*");
  });
}
