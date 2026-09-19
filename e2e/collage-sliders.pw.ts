import { test, expect, type Locator, type Page } from "@playwright/test";

async function sliderPoint(slider: Locator, fraction: number) {
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  if (!box) throw new Error("Slider is not visible");
  return {
    x: box.x + 8 + (box.width - 16) * fraction,
    y: box.y + box.height / 2,
  };
}
async function dragSlider(page: Page, slider: Locator, fraction: number) {
  const value = Number(await slider.inputValue());
  const min = Number(await slider.getAttribute("min"));
  const max = Number(await slider.getAttribute("max"));
  const start = await sliderPoint(slider, (value - min) / (max - min));
  const end = await sliderPoint(slider, fraction);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 20 });
  // The thumb must track the pointer while held, not jump or stay stuck.
  await expect
    .poll(async () => Number(await slider.inputValue()))
    .toBeGreaterThan(min + (max - min) * (fraction - 0.05));
  // Release outside the input, then move back across it with no button held.
  await page.mouse.move(end.x, end.y - 40, { steps: 3 });
  await page.mouse.up();
  const released = await slider.inputValue();
  await page.mouse.move(start.x, start.y, { steps: 20 });
  await expect(slider).toHaveValue(released);
  return value;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Collage", exact: true }).click();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "slider-sample.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#759faa"/><circle cx="650" cy="200" r="100" fill="#fae6bc"/></svg>',
      ),
    });
  await expect(page.locator(".collage-tile")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Export collage", exact: true }),
  ).toBeEnabled();
});

test("slider drags stop on release and create one undo step", async ({
  page,
}) => {
  for (const name of [
    "Margins",
    "Zoom",
    "Horizontal position",
    "Vertical position",
  ]) {
    const slider = page.getByRole("slider", { name, exact: true });
    const previous = await dragSlider(page, slider, 0.8);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(slider).toHaveValue(String(previous));
    await expect(page.locator(".collage-tile")).toHaveCount(1);
  }
});

test("a track click does not attach the thumb to subsequent mouse movement", async ({
  page,
}, testInfo) => {
  const slider = page.getByRole("slider", { name: "Margins", exact: true });
  const before = await slider.inputValue();
  const point = await sliderPoint(slider, 0.9);
  await page.mouse.click(point.x, point.y);
  const clicked = await slider.inputValue();
  expect(clicked).not.toBe(before);
  const other = await sliderPoint(slider, 0.1);
  await page.mouse.move(other.x, other.y, { steps: 20 });
  await expect(slider).toHaveValue(clicked);
  await page.screenshot({ path: testInfo.outputPath("margins-slider.png") });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(slider).toHaveValue(before);
  await slider.focus();
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue(String(Number(before) + 1));
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(slider).toHaveValue(before);
});
