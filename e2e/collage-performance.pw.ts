import { test, expect } from "@playwright/test";

test("reuses native PNGs and small JPEGs, bounds large imports, and preserves export pixels", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/lib/collage.ts";
    const { normalizeImage, renderCollage } = await import(
      /* @vite-ignore */ modulePath
    );
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgba(255, 0, 0, 0.5)";
    context.fillRect(0, 0, 64, 40);
    const blob = (format = "image/png") =>
      new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), format),
      );
    const png = await blob();
    context.fillStyle = "blue";
    context.fillRect(0, 0, 64, 40);
    const jpeg = await blob("image/jpeg");
    const original = HTMLCanvasElement.prototype.toBlob;
    let conversions = 0;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      conversions++;
      return original.apply(this, args);
    };
    const native = await normalizeImage(png, "native.png", {
      width: 64,
      height: 40,
    });
    const photo = await normalizeImage(jpeg, "photo.jpg");
    const importConversions = conversions;
    const bytesEqual = async (url: string, expected: Blob) => {
      const a = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const b = new Uint8Array(await expected.arrayBuffer());
      return (
        a.length === b.length && a.every((value, index) => value === b[index])
      );
    };
    const nativeUnchanged = await bytesEqual(native.url, png);
    const jpegUnchanged = await bytesEqual(photo.url, jpeg);
    const layout = {
      axis: "x",
      ratio: 0.5,
      first: { slot: 0 },
      second: { slot: 1 },
    };
    const pixels: number[][] = [];
    for (const format of ["png", "jpeg"]) {
      const exported = await renderCollage(
        [native, photo],
        layout,
        128,
        64,
        4,
        "#ffffff",
        format,
      );
      const url = URL.createObjectURL(exported);
      const image = new Image();
      image.src = url;
      await image.decode();
      canvas.width = 128;
      canvas.height = 64;
      context.drawImage(image, 0, 0);
      for (const [x, y] of [
        [0, 0],
        [32, 32],
        [96, 32],
      ])
        pixels.push([...context.getImageData(x, y, 1, 1).data]);
      URL.revokeObjectURL(url);
    }
    canvas.width = 3000;
    canvas.height = 1500;
    const large = await normalizeImage(await blob("image/jpeg"), "large.jpg");
    let rejectsInvalid = false;
    try {
      await normalizeImage(png, "bad.png", { width: 2401, height: 1 });
    } catch {
      rejectsInvalid = true;
    }
    for (const image of [native, photo, large]) URL.revokeObjectURL(image.url);
    HTMLCanvasElement.prototype.toBlob = original;
    return {
      importConversions,
      nativeUnchanged,
      jpegUnchanged,
      pixels,
      large: [large.width, large.height],
      rejectsInvalid,
    };
  });
  expect(result.importConversions).toBe(0);
  expect(result.nativeUnchanged).toBe(true);
  expect(result.jpegUnchanged).toBe(true);
  expect(result.large).toEqual([2400, 1200]);
  expect(result.rejectsInvalid).toBe(true);
  for (let index = 0; index < result.pixels.length; index++) {
    const expected = [
      [255, 255, 255, 255],
      [255, 127, 127, 255],
      [0, 0, 254, 255],
    ][index % 3];
    result.pixels[index].forEach((channel, i) =>
      expect(Math.abs(channel - expected[i])).toBeLessThanOrEqual(3),
    );
  }
});

test("imports a collection and exports a collage through the editor", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Collage", exact: true }).click();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(
      ["#759faa", "#8ea386", "#ac92b2", "#ca9a77", "#7584aa", "#a3ad83"].map(
        (color, i) => ({
          name: `Landscape ${i + 1}.svg`,
          mimeType: "image/svg+xml",
          buffer: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="${color}"/><circle cx="650" cy="180" r="85" fill="#fae6bc"/><path d="M0 600V470L260 190L590 600ZM300 600L620 310L900 530V600Z" fill="#385460" opacity=".5"/></svg>`,
          ),
        }),
      ),
    );
  await expect(page.locator(".collage-tile")).toHaveCount(6);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export collage", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("collage.png");
  await expect(
    page.getByRole("button", { name: "Export collage", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("collage-performance.png"),
  });
});

test("native clipboard imports export binary PNG and JPEG payloads", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Collage", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Paste image", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#759faa";
    context.fillRect(0, 0, 64, 40);
    const data = canvas.toDataURL().split(",")[1];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, payload: unknown) => {
          if (command === "collage_clipboard")
            return {
              images: [
                { name: "Clipboard image.png", data, width: 64, height: 40 },
              ],
              warnings: [],
            };
          if (command === "collage_save") {
            if (!(payload instanceof ArrayBuffer))
              throw new Error("Export must use a binary payload");
            const bytes = new Uint8Array(payload);
            document.body.dataset.exportSignature = [...bytes.slice(0, 3)].join(
              ",",
            );
            return true;
          }
          throw new Error(`Unexpected native command: ${command}`);
        },
      },
    });
  });
  await page.getByRole("button", { name: "Paste image", exact: true }).click();
  await expect(page.locator(".collage-tile")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Export collage", exact: true })
    .click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-export-signature",
    "137,80,78",
  );
  await page.getByLabel("Export format").selectOption("jpeg");
  await page
    .getByRole("button", { name: "Export collage", exact: true })
    .click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-export-signature",
    "255,216,255",
  );
});
