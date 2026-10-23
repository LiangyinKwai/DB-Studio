/** Format existing Mac shortcut labels without changing shortcut behavior. */
export function formatShortcut(label, platform = '') {
  const text = String(label ?? '');
  return /mac|iphone|ipad|ipod/i.test(String(platform)) ? text : text.replaceAll('⌘', 'Ctrl');
}
