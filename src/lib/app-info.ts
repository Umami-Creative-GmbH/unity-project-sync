export const APP_NAME = "Unity Project Sync";
export const APP_AUTHOR = "Umami Creative GmbH";
export const APP_TAGLINE = "Mirror the non-regenerable parts of Unity projects";
export const SOURCE_URL = "https://github.com/Umami-Creative-GmbH/unity-project-sync";
export const COPYRIGHT = "© 2026 Umami Creative GmbH";

/** The rendering engine from a user agent: "WebView2 131.0.2903.70", "WebKit 605.1.15", or null. */
export function webViewVersion(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const edge = /\bEdg\/([\d.]+)/.exec(userAgent);
  if (edge) return `WebView2 ${edge[1]}`;
  const webkit = /\bAppleWebKit\/([\d.]+)/.exec(userAgent);
  if (webkit && !/\bChrome\//.test(userAgent)) return `WebKit ${webkit[1]}`;
  const chrome = /\bChrome\/([\d.]+)/.exec(userAgent);
  if (chrome) return `Chromium ${chrome[1]}`;
  return null;
}

/**
 * The full WebView2 version from `navigator.userAgentData.getHighEntropyValues(["fullVersionList"])`
 * (the user agent string only carries "157.0.0.0" since Chromium's UA reduction), or null.
 */
export function webViewFromBrands(brands: readonly { brand: string; version: string }[] | undefined): string | null {
  const find = (re: RegExp) => brands?.find((b) => re.test(b.brand) && /^\d+(\.\d+)*$/.test(b.version));
  const webView2 = find(/WebView2/i) ?? find(/^Microsoft Edge$/i);
  if (webView2) return `WebView2 ${webView2.version}`;
  const chromium = find(/^Chromium$/i);
  return chromium ? `Chromium ${chromium.version}` : null;
}
