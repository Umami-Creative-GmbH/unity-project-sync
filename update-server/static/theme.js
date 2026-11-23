// Light/dark theme. Loaded synchronously in <head> (the CSP allows no inline scripts), so a saved
// choice is applied before the first paint. Without a saved choice the page follows the system.
//
//   <html data-theme="light|dark">  forces a theme (site.css redefines its tokens for it)
//   [data-scheme="light|dark"]      elements with a `media` that belongs to that scheme (theme-color
//                                    metas, the dark <source> of the screenshots): their media is
//                                    rewritten so they follow a forced theme too
//   [data-theme-toggle]             the header button (wired up and shown by site.js)
(() => {
  const KEY = "ups-theme";
  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

  const stored = () => {
    try {
      const v = window.localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch {
      return null;
    }
  };
  const save = (choice) => {
    try {
      if (choice) window.localStorage.setItem(KEY, choice);
      else window.localStorage.removeItem(KEY);
    } catch {
      /* storage blocked: the choice lasts for this page view */
    }
  };

  let choice = stored();
  const system = () => (systemDark.matches ? "dark" : "light");
  const effective = () => choice ?? system();

  const setMedia = (el) => {
    const scheme = el.dataset.scheme;
    el.setAttribute("media", choice ? (scheme === choice ? "all" : "not all") : `(prefers-color-scheme: ${scheme})`);
  };

  const apply = () => {
    if (choice) root.dataset.theme = choice;
    else delete root.dataset.theme;
    document.querySelectorAll("[data-scheme]").forEach(setMedia);
    const label = effective() === "dark" ? "Switch to light mode" : "Switch to dark mode";
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  };

  window.upsTheme = {
    apply,
    /** Flips light/dark. Choosing what the system uses anyway goes back to following the system. */
    toggle() {
      const next = effective() === "dark" ? "light" : "dark";
      choice = next === system() ? null : next;
      save(choice);
      apply();
    },
  };

  // The screenshot <source>s come later in the page; site.js applies again once they exist. (When
  // a saved choice differs from the system theme, the browser's preload scanner may still fetch
  // the hero image's other variant once; the lazy gallery images load after that.)
  systemDark.addEventListener("change", apply);
  // Another tab changed the theme.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    choice = stored();
    apply();
  });
  apply();
})();
