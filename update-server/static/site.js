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
