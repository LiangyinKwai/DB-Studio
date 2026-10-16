const DEFAULT_LAYOUT = Object.freeze({
  connectionsWidth: 228,
  objectsWidth: 260,
  editorSize: 40,
  connectionsCollapsed: false,
  objectsCollapsed: false,
});

const LIMITS = Object.freeze({
  connectionsMin: 160,
  connectionsMax: 360,
  objectsMin: 190,
  objectsMax: 460,
  mainMin: 400,
  editorMin: 100,
  resultsMin: 180,
  columnSeparator: 5,
  restoreRail: 32,
  rowSeparator: 7,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const numberOr = (value, fallback) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function normalizeLayout(value = {}) {
  if (!value || typeof value !== "object") value = {};
  return {
    connectionsWidth: clamp(
      numberOr(value.connectionsWidth, DEFAULT_LAYOUT.connectionsWidth),
      LIMITS.connectionsMin,
      LIMITS.connectionsMax,
    ),
    objectsWidth: clamp(
      numberOr(value.objectsWidth, DEFAULT_LAYOUT.objectsWidth),
      LIMITS.objectsMin,
      LIMITS.objectsMax,
    ),
    editorSize: clamp(
      numberOr(value.editorSize, DEFAULT_LAYOUT.editorSize),
      0,
      100,
    ),
    connectionsCollapsed: value.connectionsCollapsed === true,
    objectsCollapsed: value.objectsCollapsed === true,
  };
}

/** Fit preferred pane sizes to the current window without discarding saved preferences. */
export function calculateWorkspaceLayout(preferences, width, height) {
  const layout = normalizeLayout(preferences);
  width = Math.max(0, numberOr(width, 0));
  height = Math.max(
    LIMITS.editorMin + LIMITS.resultsMin + LIMITS.rowSeparator,
    numberOr(height, 0),
  );
  let connectionsVisible = !layout.connectionsCollapsed;
  let objectsVisible = !layout.objectsCollapsed;
  const minimum = () =>
    LIMITS.mainMin +
    (connectionsVisible ? LIMITS.connectionsMin + LIMITS.columnSeparator : LIMITS.restoreRail) +
    (objectsVisible ? LIMITS.objectsMin + LIMITS.columnSeparator : LIMITS.restoreRail);
  if (width < minimum() && connectionsVisible && objectsVisible)
    connectionsVisible = false;
  if (width < minimum() && connectionsVisible) connectionsVisible = false;
  if (width < minimum() && objectsVisible) objectsVisible = false;

  let connectionsWidth = connectionsVisible ? layout.connectionsWidth : 0;
  let objectsWidth = objectsVisible ? layout.objectsWidth : 0;
  const separators =
    (Number(connectionsVisible) + Number(objectsVisible)) *
    LIMITS.columnSeparator;
  const connectionsRailWidth = connectionsVisible ? 0 : LIMITS.restoreRail;
  const objectsRailWidth = objectsVisible ? 0 : LIMITS.restoreRail;
  const railSpace = connectionsRailWidth + objectsRailWidth;
  const available = Math.max(0, width - LIMITS.mainMin - separators - railSpace);
  const overflow = Math.max(0, connectionsWidth + objectsWidth - available);
  if (overflow > 0) {
    const connectionsSlack = connectionsVisible
      ? connectionsWidth - LIMITS.connectionsMin
      : 0;
    const objectsSlack = objectsVisible ? objectsWidth - LIMITS.objectsMin : 0;
    const slack = connectionsSlack + objectsSlack;
    connectionsWidth -= slack ? (overflow * connectionsSlack) / slack : 0;
    objectsWidth -= slack ? (overflow * objectsSlack) / slack : 0;
  }
  // Round one track down so rounding can never take space away from the main pane.
  connectionsWidth = Math.floor(connectionsWidth);
  objectsWidth = Math.floor(objectsWidth);
  const editorMax = height - LIMITS.resultsMin - LIMITS.rowSeparator;
  const editorHeight = Math.round(
    clamp(
      ((height - LIMITS.rowSeparator) * layout.editorSize) / 100,
      LIMITS.editorMin,
      editorMax,
    ),
  );
  return {
    connectionsVisible,
    objectsVisible,
    connectionsWidth,
    objectsWidth,
    connectionsRailWidth,
    objectsRailWidth,
    connectionsMax: Math.max(
      LIMITS.connectionsMin,
      Math.min(
        LIMITS.connectionsMax,
        width - LIMITS.mainMin - separators - railSpace - objectsWidth,
      ),
    ),
    objectsMax: Math.max(
      LIMITS.objectsMin,
      Math.min(
        LIMITS.objectsMax,
        width - LIMITS.mainMin - separators - railSpace - connectionsWidth,
      ),
    ),
    editorHeight,
    editorMax,
    editorAvailable: height - LIMITS.rowSeparator,
    resultsHeight: height - LIMITS.rowSeparator - editorHeight,
    mainWidth: width - separators - railSpace - connectionsWidth - objectsWidth,
  };
}

/** Resizable desktop panes. Pointer moves only schedule one render per animation frame. */
export function initWorkspaceLayout({
  storageKey = "db-studio.layout.v1",
} = {}) {
  const ids = [
    "workspaceBody",
    "editorResult",
    "connectionsPane",
    "objectsPane",
    "connectionsRail",
    "objectsRail",
    "editorPane",
    "connectionsSplitter",
    "objectsSplitter",
    "editorSplitter",
    "toggleConnections",
    "toggleObjects",
    "resetLayout",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [id, document.getElementById(id)]),
  );
  if (Object.values(elements).some((element) => !element))
    return { destroy() {} };
  let preferences;
  try {
    preferences = normalizeLayout(JSON.parse(localStorage.getItem(storageKey)));
  } catch {
    preferences = normalizeLayout();
  }
  let applied;
  let frame = 0;
  let drag = null;
  let destroyed = false;
  const cleanup = [];
  const rootStyle = document.documentElement.style;
  const sizes = () => [
    elements.workspaceBody.clientWidth,
    elements.editorResult.clientHeight,
  ];
  const listen = (element, event, handler, options) => {
    element.addEventListener(event, handler, options);
    cleanup.push(() => element.removeEventListener(event, handler, options));
  };
  const persist = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {
      /* Layout still works when storage is unavailable. */
    }
  };
  const setSeparator = (element, min, max, now, visible = true) => {
    element.setAttribute("aria-valuemin", String(Math.round(min)));
    element.setAttribute("aria-valuemax", String(Math.round(max)));
    element.setAttribute("aria-valuenow", String(Math.round(now)));
    element.setAttribute("aria-valuetext", `${Math.round(now)} 像素`);
    element.tabIndex = visible ? 0 : -1;
  };
  const render = () => {
    frame = 0;
    if (destroyed) return;
    applied = calculateWorkspaceLayout(preferences, ...sizes());
    rootStyle.setProperty(
      "--connections-width",
      `${applied.connectionsWidth}px`,
    );
    rootStyle.setProperty("--objects-width", `${applied.objectsWidth}px`);
    rootStyle.setProperty("--editor-height", `${applied.editorHeight}px`);
    document.body.classList.toggle(
      "hide-connections",
      !applied.connectionsVisible,
    );
    document.body.classList.toggle("hide-objects", !applied.objectsVisible);
    for (const kind of ["connections", "objects"]) {
      const visible = applied[`${kind}Visible`];
      const toggle = elements[kind === "connections" ? "toggleConnections" : "toggleObjects"];
      const pane = elements[`${kind}Pane`];
      const lostFocus = !visible && (pane.contains(document.activeElement) || document.activeElement === elements[`${kind}Splitter`]);
      elements[`${kind}Rail`].hidden = visible;
      pane.inert = !visible;
      rootStyle.setProperty(`--${kind}-track-width`, `${applied[`${kind}Width`] + applied[`${kind}RailWidth`]}px`);
      rootStyle.setProperty(`--${kind}-splitter-width`, `${visible ? LIMITS.columnSeparator : 0}px`);
      toggle.setAttribute("aria-expanded", String(visible));
      if (lostFocus) toggle.focus({ preventScroll: true });
    }
    setSeparator(
      elements.connectionsSplitter,
      LIMITS.connectionsMin,
      applied.connectionsMax,
      applied.connectionsWidth,
      applied.connectionsVisible,
    );
    setSeparator(
      elements.objectsSplitter,
      LIMITS.objectsMin,
      applied.objectsMax,
      applied.objectsWidth,
      applied.objectsVisible,
    );
    setSeparator(
      elements.editorSplitter,
      LIMITS.editorMin,
      applied.editorMax,
      applied.editorHeight,
    );
  };
  const schedule = () => {
    if (!frame && !destroyed) frame = requestAnimationFrame(render);
  };
  const flush = () => {
    if (frame) cancelAnimationFrame(frame);
    render();
  };
  const adjust = (kind, value) => {
    const current = calculateWorkspaceLayout(preferences, ...sizes());
    if (kind === "editor")
      preferences.editorSize =
        (clamp(value, LIMITS.editorMin, current.editorMax) /
          current.editorAvailable) *
        100;
    else {
      // Keep the neighbouring pane stationary while dragging this divider.
      const other = kind === "connections" ? "objects" : "connections";
      if (current[`${other}Visible`])
        preferences[`${other}Width`] = current[`${other}Width`];
      preferences[`${kind}Width`] = clamp(
        value,
        LIMITS[`${kind}Min`],
        current[`${kind}Max`],
      );
    }
    schedule();
  };
  const finishDrag = (cancelled = false) => {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (cancelled) preferences = previous.preferences;
    previous.element.classList.remove("dragging");
    document.body.classList.remove("resizing");
    document.body.style.removeProperty("cursor");
    if (previous.element.hasPointerCapture?.(previous.pointerId))
      previous.element.releasePointerCapture(previous.pointerId);
    flush();
    if (!cancelled) persist();
  };
  for (const kind of ["connections", "objects", "editor"]) {
    const element = elements[`${kind}Splitter`];
    const horizontal = kind === "editor";
    element.setAttribute("aria-controls", `${kind}Pane`);
    element.setAttribute(
      "aria-orientation",
      horizontal ? "horizontal" : "vertical",
    );
    element.title = `${element.getAttribute("aria-label")} · 拖动或方向键调整，双击重置`;
    listen(element, "pointerdown", (event) => {
      if (event.button !== 0 || drag) return;
      flush();
      drag = {
        kind,
        element,
        pointerId: event.pointerId,
        start: horizontal ? event.clientY : event.clientX,
        base: horizontal ? applied.editorHeight : applied[`${kind}Width`],
        preferences: { ...preferences },
      };
      element.classList.add("dragging");
      document.body.classList.add("resizing");
      document.body.style.cursor = horizontal ? "row-resize" : "col-resize";
      element.setPointerCapture(event.pointerId);
      element.focus({ preventScroll: true });
      event.preventDefault();
    });
    // Pointer capture routes events to the splitter in modern WebKit. Keep a
    // window fallback as well because native WebKit drag bridges may retarget
    // intermediate events while the pointer crosses a pane boundary.
    const move = (event) => {
      if (drag?.element !== element || drag.pointerId !== event.pointerId)
        return;
      adjust(
        kind,
        drag.base + (horizontal ? event.clientY : event.clientX) - drag.start,
      );
    };
    const up = (event) => {
      if (drag?.element !== element || drag.pointerId !== event.pointerId)
        return;
      move(event);
      finishDrag();
    };
    listen(window, "pointermove", move);
    listen(window, "pointerup", up);
    listen(element, "pointercancel", () => finishDrag(true));
    listen(element, "lostpointercapture", () => finishDrag(true));
    listen(element, "keydown", (event) => {
      if (event.key === "Escape" && drag) {
        finishDrag(true);
        event.preventDefault();
        return;
      }
      const decrease = horizontal ? "ArrowUp" : "ArrowLeft";
      const increase = horizontal ? "ArrowDown" : "ArrowRight";
      if (![decrease, increase, "Home", "End"].includes(event.key)) return;
      flush();
      const min = horizontal ? LIMITS.editorMin : LIMITS[`${kind}Min`];
      const max = horizontal ? applied.editorMax : applied[`${kind}Max`];
      const now = horizontal ? applied.editorHeight : applied[`${kind}Width`];
      const value =
        event.key === "Home"
          ? min
          : event.key === "End"
            ? max
            : now +
              (event.key === decrease ? -1 : 1) * (event.shiftKey ? 40 : 10);
      adjust(kind, value);
      flush();
      persist();
      event.preventDefault();
    });
    listen(element, "dblclick", () => {
      finishDrag(true);
      const key = horizontal ? "editorSize" : `${kind}Width`;
      preferences[key] = DEFAULT_LAYOUT[key];
      flush();
      persist();
    });
  }
  const setPaneVisible = (kind, visible) => {
    finishDrag(true);
    flush();
    preferences[`${kind}Collapsed`] = !visible;
    const bothMinimum = LIMITS.mainMin + LIMITS.connectionsMin + LIMITS.objectsMin + 2 * LIMITS.columnSeparator;
    if (visible && elements.workspaceBody.clientWidth < bothMinimum)
      preferences[`${kind === "connections" ? "objects" : "connections"}Collapsed`] = true;
    flush();
    persist();
  };
  for (const button of document.querySelectorAll("[data-hide-pane]")) {
    const kind = button.dataset.hidePane;
    if (!["connections", "objects"].includes(kind)) continue;
    listen(button, "click", () => {
      const toggle = elements[kind === "connections" ? "toggleConnections" : "toggleObjects"];
      setPaneVisible(kind, false);
      toggle.focus({ preventScroll: true });
    });
  }
  for (const kind of ["connections", "objects"]) {
    const toggle =
      elements[kind === "connections" ? "toggleConnections" : "toggleObjects"];
    toggle.setAttribute("aria-controls", `${kind}Pane`);
    listen(toggle, "click", () => {
      flush();
      setPaneVisible(kind, !applied[`${kind}Visible`]);
      if (applied[`${kind}Visible`])
        elements[`${kind}Pane`].querySelector("[data-hide-pane]").focus({ preventScroll: true });
    });
  }
  listen(elements.resetLayout, "click", () => {
    finishDrag(true);
    preferences = normalizeLayout();
    flush();
    persist();
  });
  const resize = () => {
    // A pane drag changes workspaceBody itself, which also triggers this
    // observer. Do not cancel the active drag or every pointer move would be
    // reverted before the user can reach the target width.
    schedule();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(elements.workspaceBody);
  observer.observe(elements.editorResult);
  listen(window, "blur", () => finishDrag(true));
  render();
  return {
    showPane(kind) {
      if (["connections", "objects"].includes(kind)) setPaneVisible(kind, true);
    },
    destroy() {
      finishDrag(true);
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      cleanup.forEach((remove) => remove());
    },
  };
}
