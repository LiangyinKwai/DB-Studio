const eye = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>';
const eyeOff = '<path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3.7M6.3 6.3A20 20 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.7-1.7M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';

/** Enhance every password input, including fields added by later dialogs. */
export function initPasswordFields(root = document) {
  const controls = new WeakMap();
  let nextId = 0;
  function enhance(input) {
    if (controls.has(input)) return;
    const document = input.ownerDocument;
    const wrapper = document.createElement('span');
    wrapper.className = 'password-control';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'password-toggle';
    if (!input.id) {
      let id;
      do { id = `password-field-${++nextId}`; } while (document.getElementById(id));
      input.id = id;
    }
    button.setAttribute('aria-controls', input.id);
    const render = (visible) => {
      const start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection;
      input.type = visible ? 'text' : 'password';
      if (start !== null) input.setSelectionRange(start, end, direction);
      const label = visible ? '隐藏密码' : '显示密码';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(visible));
      button.disabled = input.disabled;
      button.innerHTML = `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${visible ? eyeOff : eye}</svg>`;
    };
    input.before(wrapper);
    wrapper.append(input, button);
    controls.set(input, { render, button });
    // Pointer users can continue typing at the same cursor position; keyboard
    // users retain focus on the button and can toggle again with Space/Enter.
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => render(input.type === 'password'));
    render(false);
  }
  function scan(node) {
    if (node.matches?.('input[type="password"]')) enhance(node);
    node.querySelectorAll?.('input[type="password"]').forEach(enhance);
  }
  function hideAll(container = root) {
    container.querySelectorAll('.password-control input').forEach(input => controls.get(input)?.render(false));
  }
  scan(root);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(scan);
      else if (record.attributeName === 'disabled') {
        const control = controls.get(record.target);
        if (control) control.button.disabled = record.target.disabled;
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  root.addEventListener('close', event => { if (event.target.matches?.('dialog')) hideAll(event.target); }, true);
  root.addEventListener('reset', event => hideAll(event.target), true);
  return { hideAll };
}
