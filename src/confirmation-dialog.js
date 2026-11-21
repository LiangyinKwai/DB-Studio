import { setSelectableText } from "./selectable-text.js";

// Use the same confirmation UI in desktop WebViews and browser previews.
export function createConfirmationDialog(dialog) {
  let pending = null;
  const finish = (accepted) => {
    const resolve = pending;
    pending = null;
    resolve?.(accepted);
  };
  dialog.addEventListener("close", () => finish(dialog.returnValue === "accept"));
  dialog.addEventListener("cancel", () => {
    dialog.returnValue = "cancel";
  });
  return (message, { title = "确认操作", detail = "", acceptLabel = "确认执行" } = {}) => {
    if (pending) return Promise.resolve(false);
    dialog.querySelector("[data-confirm-title]").textContent = title;
    dialog.querySelector("[data-confirm-message]").textContent = message;
    const preview = dialog.querySelector("[data-confirm-detail]");
    setSelectableText(preview, detail);
    preview.hidden = !detail;
    preview.tabIndex = detail ? 0 : -1;
    preview.setAttribute("aria-label", "待确认操作详情");
    dialog.querySelector("[value='accept']").textContent = acceptLabel;
    dialog.returnValue = "cancel";
    return new Promise((resolve, reject) => {
      pending = resolve;
      try {
        dialog.showModal();
        dialog.querySelector("[value='cancel']").focus();
        // WebKit preserves the scroll offset of hidden content, so reset only
        // after the modal has re-entered layout and focus has been placed.
        preview.scrollTop = 0;
        preview.scrollLeft = 0;
      } catch (error) {
        pending = null;
        reject(error);
      }
    });
  };
}
