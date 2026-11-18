import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from './playwright-import.mjs';

const moduleSource = readFileSync(new URL('../src/structure-comment-editor.js', import.meta.url), 'utf8');
const valueSource = readFileSync(new URL('../src/structure-comment-value.js', import.meta.url), 'utf8');
const html = `<!doctype html><meta charset="utf-8"><style>
dialog { width: 600px; padding: 20px; } dialog::backdrop { background: #0006; }
.dialog-header,.structure-comment-footer { display:flex; justify-content:space-between; gap:20px; }
textarea { box-sizing:border-box; width:100%; min-height:250px; white-space:pre-wrap; } button { min-height:32px; }
</style><dialog id="parent"><form id="parentForm"><button type="button" id="open">展开备注</button><button type="submit">创建表</button></form></dialog>
<script type="module">
import {createStructureCommentEditor} from '/editor.js';
window.draft = '原备注'; window.changes = []; window.sqlExecutions = 0;
const parent = document.querySelector('#parent'), form = document.querySelector('form'), anchor = document.querySelector('#open');
form.addEventListener('submit', event => { event.preventDefault(); window.sqlExecutions++; });
document.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) window.sqlExecutions++; });
window.editor = createStructureCommentEditor({parent:form});
anchor.addEventListener('click', () => window.editor.open({value:window.draft, fieldName:'description', anchor, onChange(value) { window.draft=value; window.changes.push(value); }}));
parent.showModal(); window.ready=true;
</script>`;
const server = createServer((request, response) => {
  const source = request.url === '/editor.js' ? moduleSource : request.url === '/structure-comment-value.js' ? valueSource : null;
  response.writeHead(200, { 'content-type': source ? 'text/javascript' : 'text/html; charset=utf-8' });
  response.end(source || html);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DB_STUDIO_CHROME || undefined });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.ready);
  const dialog = page.locator('.structure-comment-dialog'), input = dialog.locator('textarea');
  const open = () => page.locator('#open').click();
  const parentOpen = () => page.locator('#parent').evaluate(node => node.open);
  const focused = () => page.evaluate(() => document.activeElement.id);
  await open();
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  assert.equal(await input.getAttribute('aria-label'), 'description · 备注');
  const longText = "  第一行 O'Reilly\n第二行 \\path 😀  \n" + '很长的备注 '.repeat(8000);
  await input.fill(longText);
  assert.equal(await page.evaluate(() => window.draft), longText);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  assert.equal(await focused(), 'open');
  await open();
  assert.equal(await input.inputValue(), longText);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await parentOpen(), true);
  assert.equal(await focused(), 'open');
  assert.equal(await page.evaluate(() => window.draft), longText);

  await open(); await input.fill('');
  await dialog.getByRole('button', { name: '收起备注编辑' }).click();
  await open(); assert.equal(await input.inputValue(), '');
  await input.fill('line'); await input.press('End'); await input.press('Enter');
  await input.press('x');
  assert.equal(await input.inputValue(), 'line\nx');
  await input.press('Control+Enter');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await parentOpen(), true);
  assert.equal(await page.evaluate(() => window.sqlExecutions), 0);

  await open(); await input.fill('遮罩关闭也保留');
  await page.mouse.click(5, 5);
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await page.evaluate(() => window.draft), '遮罩关闭也保留');
  assert.equal(await focused(), 'open');

  await open();
  const beforeComposition = await page.evaluate(() => window.changes.length);
  await input.evaluate(node => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.value = '拼音候选'; node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    node.closest('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
  });
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.evaluate(() => window.changes.length), beforeComposition);
  await input.evaluate(node => {
    node.value = '拼音完成\n保留换行';
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    node.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => window.draft), '拼音完成\n保留换行');
  assert.equal(await page.evaluate(() => window.changes.length), beforeComposition + 1);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();

  await page.evaluate(() => { window.draft = '原文\r\n仍保留'; });
  await open(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  assert.equal(await page.evaluate(() => window.draft), '原文\r\n仍保留');

  const raw = 'first\r\nsecond\rthird\nfourth';
  await page.evaluate(raw => { window.draft = raw; }, raw); await open();
  await input.evaluate(node => { node.setSelectionRange(12, 12); }); await page.keyboard.insertText('!');
  const edited = 'first\r\nsecond!\rthird\nfourth';
  assert.equal(await page.evaluate(() => window.draft), edited);
  await input.press('ControlOrMeta+Z'); assert.equal(await page.evaluate(() => window.draft), raw);
  await input.press('ControlOrMeta+Shift+Z'); assert.equal(await page.evaluate(() => window.draft), edited);
  const pasted = '中\r\n文\r';
  await input.evaluate(node => { node.setSelectionRange(node.value.indexOf('second'), node.value.indexOf('fourth')); });
  await page.evaluate(async text => {
    document.querySelector('textarea').addEventListener('paste', event => { window.nativePasteText = event.clipboardData.getData('text/plain'); }, { once: true });
    await navigator.clipboard.writeText(text);
  }, pasted);
  await input.press('ControlOrMeta+V');
  await page.waitForFunction(() => typeof window.nativePasteText === 'string');
  assert.equal(await page.evaluate(() => window.nativePasteText), pasted, 'native clipboard delivers the mixed line endings unchanged');
  const pasteResult = `first\r\n${pasted}fourth`;
  assert.equal(await page.evaluate(() => window.draft), pasteResult);
  await input.press('ControlOrMeta+Z'); assert.equal(await page.evaluate(() => window.draft), edited);
  await input.press('ControlOrMeta+Shift+Z'); assert.equal(await page.evaluate(() => window.draft), pasteResult);
  await input.press('Escape'); await open();
  await input.evaluate(node => { node.setSelectionRange(0, 5); }); await page.keyboard.insertText('FIRST');
  assert.equal(await page.evaluate(() => window.draft), `FIRST\r\n${pasted}fourth`);
  await input.press('ControlOrMeta+Z'); assert.equal(await page.evaluate(() => window.draft), pasteResult);
  await input.press('Escape');

  await page.evaluate(() => { window.draft = '\r\n\n'; }); await open();
  await input.evaluate(node => { node.setSelectionRange(0, 1); }); await input.press('Backspace');
  assert.equal(await page.evaluate(() => window.draft), '\n');
  await input.press('ControlOrMeta+Z'); assert.equal(await page.evaluate(() => window.draft), '\r\n\n');
  await input.evaluate(node => { node.setSelectionRange(1, 2); }); await input.press('Backspace');
  assert.equal(await page.evaluate(() => window.draft), '\r\n');
  await input.press('ControlOrMeta+Z'); await input.press('Escape');

  await page.evaluate(() => { window.draft = 'x\rZ\ny'; }); await open();
  await input.evaluate(node => { node.setSelectionRange(2, 3); }); await input.press('Backspace');
  assert.equal(await page.evaluate(() => window.draft), 'x\r\ny');
  assert.equal(await input.inputValue(), 'x\ny');
  await input.press('ControlOrMeta+Z'); assert.equal(await page.evaluate(() => window.draft), 'x\rZ\ny');
  await input.press('ControlOrMeta+Shift+Z'); assert.equal(await page.evaluate(() => window.draft), 'x\r\ny');
  await input.press('Escape');

  await page.evaluate(() => { window.draft = 'A\r\nB\rC'; }); await open();
  const imeBefore = await page.evaluate(() => window.changes.length);
  await input.evaluate(node => {
    node.setSelectionRange(2, 3); node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const text of ['拼', '拼音']) {
      node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertCompositionText', data: text, isComposing: true }));
      node.value = `A\n${text}\nC`; node.setSelectionRange(2, 2 + text.length);
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: text, isComposing: true }));
    }
  });
  assert.equal(await page.evaluate(() => window.changes.length), imeBefore);
  await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  assert.equal(await page.evaluate(() => window.draft), 'A\r\n拼音\rC');
  assert.equal(await page.evaluate(() => window.changes.length), imeBefore + 1);
  await input.press('ControlOrMeta+Z'); assert.equal(await page.evaluate(() => window.draft), 'A\r\nB\rC');
  await input.press('ControlOrMeta+Shift+Z'); assert.equal(await page.evaluate(() => window.draft), 'A\r\n拼音\rC');
  await input.press('Escape');
  await open();
  await page.evaluate(() => { document.querySelector('#parent').close(); window.editor.destroy(); });
  assert.equal(await dialog.count(), 0);
  assert.equal(await page.evaluate(() => window.sqlExecutions), 0);
  assert.deepEqual(errors, []);
  console.log('Structure comment editor: exact CRLF/CR/LF paste and edits, grouped undo/redo, IME, close/reopen, long text, focus and no SQL submission passed');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
