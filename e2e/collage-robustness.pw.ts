import { test, expect, type Page } from "@playwright/test";

async function importImages(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Collage", exact: true }).click();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(
      ["#759faa", "#8ea386"].map((color, index) => ({
        name: `Image ${index + 1}.svg`,
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="${color}"/></svg>`,
        ),
      })),
    );
  await expect(page.locator(".collage-tile")).toHaveCount(2);
}

test("preview preserves square, portrait, and extreme canvas ratios at every viewport", async ({
  page,
}) => {
  await importImages(page);
  for (const width of [390, 768, 1180]) {
    await page.setViewportSize({ width, height: 844 });
    for (const shape of ["Square · 1:1", "Portrait · 3:4", "Wide · 16:9"]) {
      await page
        .getByRole("combobox", { name: "Shape", exact: true })
        .selectOption({ label: shape });
      await expect
        .poll(async () => {
          const box = await page.locator(".collage-sheet").boundingBox();
          const canvasWidth = Number(
            await page.getByLabel("Canvas width").inputValue(),
          );
          const canvasHeight = Number(
            await page.getByLabel("Canvas height").inputValue(),
          );
          return Math.abs(
            box!.width / box!.height - canvasWidth / canvasHeight,
          );
        })
        .toBeLessThan(0.01);
      if (width <= 750) {
        const workspace = (await page
          .locator(".collage-workspace")
          .boundingBox())!;
        const inspector = (await page
          .locator(".collage-inspector")
          .boundingBox())!;
        expect(workspace.height).toBeGreaterThan(300);
        expect(workspace.y + workspace.height).toBeLessThanOrEqual(
          inspector.y + 1,
        );
      }
    }
    await page.getByLabel("Canvas width").fill("800");
    await page.getByLabel("Canvas width").press("Tab");
    await page.getByLabel("Canvas height").fill("6000");
    await page.getByLabel("Canvas height").press("Tab");
    await expect
      .poll(async () => {
        const box = await page.locator(".collage-sheet").boundingBox();
        return Math.abs(box!.width / box!.height - 800 / 6000);
      })
      .toBeLessThan(0.01);
  }
});

test("context removal Undo restores the image and expires after another edit", async ({
  page,
}) => {
  await importImages(page);
  await page
    .getByRole("button", { name: "Select Image 2.svg", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove image" }).click();
  await expect(page.locator(".collage-tile")).toHaveCount(1);
  const removal = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Image removed from collage" });
  await removal.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".collage-tile")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Select Image 2.svg", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Remove image", exact: true }).click();
  await page.getByRole("slider", { name: "Zoom", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(removal).toHaveCount(0);
  await expect(page.locator(".collage-tile")).toHaveCount(1);
});

test("undo cancels an active crop so subsequent pointer movement cannot overwrite it", async ({
  page,
}) => {
  await importImages(page);
  await page.getByRole("button", { name: "Drag to crop", exact: true }).click();
  await page.getByRole("slider", { name: "Zoom", exact: true }).press("End");
  const box = (await page.locator(".collage-tile").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 30,
    box.y + box.height / 2 + 30,
  );
  await page.keyboard.press("ControlOrMeta+z");
  const position = await page
    .getByRole("slider", { name: "Horizontal position" })
    .inputValue();
  await page.mouse.move(
    box.x + box.width / 2 + 70,
    box.y + box.height / 2 + 70,
  );
  await page.mouse.up();
  await expect(
    page.getByRole("slider", { name: "Horizontal position" }),
  ).toHaveValue(position);
  await expect(
    page.getByRole("slider", { name: "Zoom", exact: true }),
  ).toHaveValue("1");
});

test("workspace URLs and browser history preserve the collage document", async ({
  page,
}) => {
  await importImages(page);
  await expect(page).toHaveURL(/#\/collage$/);
  await page.getByRole("button", { name: "Sort", exact: true }).click();
  await page.goBack();
  await expect(page.locator(".collage-tile")).toHaveCount(2);
  await expect(
    page.getByRole("heading", { name: "Collage studio" }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Organize your images" }),
  ).toBeVisible();
});

test("losing window focus cancels crop and divider gestures", async ({
  page,
}) => {
  await importImages(page);
  await page.getByRole("button", { name: "Drag to crop", exact: true }).click();
  await page.getByRole("slider", { name: "Zoom", exact: true }).press("End");
  const tile = (await page.locator(".collage-tile").first().boundingBox())!;
  const position = await page
    .getByRole("slider", { name: "Horizontal position" })
    .inputValue();
  await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
  await page.mouse.down();
  await page.mouse.move(tile.x + tile.width / 2 + 30, tile.y + tile.height / 2);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect(
    page.getByRole("slider", { name: "Horizontal position" }),
  ).toHaveValue(position);
  const divider = page.getByRole("separator").first();
  const ratio = await divider.getAttribute("aria-valuenow");
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 30,
    box.y + box.height / 2 + 30,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", ratio!);
});

test("import progress counts rejected files without exceeding its total", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Collage", exact: true }).click();
  await page.locator("input[type=file]").first().waitFor({ state: "attached" });
  await page.evaluate(() => {
    const state = window as Window & {
      importProgress?: { completed: number; total: number }[];
    };
    state.importProgress = [];
    new MutationObserver(() => {
      const progress = document.querySelector<HTMLProgressElement>(
        ".collage-operation progress",
      );
      if (progress)
        state.importProgress!.push({
          completed: progress.value,
          total: progress.max,
        });
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles([
      ...Array.from({ length: 30 }, (_, index) => ({
        name: `Broken ${index}.png`,
        mimeType: "image/png",
        buffer: Buffer.from("Not an image"),
      })),
      {
        name: "Valid.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="pink"/></svg>',
        ),
      },
    ]);
  await expect(page.locator(".collage-tile")).toHaveCount(1);
  await expect(
    page.getByText("30 import notices", { exact: true }),
  ).toBeVisible();
  const progress = await page.evaluate(
    () =>
      (
        window as Window & {
          importProgress: { completed: number; total: number }[];
        }
      ).importProgress,
  );
  expect(progress.length).toBeGreaterThan(0);
  expect(
    progress.every(
      ({ completed, total }) => total === 31 && completed <= total,
    ),
  ).toBe(true);
  expect(progress.some(({ completed }) => completed >= 25)).toBe(true);
});

test("native listeners are released after a sibling subscription rejects", async ({
  page,
}) => {
  // Exercise native event setup through the API boundary without a desktop process.
  await page.addInitScript(() => {
    let nextId = 0;
    const active = new Map<number, string>();
    Object.assign(window, {
      isTauri: true,
      nativeListeners: active,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: () => ++nextId,
        invoke: async (
          command: string,
          args?: { event?: string; eventId?: number },
        ) => {
          if (command === "plugin:event|listen") {
            if (args?.event === "native-source-drop")
              throw new Error("Injected subscription failure");
            const id = ++nextId;
            active.set(id, args!.event!);
            return id;
          }
          if (command === "plugin:event|unlisten")
            active.delete(args!.eventId!);
          return null;
        },
      },
    });
  });
  const activeDragListeners = () =>
    page.evaluate(
      () =>
        [
          ...(
            window as Window & { nativeListeners: Map<number, string> }
          ).nativeListeners.values(),
        ].filter((event) => event.startsWith("tauri://drag-")).length,
    );
  await page.goto("/");
  await expect.poll(activeDragListeners).toBe(4);
  for (let round = 0; round < 3; round++) {
    await page.getByRole("button", { name: "Collage", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Collage studio" }),
    ).toBeVisible();
    await expect.poll(activeDragListeners).toBe(8);
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    await expect.poll(activeDragListeners).toBe(4);
  }
});
