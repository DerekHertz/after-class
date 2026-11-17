import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/** The companion's first-run tutorial in the UI preview: `?tutorial=1` turns it on, with its seen state kept in memory. */
const FIRST_RUN = "/app/?scenario=first-run&tutorial=1";
const bubbleOf = (page: Page) => page.getByRole("dialog", { name: /^Tutorial from/ });

/** True when the two elements' boxes share any area. */
async function overlap(a: Locator, b: Locator): Promise<boolean> {
  const [x, y] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (x === null || y === null) return false;
  return x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
}

test("the tutorial walks home, the lecture page, the topic checklist and the first question, and never blocks a real action", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIRST_RUN);
  const bubble = bubbleOf(page);

  // Home, nothing captured yet.
  await expect(bubble).toContainText("Open a YouTube lecture in Chrome");
  await expect(bubble).toBeFocused();
  await expect(bubble.locator(".tutorial-text")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator(".tutorial-ring").first()).toBeVisible();
  expect(await page.locator(".tutorial-ring").first().evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
  expect(await bubble.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
  await expect(bubble.getByRole("button", { name: "Back" })).toBeDisabled();
  await bubble.getByRole("button", { name: "Next" }).click();
  await expect(bubble).toContainText("Capture runs only after you choose Start capture");
  await bubble.getByRole("button", { name: "Back" }).click();
  await expect(bubble).toContainText("Open a YouTube lecture in Chrome");
  await bubble.getByRole("button", { name: "Next" }).click();
  await bubble.getByRole("button", { name: "Got it" }).click();
  await expect(bubble).toHaveCount(0);

  // The lecture page.
  await page.getByRole("link", { name: "Capture", exact: true }).click();
  await expect(bubble).toContainText("Watched is how much of the lecture you played");
  await bubble.getByRole("button", { name: "Next" }).click();
  await expect(bubble).toContainText("Start review begins now");
  // The bubble is not modal: the control it is about still works under it.
  const start = page.getByRole("button", { name: "Start review", exact: true });
  expect(await overlap(bubble, start)).toBe(false);
  await start.click();

  // The topic checklist.
  await expect(bubble).toContainText("Tick the topics that feel fuzzy");
  await bubble.getByRole("button", { name: "Next" }).click();
  await expect(bubble).toContainText("Nothing begins until you do");
  expect(await overlap(bubble, page.getByRole("button", { name: "Start review", exact: true }))).toBe(false);
  await page.getByRole("button", { name: "Start review", exact: true }).click();

  // The first question: the bubble covers neither the answer box nor its buttons.
  await expect(bubble).toContainText("Answer in your own words");
  await expect(bubble).toBeFocused();
  const submit = page.getByRole("button", { name: "Share my thinking" });
  await expect(submit).toBeVisible();
  expect(await overlap(bubble, page.getByRole("textbox", { name: "Your thinking" }))).toBe(false);
  expect(await overlap(bubble, submit)).toBe(false);
  await bubble.getByRole("button", { name: "Next" }).click();
  await expect(bubble).toContainText("Hint asks for a hint");
  for (const name of ["Hint", "I don't know"]) expect(await overlap(bubble, page.getByRole("button", { name, exact: true }))).toBe(false);
  await bubble.getByRole("button", { name: "Next" }).click();
  await expect(bubble).toContainText("Lecture source opens the part of the lecture");
  await bubble.getByRole("button", { name: "Next" }).click();
  await expect(bubble).toContainText("choose Finish & save");
  await bubble.getByRole("button", { name: "Got it" }).click();
  await expect(bubble).toHaveCount(0);

  // The learner can answer with the tutorial done.
  await page.getByRole("textbox", { name: "Your thinking" }).fill("One holds A and wants B.");
  await submit.click();
  await expect(page.getByText("What might change if the threads acquired resources in a consistent order?")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a learner can type and press while the tutorial is up", async ({ page }) => {
  await page.goto("/?scenario=review&tutorial=1");
  const bubble = bubbleOf(page);
  await expect(bubble).toContainText("Answer in your own words");
  await page.getByRole("textbox", { name: "Your thinking" }).fill("They wait on each other.");
  await page.getByRole("button", { name: "Share my thinking" }).click();
  await expect(page.getByRole("textbox", { name: "Your thinking" })).toHaveValue("");
});

test("Escape skips this place only, and Skip tutorial skips every place", async ({ page }) => {
  await page.goto("/app/?scenario=first-run&tutorial=1");
  const bubble = bubbleOf(page);
  await expect(bubble).toContainText("Open a YouTube lecture in Chrome");
  await page.keyboard.press("Escape");
  await expect(bubble).toHaveCount(0);

  await page.getByRole("link", { name: "Capture", exact: true }).click();
  await expect(bubble).toContainText("Watched is how much of the lecture you played");
  await bubble.getByRole("button", { name: "Skip tutorial" }).click();
  await expect(bubble).toHaveCount(0);

  await page.getByRole("link", { name: "Review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose a starting point" })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(bubble).toHaveCount(0);
});

test("Escape leaves other things that use it alone", async ({ page }) => {
  await page.goto("/?scenario=review&tutorial=1");
  const bubble = bubbleOf(page);
  await expect(bubble).toContainText("Answer in your own words");
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(bubble).toBeVisible();
});

test("Show the tutorial again, in the review menu and in the room panel, starts the place over", async ({ page }, info) => {
  await page.goto("/?scenario=review&tutorial=1");
  const bubble = bubbleOf(page);
  await expect(bubble).toContainText("Answer in your own words");
  await bubble.getByRole("button", { name: "Skip tutorial" }).click();
  await expect(bubble).toHaveCount(0);

  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await menu.click();
  await page.getByRole("button", { name: "Show the tutorial again" }).click();
  await expect(bubble).toContainText("Answer in your own words");
  await bubble.getByRole("button", { name: "Skip tutorial" }).click();
  await expect(bubble).toHaveCount(0);

  // The room panel's layout is checked in the desktop run.
  if (info.project.name === "narrow") return;
  await page.getByText("Room & companion").click();
  await page.getByRole("button", { name: "Show the tutorial again" }).click();
  await expect(bubble).toContainText("Answer in your own words");
});

test("the notebook's first visit points at Revisit review", async ({ page }) => {
  await page.goto("/app/record?scenario=record&tutorial=1");
  const bubble = bubbleOf(page);
  await expect(bubble).toContainText("Revisit review opens that review again");
  await expect(page.locator(".tutorial-ring")).toHaveCount(1);
  await bubble.getByRole("button", { name: "Got it" }).click();
  await expect(bubble).toHaveCount(0);
});

test("without ?tutorial=1 the preview shows no tutorial and no restart control", async ({ page }) => {
  await page.goto("/app/?scenario=first-run");
  await expect(page.getByRole("heading", { name: "Your lectures" })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(bubbleOf(page)).toHaveCount(0);
  await page.getByText("Room & companion").click();
  await expect(page.getByRole("button", { name: "Show the tutorial again" })).toHaveCount(0);
});

test("the tutorial runs when browser storage throws", async ({ page }) => {
  // `tutorial=local` keeps the seen state in localStorage, as the app does. Here it throws on every call, as a blocked browser does.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const deny = () => { throw new DOMException("denied", "SecurityError"); };
    Object.defineProperty(window, "localStorage", { get: deny });
  });
  await page.goto("/app/?scenario=first-run&tutorial=local");
  await expect(bubbleOf(page)).toContainText("Open a YouTube lecture in Chrome");
  await page.keyboard.press("Escape");
  await expect(bubbleOf(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the notebook inside a review's Saved notes is not a tutorial place", async ({ page }) => {
  await page.goto("/?scenario=review&tutorial=1");
  const bubble = bubbleOf(page);
  await expect(bubble).toContainText("Answer in your own words");
  await page.keyboard.press("Escape");
  await expect(bubble).toHaveCount(0);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Saved notes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Saved notes" })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(bubble).toHaveCount(0);
});

for (const size of [{ width: 390, height: 844 }, { width: 320, height: 844 }]) {
  test(`at ${size.width}x${size.height} no answer control is under the bubble on steps 1 to 3, and Menu is in view on step 4`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/?scenario=review&tutorial=1");
    const bubble = bubbleOf(page);
    await expect(bubble).toContainText("Answer in your own words");
    const controls = [
      page.getByRole("textbox", { name: "Your thinking" }),
      page.getByRole("button", { name: "Share my thinking" }),
      page.getByRole("button", { name: "I don't know", exact: true }),
      page.getByRole("button", { name: "Hint", exact: true }),
      page.getByText("More ways to work through it"),
    ];
    for (let step = 0; step < 4; step++) {
      await page.waitForTimeout(300);
      if (step < 3) for (const control of controls) expect(await overlap(bubble, control)).toBe(false);
      else {
        // The last step points at Menu, so Menu is in view and clear of the bubble. The lower answer controls may sit under it.
        const menu = page.getByRole("button", { name: "Menu", exact: true });
        await expect(menu).toBeInViewport({ ratio: 1 });
        expect(await overlap(bubble, menu)).toBe(false);
        await expect(page.locator(".tutorial-ring")).toHaveCount(1);
      }
      if (step < 3) await bubble.getByRole("button", { name: "Next" }).click();
    }
  });
}
