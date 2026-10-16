import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateWorkspaceLayout, normalizeLayout } from '../src/workspace-layout.js';

test('normalizes persisted pane sizes and collapse flags', () => {
  assert.deepEqual(normalizeLayout({ connectionsWidth: 4, objectsWidth: 999, editorSize: -2, connectionsCollapsed: true }), {
    connectionsWidth: 160, objectsWidth: 460, editorSize: 0, connectionsCollapsed: true, objectsCollapsed: false,
  });
});

test('fits both panes while preserving the main pane minimum', () => {
  const result = calculateWorkspaceLayout({ connectionsWidth: 330, objectsWidth: 430 }, 1060, 700);
  assert.equal(result.connectionsVisible, true);
  assert.equal(result.objectsVisible, true);
  assert.ok(result.connectionsWidth + result.objectsWidth + 10 + result.mainWidth <= 1060);
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
  const result = calculateWorkspaceLayout({ editorSize: 99 }, 1200, 287);
  assert.equal(result.editorHeight, 100);
  assert.equal(result.resultsHeight, 180);
});

test('collapsed panes reserve space for restore tabs without clipping the editor', () => {
  for (const width of [600, 626, 627, 700, 760, 1440]) {
    for (const connectionsCollapsed of [false, true]) {
      for (const objectsCollapsed of [false, true]) {
        const result = calculateWorkspaceLayout({ connectionsCollapsed, objectsCollapsed }, width, 500);
        const rails = result.connectionsRailWidth + result.objectsRailWidth;
        const separators = (Number(result.connectionsVisible) + Number(result.objectsVisible)) * 5;
        assert.equal(result.connectionsRailWidth, result.connectionsVisible ? 0 : 32);
        assert.equal(result.objectsRailWidth, result.objectsVisible ? 0 : 32);
        assert.equal(result.connectionsWidth + result.objectsWidth + rails + separators + result.mainWidth, width);
        assert.ok(result.mainWidth >= 400);
      }
    }
  }
});
