// Renders the page's social and icon images into static/ with headless Chrome or Edge:
//
//   og-image.png             1200x630  Open Graph / Twitter card (from og-image.html)
//   apple-touch-icon.png      180x180  iOS home screen, full-bleed tile (iOS rounds it itself)
//   icon-192.png, icon-512.png         web app manifest, "any" (the tile with transparent corners)
//   icon-maskable-512.png     512x512  web app manifest, "maskable" (artwork inside the safe zone)
//   favicon.ico          16/32/48      for clients that ignore the SVG favicon
//
// Run from update-server/:  node seo/render.mjs
// Set CHROME to the browser executable if it is not found automatically.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, "../static");
const iconSvg = readFileSync(join(staticDir, "app-icon.svg"), "utf8");

function findBrowser() {
  const candidates = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome/Edge found; set CHROME to its executable.");
  return found;
}

const browser = findBrowser();
const work = mkdtempSync(join(tmpdir(), "ups-seo-"));

/** Screenshot of `url` at `width`x`height` px (at least about 500 px wide in headless mode). */
function screenshot(url, width, height, out) {
  execFileSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--allow-file-access-from-files",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      "--virtual-time-budget=3000",
      `--user-data-dir=${join(work, "profile")}`,
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      url,
    ],
    { stdio: "ignore" },
  );
  const png = readFileSync(out);
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (w !== width || h !== height) throw new Error(`${out}: got ${w}x${h}, want ${width}x${height}`);
  return png;
}

/** The icon without its rounded tile: the tile's gradient fills the whole (re-framed) view box. */
function fullBleed(viewBox) {
  const [x, y, w, h] = viewBox.split(" ");
  const fill = (paint) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${paint}"/>`;
  const svg = iconSvg
    .replace(/width="1024" height="1024" viewBox="0 0 1024 1024"/, `viewBox="${viewBox}"`)
    .replace(/<rect [^>]*fill="url\(#bg\)"\/>/, fill("url(#bg)"))
    .replace(/<rect [^>]*fill="url\(#glow\)"\/>/, fill("url(#glow)"))
    .replace(/<rect [^>]*stroke-opacity="0\.08"[^>]*\/>\s*/, "")
    .replace(' clip-path="url(#tile)"', "");
  if (svg.includes("rx=\"208\"") && svg.match(/rx="208"/g).length > 1) {
    throw new Error("app-icon.svg changed; update fullBleed()");
  }
  return svg;
}

/**
 * Rasterises `svg` at `size` px in a canvas (icon.html). Headless windows have a minimum width,
 * and a device scale factor below 1 shifts and crops the output, so no window screenshot here.
 * `fullBleed`: every pixel must be opaque; otherwise the artwork must be centred.
 */
function renderSvg(svg, size, { fullBleed = false } = {}) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const url = `${pathToFileURL(join(here, "icon.html"))}?size=${size}&src=${encodeURIComponent(src)}`;
  const dom = execFileSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--virtual-time-budget=3000",
      `--user-data-dir=${join(work, "profile")}`,
      "--dump-dom",
      url,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
  const json = dom.match(/<pre id="out">(.*?)<\/pre>/s)?.[1];
  if (!json) throw new Error(`icon ${size}: no output from icon.html`);
  const { png, margins, opaque } = JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  const [l, t, r, b] = margins;
  if (fullBleed ? !opaque : Math.abs(l - r) > 1 || Math.abs(t - b) > 1) {
    throw new Error(`icon ${size}: off-centre or not opaque (margins ${margins}, opaque ${opaque})`);
  }
  const bytes = Buffer.from(png.slice(png.indexOf(",") + 1), "base64");
  if (bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) {
    throw new Error(`icon ${size}: wrong PNG size`);
  }
  return bytes;
}

/** An .ico whose entries are PNGs (supported since Windows Vista and by every browser). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.png)]);
}

const out = (name, bytes) => {
  writeFileSync(join(staticDir, name), bytes);
  console.log(`${name.padEnd(24)} ${(bytes.length / 1024).toFixed(1)} KB`);
};

try {
  out(
    "og-image.png",
    screenshot(pathToFileURL(join(here, "og-image.html")).href, 1200, 630, join(work, "og.png")),
  );

  // The tile itself as the square: what the app icon looks like, minus the transparent margin.
  out("apple-touch-icon.png", renderSvg(fullBleed("64 64 896 896"), 180, { fullBleed: true }));

  out("icon-192.png", renderSvg(iconSvg, 192));
  out("icon-512.png", renderSvg(iconSvg, 512));

  // Maskable: everything that matters within the centre circle of 40 % radius. The badge reaches
  // 489 units from the centre, so the view box is 1248 wide (489 / 1248 = 0.39).
  out(
    "icon-maskable-512.png",
    renderSvg(fullBleed("-112 -112 1248 1248"), 512, { fullBleed: true }),
  );

  out("favicon.ico", ico([16, 32, 48].map((size) => ({ size, png: renderSvg(iconSvg, size) }))));
} finally {
  rmSync(work, { recursive: true, force: true });
}
