import { backend, connectPageUrl } from "../worker/backend";
import type { Connection, ConnectionRequest, OptionsRequest } from "../worker/control";

const BACKEND = backend();
const result = document.getElementById("result") as HTMLElement;

const STATUS: Readonly<Record<Connection["kind"], string>> = {
  local: "",
  connected: "Connected to your account.",
  not_connected: "Not connected yet.",
  disconnected: "Disconnected from your account. Press Connect to reconnect.",
};

if (BACKEND.kind === "hosted") {
  document.getElementById("local")!.hidden = true;
  document.getElementById("hosted")!.hidden = false;
  document.getElementById("connect")!.addEventListener("click", () => void chrome.tabs.create({ url: connectPageUrl(BACKEND) }));
  const show = async () => {
    const c = (await chrome.runtime.sendMessage({ type: "connection" } satisfies ConnectionRequest)) as Connection;
    result.textContent = STATUS[c.kind];
  };
  void show();
  chrome.storage.onChanged.addListener(() => void show());
} else {
  const TOKEN_KEY = "pairingToken";
  const input = document.getElementById("token") as HTMLInputElement;
  input.value = ((await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY] as string | undefined) ?? "";

  document.getElementById("save")!.addEventListener("click", async () => {
    await chrome.storage.local.set({ [TOKEN_KEY]: input.value.trim() });
    result.textContent = "Testing the backend...";
    const res = (await chrome.runtime.sendMessage({ type: "test_backend" } satisfies OptionsRequest)) as { ok: boolean; detail: string };
    result.textContent = res.ok ? "Connected to the backend." : `Not connected: ${res.detail}`;
  });
}
