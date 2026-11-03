import type { OptionsRequest } from "../worker/control";

const TOKEN_KEY = "pairingToken";
const input = document.getElementById("token") as HTMLInputElement;
const result = document.getElementById("result") as HTMLElement;

input.value = ((await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY] as string | undefined) ?? "";

document.getElementById("save")!.addEventListener("click", async () => {
  await chrome.storage.local.set({ [TOKEN_KEY]: input.value.trim() });
  result.textContent = "Testing the backend...";
  const res = (await chrome.runtime.sendMessage({ type: "test_backend" } satisfies OptionsRequest)) as { ok: boolean; detail: string };
  result.textContent = res.ok ? "Connected to the backend." : `Not connected: ${res.detail}`;
});
