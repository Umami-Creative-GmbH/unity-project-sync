import { describe, expect, it, vi } from "vitest";

import { webViewFromBrands, webViewVersion } from "@/lib/app-info";
import { createThemeController, readThemeHint, resolveTheme, THEME_HINT_KEY, writeThemeHint, type HintStorage } from "@/lib/theme";

describe("resolveTheme", () => {
  it("uses an explicit choice regardless of the OS", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  it("follows the OS for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

class MemoryStorage implements HintStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe("theme hint", () => {
  it("round-trips and falls back to system", () => {
    const s = new MemoryStorage();
    expect(readThemeHint(s)).toBe("system");
    writeThemeHint(s, "dark");
    expect(s.getItem(THEME_HINT_KEY)).toBe("dark");
    expect(readThemeHint(s)).toBe("dark");
    s.setItem(THEME_HINT_KEY, "purple");
    expect(readThemeHint(s)).toBe("system");
    expect(readThemeHint(null)).toBe("system");
  });

  it("survives a throwing storage", () => {
    const broken: HintStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readThemeHint(broken)).toBe("system");
    expect(() => writeThemeHint(broken, "light")).not.toThrow();
  });
});

function fakeEnv(systemDark: boolean) {
  const classes = new Set<string>();
  const listeners = new Set<() => void>();
  const query = {
    matches: systemDark,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  const env = {
    root: {
      classList: {
        toggle: (token: string, force?: boolean) => {
          if (force ?? !classes.has(token)) classes.add(token);
          else classes.delete(token);
          return classes.has(token);
        },
      },
    },
    darkQuery: query as unknown as MediaQueryList,
    storage: new MemoryStorage(),
    setNativeTheme: vi.fn(async (_: "light" | "dark" | null) => {}),
  };
  const setSystemDark = (dark: boolean) => {
    query.matches = dark;
    listeners.forEach((l) => l());
  };
  return { env, classes, listeners, setSystemDark };
}

describe("createThemeController", () => {
  it("system follows the OS live", () => {
    const { env, classes, setSystemDark } = fakeEnv(false);
    const theme = createThemeController(env, "system");
    expect(classes.has("dark")).toBe(false);
    setSystemDark(true);
    expect(classes.has("dark")).toBe(true);
    expect(theme.resolved).toBe("dark");
    setSystemDark(false);
    expect(classes.has("dark")).toBe(false);
    expect(env.setNativeTheme).not.toHaveBeenCalled();
  });

  it("an explicit theme ignores OS changes; switching back to system follows it again", () => {
    const { env, classes, setSystemDark } = fakeEnv(false);
    const theme = createThemeController(env, "system");
    theme.set("dark");
    expect(classes.has("dark")).toBe(true);
    expect(env.storage.getItem(THEME_HINT_KEY)).toBe("dark");
    expect(env.setNativeTheme).toHaveBeenLastCalledWith("dark");
    setSystemDark(false);
    expect(classes.has("dark")).toBe(true);

    theme.set("light");
    setSystemDark(true);
    expect(classes.has("dark")).toBe(false);

    theme.set("system");
    expect(classes.has("dark")).toBe(true); // the OS is dark now
    expect(env.setNativeTheme).toHaveBeenLastCalledWith(null);
    expect(env.storage.getItem(THEME_HINT_KEY)).toBe("system");
  });

  it("applies an explicit initial theme to the window too", () => {
    const { env, classes } = fakeEnv(true);
    createThemeController(env, "light");
    expect(classes.has("dark")).toBe(false);
    expect(env.setNativeTheme).toHaveBeenCalledWith("light");
  });

  it("dispose stops following the OS", () => {
    const { env, listeners } = fakeEnv(false);
    const theme = createThemeController(env, "system");
    expect(listeners.size).toBe(1);
    theme.dispose();
    expect(listeners.size).toBe(0);
  });

  it("a failing native theme call is ignored", () => {
    const { env, classes } = fakeEnv(false);
    env.setNativeTheme = vi.fn(() => Promise.reject(new Error("not in Tauri")));
    const theme = createThemeController(env, "system");
    expect(() => theme.set("dark")).not.toThrow();
    expect(classes.has("dark")).toBe(true);
  });
});

describe("webViewVersion", () => {
  it("detects WebView2, WebKit and Chromium", () => {
    expect(
      webViewVersion(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
      ),
    ).toBe("WebView2 131.0.2903.70");
    expect(webViewVersion("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("WebKit 605.1.15");
    expect(webViewVersion("Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.1 Safari/537.36")).toBe("Chromium 120.0.1");
    expect(webViewVersion("")).toBeNull();
    expect(webViewVersion(undefined)).toBeNull();
  });

  it("prefers the full WebView2 version from the client hints", () => {
    expect(
      webViewFromBrands([
        { brand: "Chromium", version: "157.0.8103.80" },
        { brand: "Microsoft Edge WebView2", version: "157.0.4341.60" },
        { brand: "Not-A.Brand", version: "99.0.0.0" },
        { brand: "Microsoft Edge", version: "157.0.4341.60" },
      ]),
    ).toBe("WebView2 157.0.4341.60");
    expect(webViewFromBrands([{ brand: "Microsoft Edge", version: "131.0.2903.70" }])).toBe("WebView2 131.0.2903.70");
    expect(webViewFromBrands([{ brand: "Chromium", version: "120.0.6099.5" }])).toBe("Chromium 120.0.6099.5");
    expect(webViewFromBrands([{ brand: "Not-A.Brand", version: "99" }])).toBeNull();
    expect(webViewFromBrands(undefined)).toBeNull();
  });
});
