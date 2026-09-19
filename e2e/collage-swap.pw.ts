import { test, expect, type Locator, type Page } from "@playwright/test";

async function center(tile: Locator) {
  const box = await tile.boundingBox();
  if (!box) throw new Error("Tile is not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function moveTo(page: Page, tile: Locator) {
  const point = await center(tile);
  await page.mouse.move(point.x, point.y, { steps: 8 });
}
async function startSwap(page: Page) {
  const source = page.locator(".collage-tile").nth(0);
  await moveTo(page, source);
  await page.mouse.down();
  await moveTo(page, page.locator(".collage-tile").nth(1));
  await expect(source).toHaveClass(/is-swap-source/);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Collage", exact: true }).click();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(
      [
        ["Coast", "#759faa"],
        ["Garden", "#8ea386"],
        ["Dusk", "#ac92b2"],
      ].map(([name, color]) => ({
        name: `${name}.svg`,
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="${color}"/><circle cx="650" cy="200" r="100" fill="#fae6bc"/></svg>`,
        ),
      })),
    );
  await expect(page.locator(".collage-tile")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "Export collage", exact: true }),
  ).toBeEnabled();
});

test("indicates the dragged image and only the current swap target", async ({
  page,
}, testInfo) => {
  const source = page.locator(".collage-tile").nth(0);
  const target = page.locator(".collage-tile").nth(1);
  const third = page.locator(".collage-tile").nth(2);
  await source.click();
  await expect(page.locator(".swap-indicator")).toHaveCount(0);
  await moveTo(page, source);
  await page.mouse.down();
  const point = await center(source);
  await page.mouse.move(point.x + 1, point.y + 1);
  await expect(page.locator(".swap-indicator")).toHaveCount(0);
  await moveTo(page, target);
  await expect(source).toHaveClass(/is-swap-source/);
  await expect(source.locator("img")).toHaveCSS("opacity", "0.65");
  await expect(target).toHaveClass(/is-swap-target/);
  await expect(target.locator(".swap-indicator")).toHaveText("Swap here");
  await page.screenshot({ path: testInfo.outputPath("swap-indicators.png") });
  await moveTo(page, third);
  await expect(target).not.toHaveClass(/is-swap-target/);
  await expect(third).toHaveClass(/is-swap-target/);
  const stage = await page.locator(".collage-stage").boundingBox();
  await page.mouse.move(stage!.x + 5, stage!.y + 5);
  await expect(page.locator(".is-swap-target")).toHaveCount(0);
  await expect(source).toHaveClass(/is-swap-source/);
  await moveTo(page, source);
  await expect(page.locator(".is-swap-target")).toHaveCount(0);
  await moveTo(page, target);
  await page.mouse.up();
  await expect(page.locator(".swap-indicator")).toHaveCount(0);
  await expect(page.locator(".is-swap-source,.is-swap-target")).toHaveCount(0);
  await expect(source.locator("img")).toHaveAttribute("alt", "Garden.svg");
  await expect(target.locator("img")).toHaveAttribute("alt", "Coast.svg");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(source.locator("img")).toHaveAttribute("alt", "Coast.svg");
});

test("clears feedback without swapping on Escape or lost pointer capture", async ({
  page,
}) => {
  const source = page.locator(".collage-tile").nth(0);
  await startSwap(page);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".swap-indicator")).toHaveCount(0);
  await expect(source.locator("img")).toHaveAttribute("alt", "Coast.svg");
  await source.evaluate((el) =>
    el.addEventListener(
      "pointerdown",
      (event) => {
        el.setAttribute(
          "data-test-pointer",
          String((event as PointerEvent).pointerId),
        );
      },
      { once: true },
    ),
  );
  await startSwap(page);
  await source.evaluate((el) =>
    el.releasePointerCapture(Number(el.getAttribute("data-test-pointer"))),
  );
  await page.mouse.up();
  await expect(page.locator(".swap-indicator")).toHaveCount(0);
  await expect(source.locator("img")).toHaveAttribute("alt", "Coast.svg");
});

test("outside drops and cancelled pointers clear feedback without a swap", async ({
  page,
}) => {
  const source = page.locator(".collage-tile").nth(0);
  await startSwap(page);
  await page.mouse.move(200, 100);
  await page.mouse.up();
  await expect(page.locator(".swap-indicator")).toHaveCount(0);
  await expect(source.locator("img")).toHaveAttribute("alt", "Coast.svg");
  await source.evaluate((el) =>
    el.addEventListener(
      "pointerdown",
      (event) => {
        el.setAttribute(
          "data-test-pointer",
          String((event as PointerEvent).pointerId),
        );
      },
      { once: true },
    ),
  );
  await startSwap(page);
  const pointerId = Number(await source.getAttribute("data-test-pointer"));
  await source.dispatchEvent("pointercancel", { pointerId });
  await page.mouse.up();
  await expect(page.locator(".swap-indicator")).toHaveCount(0);
  await expect(source.locator("img")).toHaveAttribute("alt", "Coast.svg");
});

test("crop dragging does not display swap indicators", async ({ page }) => {
  await page.getByRole("button", { name: "Drag to crop", exact: true }).click();
  const source = page.locator(".collage-tile").nth(0);
  await moveTo(page, source);
  await page.mouse.down();
  await moveTo(page, page.locator(".collage-tile").nth(1));
  await expect(page.locator(".swap-indicator")).toHaveCount(0);
  await page.mouse.up();
  await expect(source.locator("img")).toHaveAttribute("alt", "Coast.svg");
});
