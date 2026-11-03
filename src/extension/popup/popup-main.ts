import type { PopupRequest, WorkerResponse } from "../worker/service-worker";
import { renderPopup } from "./popup";

async function send(req: PopupRequest) {
  const res = (await chrome.runtime.sendMessage(req)) as WorkerResponse;
  if (res.error) throw new Error(res.error);
  return res.state;
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const root = document.getElementById("root");
if (root && tab?.id !== undefined) renderPopup(root, send, { id: tab.id, url: tab.url });
else if (root) root.textContent = "No active tab.";
