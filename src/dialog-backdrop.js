function backdropDialog(event) {
  const dialog = event.target;
  if (dialog?.tagName !== "DIALOG" || !dialog.open) return null;
  const bounds = dialog.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right ||
    event.clientY < bounds.top || event.clientY > bounds.bottom;
  return outside ? dialog : null;
}

export function initDialogBackdropDismissal(root = document) {
  let pressedDialog = null;
  root.addEventListener("pointerdown", event => {
    pressedDialog = event.button === 0 && event.isPrimary !== false ? backdropDialog(event) : null;
  }, true);
  root.addEventListener("pointercancel", () => { pressedDialog = null; }, true);
  root.addEventListener("click", event => {
    const dialog = pressedDialog;
    pressedDialog = null;
    // Both ends of the click must be outside. Text selection can end there too.
    if (!dialog || event.detail === 0 || backdropDialog(event) !== dialog) return;
    // Let the same guards as Escape handle busy dialogs and unsaved changes.
    const request = new CustomEvent("cancel", { cancelable: true, detail: "backdrop" });
    if (dialog.dispatchEvent(request) && dialog.open) dialog.close();
  }, true);
}
