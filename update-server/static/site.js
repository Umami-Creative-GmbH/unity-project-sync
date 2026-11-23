// Progressive enhancement: a lightbox for the screenshots. Without JavaScript (or without
// <dialog>) the links simply open the full-size image.
(() => {
  const links = document.querySelectorAll("a[data-lightbox]");
  if (links.length === 0 || typeof HTMLDialogElement !== "function") return;
  const dialog = document.createElement("dialog");
  dialog.className = "lightbox";
  dialog.setAttribute("aria-label", "Screenshot");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-outline btn-icon lightbox-close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>';
  const image = document.createElement("img");
  dialog.append(close, image);
  document.body.append(dialog);
  // Any click closes it (image, backdrop or button); Escape is handled by <dialog>.
  dialog.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => image.removeAttribute("src"));
  for (const link of links) {
    link.addEventListener("click", (event) => {
      // Keep Ctrl/Shift/middle clicks: they open the image in a new tab or window.
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const thumb = link.querySelector("img");
      if (!thumb) return;
      event.preventDefault();
      // currentSrc is the light or dark variant the page is showing.
      image.src = thumb.currentSrc || thumb.src;
      image.alt = thumb.alt;
      image.width = thumb.naturalWidth || 980;
      image.height = thumb.naturalHeight || 760;
      dialog.showModal();
    });
  }
})();

// Progressive enhancement: the copy button for the SHA-256 checksum.
// Without JavaScript (or without the async clipboard API) the button stays hidden and the
// checksum can still be selected by hand.
(() => {
  const status = document.getElementById("copy-status");
  for (const button of document.querySelectorAll("[data-copy]")) {
    const target = document.getElementById(button.dataset.copy);
    if (!target || !navigator.clipboard || !window.isSecureContext) continue;
    button.hidden = false;
    let timer;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(target.textContent.trim());
        button.dataset.copied = "true";
        button.setAttribute("aria-label", "Checksum copied");
        if (status) status.textContent = "Checksum copied to the clipboard.";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        if (status) status.textContent = "Checksum selected. Press Ctrl+C to copy.";
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        delete button.dataset.copied;
        button.setAttribute("aria-label", "Copy SHA-256 checksum");
        if (status) status.textContent = "";
      }, 2000);
    });
  }
})();
