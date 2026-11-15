import { expect, test } from "@playwright/test";

const POSES = ["draw", "read"];

async function animationNames(page: import("@playwright/test").Page, attrs: string) {
  return page.evaluate(({ poses, attrs }) => poses.map((pose) => {
    const host = document.createElement("div");
    host.innerHTML = `<span class="companion-sprite" data-companion="pip" data-pose="${pose}" ${attrs}><span class="companion-pose"></span></span>`;
    document.body.append(host);
    const name = getComputedStyle(host.querySelector(".companion-pose")!).animationName;
    host.remove();
    return name;
  }), { poses: POSES, attrs });
}

test("the system reduced-motion preference stops the draw and read animations", async ({ browser }) => {
  const motion = await browser.newPage({ reducedMotion: "no-preference" });
  await motion.goto("/?scenario=review&clean=1");
  expect(await animationNames(motion, "")).toEqual(["companion-draw", "companion-read"]);
  await motion.close();
  const reduced = await browser.newPage({ reducedMotion: "reduce" });
  await reduced.goto("/?scenario=review&clean=1");
  expect(await animationNames(reduced, "")).toEqual(["none", "none"]);
  await reduced.close();
});

test("an instant reaction stops the animation without the system preference", async ({ browser }) => {
  const page = await browser.newPage({ reducedMotion: "no-preference" });
  await page.goto("/?scenario=review&clean=1");
  expect(await animationNames(page, "data-instant")).toEqual(["none", "none"]);
  await page.close();
});
