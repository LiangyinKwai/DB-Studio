import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, selectPostgresTarget } from './playwright-import.mjs';
import { createWorkspaceFixture } from './fixtures/workspace-fixture.mjs';

// CDP drives browser composition events; this is not a native macOS IME test.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist');
const evidence = resolve(root, 'output/playwright/ime');
mkdirSync(evidence, { recursive: true });
const server = createServer((req, res) => {
  const file = resolve(dist, (req.url || '/').split('?')[0].slice(1) || 'index.html');
  if (!file.startsWith(`${dist}/`) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ executablePath: process.env.DB_STUDIO_CHROME || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const fixture = createWorkspaceFixture();
await context.exposeFunction('__FIXTURE_INVOKE__', fixture.invoke);
await context.addInitScript(() => {
  window.__DB_STUDIO_FIXTURE__ = true;
  window.__TAURI__ = { core: { invoke: (...args) => window.__FIXTURE_INVOKE__(...args) } };
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const checks = [];
async function check(name, run) {
  await run(); checks.push(name); console.log(`PASS: ${name}`);
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-connection-id="conn-dev"]').click();
  await page.locator('#connectionMode').getByText('已连接', { exact: true }).waitFor();
  await page.locator('#addQueryTab').click();
  await selectPostgresTarget(page, 'app', 'public');
  let editor = page.locator('#sqlEditor .cm-content');
  const sqlEditor = editor;
  const cdp = await context.newCDPSession(page);
  const text = () => editor.evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => {
    const copy = line.cloneNode(true);
    copy.querySelectorAll('.cm-placeholder').forEach(node => node.remove());
    return copy.textContent;
  }).join('\n'));
  async function reset(sql = '') {
    await editor.fill(sql);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowRight');
  }
  async function preedit(value = 'se l') {
    await cdp.send('Input.imeSetComposition', { text: value, selectionStart: value.length, selectionEnd: value.length });
  }
  async function commit(value = 'se l', key = 'CapsLock') {
    if (key) await page.keyboard.press(key);
    await cdp.send('Input.insertText', { text: value });
    await page.waitForTimeout(100);
  }
  await check('segmented Latin commit, cursor, continuation, undo and redo', async () => {
    await reset(); await preedit();
    assert.equal(await text(), 'se l');
    await page.screenshot({ path: resolve(evidence, 'composition.png') });
    await commit();
    assert.equal(await text(), 'sel');
    assert.match(await page.locator('#cursorPosition').innerText(), /Col 4/);
    await page.keyboard.press('Meta+z');
    assert.equal((await text()).trim(), '');
    await page.keyboard.press('Meta+Shift+z');
    assert.equal(await text(), 'sel');
    await page.keyboard.press('Escape');
    await page.keyboard.type('ect 1;');
    assert.equal(await text(), 'select 1;');
    await page.screenshot({ path: resolve(evidence, 'committed.png') });
  });
  await check('executed and persisted SQL uses the repaired text', async () => {
    await page.locator('#runQuery').click();
    await page.waitForFunction(() => document.querySelector('#runQuery')?.textContent.includes('执行'));
    assert.equal(fixture.callsFor('execute_query').at(-1)?.args.request.sql, 'select 1;');
    await page.waitForTimeout(400);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('db-studio.workspace-tabs.v2') || '[]'));
    assert(stored.some(tab => tab.sql === 'select 1;'));
  });
  await check('Shift and Ctrl+Space switches repair the same span', async () => {
    for (const key of ['Shift', 'Control+Space']) {
      await reset(); await preedit(); await commit('se l', key);
      assert.equal(await text(), 'sel', key);
    }
  });
  await check('switch key delivered after compositionend', async () => {
    await reset(); await preedit();
    await cdp.send('Input.insertText', { text: 'se l' });
    await page.keyboard.press('CapsLock');
    await page.waitForTimeout(100);
    assert.equal(await text(), 'sel');
  });
  await check('immediate subsequent typing stays outside repaired range', async () => {
    await reset(); await preedit();
    await page.keyboard.press('CapsLock');
    await cdp.send('Input.insertText', { text: 'se l' });
    await page.keyboard.insertText('ect ');
    await page.waitForTimeout(100);
    assert.equal(await text(), 'select ');
    await reset(); await preedit();
    await page.keyboard.press('CapsLock');
    await cdp.send('Input.insertText', { text: 'se l' });
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    assert.equal(await text(), 'sel ');
  });
  await check('final composition text can differ from the preedit', async () => {
    await reset('SELECT '); await preedit('use'); await commit('use r');
    assert.equal(await text(), 'SELECT user');
  });
  await check('DOM insertion after compositionend is reconciled (synthetic ordering)', async () => {
    await reset('SELECT ');
    await editor.evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'CapsLock', bubbles: true, isComposing: true }));
      el.dispatchEvent(new CompositionEvent('compositionend', { data: 'se l', bubbles: true }));
      document.execCommand('insertText', false, 'se l');
    });
    await page.waitForTimeout(100);
    assert.equal(await text(), 'SELECT sel');
  });
  await check('selection replacement and cursor movement preserve surrounding SQL', async () => {
    await reset('SELECT old FROM orders;');
    await page.keyboard.press('Meta+Home');
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    await preedit('use r'); await commit('use r');
    assert.equal(await text(), 'SELECT user FROM orders;');
    await page.keyboard.press('Meta+z');
    assert.equal(await text(), 'SELECT old FROM orders;');
    await reset('SELECT '); await preedit();
    await page.keyboard.press('CapsLock');
    await cdp.send('Input.insertText', { text: 'se l' });
    await page.keyboard.press('Meta+Home');
    await page.waitForTimeout(100);
    assert.equal(await text(), 'SELECT sel');
    assert.match(await page.locator('#cursorPosition').innerText(), /Col 1(?:$| )/);
  });
  await check('Chinese candidates, cancellation and explicit spaces stay intact', async () => {
    await reset(); await preedit(); await commit('色了', null);
    assert.equal(await text(), '色了');
    await reset('SELECT '); await preedit();
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await page.waitForTimeout(100);
    assert.equal(await text(), 'SELECT ');
    await reset(); await preedit(); await page.keyboard.press('Space'); await commit();
    assert.equal(await text(), 'se l ');
  });
  await check('SQL strings, quoted identifiers, line/block comments are protected', async () => {
    for (const prefix of ["SELECT '", 'SELECT "', 'SELECT $$', '-- ', '/* ']) {
      await reset(prefix); await preedit(); await commit();
      assert.equal(await text(), prefix + 'se l', prefix);
    }
  });
  await check('ordinary spaces, pasted SQL and Tab indentation are unchanged', async () => {
    await reset();
    await page.keyboard.type('select  1;');
    assert.equal(await text(), 'select  1;');
    await reset();
    await page.keyboard.insertText("SELECT 'se l',  2; -- se l");
    assert.equal(await text(), "SELECT 'se l',  2; -- se l");
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+Home');
    await page.keyboard.press('Tab');
    assert.match(await text(), /^ +SELECT 'se l',  2; -- se l$/);
  });
  await check('composition shortcuts cannot execute SQL or create a tab', async () => {
    await reset('SELECT '); await preedit();
    const executions = fixture.callsFor('execute_query').length;
    const tabs = await page.locator('.query-tab').count();
    // Explicit composed key events keep this check independent of OS shortcuts.
    await editor.evaluate(el => {
      for (const key of ['Enter', 't']) el.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, isComposing: true, bubbles: true }));
    });
    assert.equal(fixture.callsFor('execute_query').length, executions);
    assert.equal(await page.locator('.query-tab').count(), tabs);
    await commit();
  });
  await check('changing tabs clears pending repair', async () => {
    await reset();
    const original = await page.locator('.query-tab.active').getAttribute('data-tab-id');
    await preedit(); await page.keyboard.press('CapsLock');
    await cdp.send('Input.insertText', { text: 'se l' });
    await page.locator('#addQueryTab').evaluate(el => el.click());
    await editor.fill('SELECT 42;');
    await page.waitForTimeout(100);
    assert.equal(await text(), 'SELECT 42;');
    await page.locator(`.tab-select[data-tab-id="${original}"]`).click();
    assert.equal(await text(), 'sel', 'previous tab was not reconciled before switching');
  });
  await reset('SELECT 1;');
  await page.locator('#runQuery').click();
  await page.locator('#resultFilter').waitFor();
  async function nativeCommit(input, value = 'se l', key = 'CapsLock') {
    await input.focus();
    await preedit(value);
    if (key) await page.keyboard.press(key);
    await cdp.send('Input.insertText', { text: value });
    await page.waitForTimeout(100);
  }
  await check('native result and connection filters share the SQL switch repair', async () => {
    for (const selector of ['#resultFilter', '#connectionSearch']) {
      const input = page.locator(selector);
      for (const key of ['CapsLock', 'Shift', 'Control+Space']) {
        await input.fill(''); await nativeCommit(input, 'se l', key);
        assert.equal(await input.inputValue(), 'sel', `${selector}/${key}`);
      }
      await input.fill('');
    }
  });
  await check('native selected spans preserve surrounding text and following typing', async () => {
    const input = page.locator('#resultFilter');
    await input.fill('before old after');
    await input.evaluate(control => control.setSelectionRange(7, 10));
    await nativeCommit(input, 'use r');
    assert.equal(await input.inputValue(), 'before user after');
    await input.fill(''); await input.focus();
    await preedit(); await page.keyboard.press('CapsLock');
    await cdp.send('Input.insertText', { text: 'se l' });
    await page.keyboard.insertText('ect ');
    await page.waitForTimeout(100);
    assert.equal(await input.inputValue(), 'select ');
    await input.fill('');
  });
  await check('native controls reconcile WebKit ordering and switch keys after compositionend', async () => {
    const input = page.locator('#resultFilter');
    await input.fill('prefix ');
    await input.evaluate(control => {
      control.focus(); control.setSelectionRange(control.value.length, control.value.length);
      control.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      control.dispatchEvent(new CompositionEvent('compositionend', { data: 'se l', bubbles: true }));
      document.execCommand('insertText', false, 'se l');
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'CapsLock', bubbles: true }));
    });
    await page.waitForTimeout(100);
    assert.equal(await input.inputValue(), 'prefix sel');
    await input.fill('');
  });
  await check('native Chinese, explicit spaces and pasted content remain unchanged', async () => {
    const input = page.locator('#resultFilter');
    await input.fill(''); await nativeCommit(input, '中文', null);
    assert.equal(await input.inputValue(), '中文');
    await input.fill(''); await input.focus();
    await page.keyboard.type('hello  world');
    assert.equal(await input.inputValue(), 'hello  world');
    await input.fill(''); await page.keyboard.insertText('se l');
    await page.waitForTimeout(100);
    assert.equal(await input.inputValue(), 'se l');
    await input.fill(''); await input.focus();
    await preedit();
    await input.evaluate(control => control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, isComposing: true })));
    await page.keyboard.press('CapsLock');
    await cdp.send('Input.insertText', { text: 'se l' });
    await page.waitForTimeout(100);
    assert.equal(await input.inputValue(), 'se l');
    await input.fill('');
  });
  await check('dynamically created funnel inputs repair before applying their value', async () => {
    await page.locator('[data-filter-column="0"]').click();
    const input = page.locator('.db-grid-filter-panel input');
    await nativeCommit(input, 'ac tive');
    assert.equal(await input.inputValue(), 'active');
    await input.fill(''); await input.focus();
    await preedit('ac tive'); await page.keyboard.press('CapsLock');
    await cdp.send('Input.insertText', { text: 'ac tive' });
    await page.locator('.db-grid-filter-panel').getByRole('button', { name: '应用筛选', exact: true }).click();
    assert.ok((await page.locator('.db-grid-filter-bar').innerText()).includes('active'));
    assert.ok(!(await page.locator('.db-grid-filter-bar').innerText()).includes('ac tive'));
    await page.locator('[data-remove-filter="all"]').click();
  });
  await check('dynamic textareas repair compositions while passwords and readonly fields stay untouched', async () => {
    await page.evaluate(() => {
      for (const kind of ['textarea', 'password', 'readonly']) {
        const control = document.createElement(kind === 'password' ? 'input' : 'textarea');
        control.dataset.nativeImeTest = kind;
        if (kind === 'password') control.type = 'password';
        if (kind === 'readonly') control.readOnly = true;
        control.style.cssText = 'position:fixed;top:60px;left:10px;z-index:9999;width:200px;height:45px';
        document.body.append(control);
      }
    });
    const textarea = page.locator('[data-native-ime-test="textarea"]');
    await nativeCommit(textarea, 'use r');
    assert.equal(await textarea.inputValue(), 'user');
    for (const kind of ['password', 'readonly']) {
      const control = page.locator(`[data-native-ime-test="${kind}"]`);
      await control.evaluate(control => {
        control.focus(); control.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        control.dispatchEvent(new KeyboardEvent('keydown', { key: 'CapsLock', bubbles: true }));
        control.value = 'se l';
        control.dispatchEvent(new CompositionEvent('compositionend', { data: 'se l', bubbles: true }));
      });
      await page.waitForTimeout(100);
      assert.equal(await control.inputValue(), 'se l', kind);
    }
    const revealed = page.locator('[data-native-ime-test="password"]');
    await revealed.evaluate(control => { control.type = 'text'; control.value = ''; });
    await nativeCommit(revealed, 'se l');
    assert.equal(await revealed.inputValue(), 'se l', 'revealed passwords must stay unchanged');
    await page.locator('[data-native-ime-test]').evaluateAll(controls => controls.forEach(control => control.remove()));
  });
  await page.locator('[data-connection-id="redis-local"]').click();
  await page.locator('.redis-database[data-redis-db="0"] > summary').click({ button: 'right' });
  await page.locator('[data-redis-database-context-action="console"]').click();
  editor = page.locator('#redisCommandEditor .cm-content');
  await check('Redis console repairs segmented command and key commits with undo', async () => {
    await reset(); await preedit('ge t'); await commit('ge t');
    assert.equal(await text(), 'get');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+z');
    assert.equal((await text()).trim(), '');
    await page.keyboard.press('Meta+Shift+z');
    assert.equal(await text(), 'get');
    await reset('GET '); await preedit('use r'); await commit('use r', 'Shift');
    assert.equal(await text(), 'GET user');
  });
  await check('Redis console protects quoted values, multiline strings and deliberate spaces', async () => {
    for (const prefix of ['SET key "', "SET key '", 'SET key "first line\n']) {
      await reset(prefix); await preedit('se l'); await commit('se l');
      assert.equal(await text(), prefix + 'se l', prefix);
    }
    await reset('GET '); await preedit('use r'); await page.keyboard.press('Space'); await commit('use r');
    assert.equal(await text(), 'GET use r ');
    await reset(); await page.keyboard.insertText('SET key "se l"');
    assert.equal(await text(), 'SET key "se l"');
  });
  await check('Redis execution uses the repaired command', async () => {
    await reset(); await preedit('pin g'); await commit('pin g');
    await page.locator('#redisConsoleRun').click();
    await page.waitForFunction(() => document.querySelector('#redisConsoleOutput')?.textContent.includes('ping'));
    assert.equal(fixture.callsFor('execute_redis_command').at(-1)?.args.request.sql, 'ping');
  });
  await page.locator('#addQueryTab').click();
  editor = sqlEditor;
  await check('Redis query tabs share the IME fix and string protection', async () => {
    await reset(); await preedit('ge t'); await commit('ge t');
    assert.equal(await text(), 'get');
    await reset('SET key "'); await preedit('se l'); await commit('se l');
    assert.equal(await text(), 'SET key "se l');
  });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(evidence, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
} finally {
  await context.close(); await browser.close();
  await new Promise(done => server.close(done));
}
