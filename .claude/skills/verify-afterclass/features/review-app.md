# Review app shell

## Sub-features

- Served bundle at `/app/`, deep link `/app/capture/<id>`, with the pairing token in a meta tag.

## How to get to it (user POV)

Derek clicks the popup's review link; the extension opens the tab.

## Driving it with Claude in Chrome

1. Ingest the fixture (see capture-ingest.md).
2. `curl -s http://127.0.0.1:$PORT/app/capture/cap_ezfc5wzmacr3v72qohuhllql4k | grep afterclass-token` must print the meta tag.
3. Navigate a tab to the same URL, read the page text, take a screenshot into `.claude/shots/`, close the tab.

## Gotchas

- A link click from a page is cross-site and gets 403; use a direct navigation (the extension uses `chrome.tabs.create`).
- Step 3 was not run when this file was written.
