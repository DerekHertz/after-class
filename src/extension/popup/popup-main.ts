import type { Connection, ConnectionRequest } from "../worker/control";
import type { PopupRequest, WorkerResponse } from "../worker/service-worker";
import { openInTab, renderPopup } from "./popup";

async function send(req: PopupRequest) {
  const res = (await chrome.runtime.sendMessage(req)) as WorkerResponse;
  if (res.error) throw new Error(res.error);
  return res.state;
}

const connection = async () => (await chrome.runtime.sendMessage({ type: "connection" } satisfies ConnectionRequest)) as Connection;

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const root = document.getElementById("root");
if (root && tab?.id !== undefined) renderPopup(root, send, { id: tab.id, url: tab.url }, openInTab, connection);
else if (root) root.textContent = "No active tab.";
