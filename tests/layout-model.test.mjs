import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateWorkspaceLayout, normalizeLayout } from '../src/workspace-layout.js';

test('normalizes persisted pane sizes and collapse flags', () => {
  assert.deepEqual(normalizeLayout({ connectionsWidth: 4, objectsWidth: 999, editorSize: -2, connectionsCollapsed: true }), {
    connectionsWidth: 160, objectsWidth: 460, editorSize: 0, historyHeight: 240, historyCollapsed: true,
    connectionsCollapsed: true, objectsCollapsed: false,
  });
});

test('fits both panes while preserving the main pane minimum', () => {
  const result = calculateWorkspaceLayout({ connectionsWidth: 330, objectsWidth: 430 }, 1060, 700);
  assert.equal(result.connectionsVisible, true);
  assert.equal(result.objectsVisible, true);
  assert.ok(result.connectionsWidth + result.objectsWidth + 2 + result.mainWidth <= 1060);
  assert.ok(result.mainWidth >= 400);
});

test('collapses sidebars at compact widths instead of clipping the main pane', () => {
  const result = calculateWorkspaceLayout({}, 700, 500);
  assert.equal(result.connectionsVisible, false);
  assert.equal(result.objectsVisible, true);
  assert.ok(result.mainWidth >= 400);
  assert.ok(result.editorHeight >= 100);
  assert.ok(result.resultsHeight >= 180);
});

test('editor and result panes preserve their minimum heights', () => {
  const result = calculateWorkspaceLayout({ editorSize: 99 }, 1200, 281);
  assert.equal(result.editorHeight, 100);
  assert.equal(result.resultsHeight, 180);
});

test('query history restores its preferred height and leaves room for connections', () => {
  const saved = normalizeLayout({ historyHeight: 340, historyCollapsed: false });
  const layout = (sidebarHeight) => calculateWorkspaceLayout(saved, 1200, 760, sidebarHeight);
  assert.equal(calculateWorkspaceLayout({}, 1200, 760).historyHeight, 48);
  assert.equal(layout(720).historyHeight, 340);
  assert.equal(layout(440).historyHeight, 279);
  assert.equal(layout(440).historyAvailable - layout(440).historyHeight, 160);
  assert.equal(layout(270).historyExpanded, false);
  assert.equal(layout(720).historyHeight, 340);
});

test('collapsed panes reserve space for restore tabs without clipping the editor', () => {
  for (const width of [600, 626, 627, 700, 760, 1440]) {
    for (const connectionsCollapsed of [false, true]) {
      for (const objectsCollapsed of [false, true]) {
        const result = calculateWorkspaceLayout({ connectionsCollapsed, objectsCollapsed }, width, 500);
        const rails = result.connectionsRailWidth + result.objectsRailWidth;
        const separators = (Number(result.connectionsVisible) + Number(result.objectsVisible)) * 1;
        assert.equal(result.connectionsRailWidth, result.connectionsVisible ? 0 : 32);
        assert.equal(result.objectsRailWidth, result.objectsVisible ? 0 : 32);
        assert.equal(result.connectionsWidth + result.objectsWidth + rails + separators + result.mainWidth, width);
        assert.ok(result.mainWidth >= 400);
      }
    }
  }
});
