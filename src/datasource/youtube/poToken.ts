import { logInternalWarn } from "../../internal/logging";

let warned = false;

// The BotGuard interpreter is supplied as JavaScript by a remote challenge.
// Do not inject it into the privileged app webview. Streaming can continue
// without a proof-of-origin token when YouTube permits that fallback.
export async function mintPoToken(_contentBinding: string): Promise<string | undefined> {
  if (!warned) {
    warned = true;
    logInternalWarn("poToken.mint disabled until BotGuard can run in an isolated context");
  }
  return undefined;
}
