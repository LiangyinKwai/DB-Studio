import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { valueMetrics, valueMetricsLabel, inspectorSourceValue } from '../src/value-reader.js';

test('reader metrics count Unicode code points, source lines and UTF-8 bytes', () => {
  assert.deepEqual(valueMetrics('中文🙂\nA'), { characters: 5, lines: 2, bytes: 12 });
  assert.deepEqual(valueMetrics(''), { characters: 0, lines: 1, bytes: 0 });
  assert.match(valueMetricsLabel('a'.repeat(2048)), /2\.0 KiB/);
});
test('read/edit transitions preserve CRLF sources until an actual edit occurs', () => {
  const text = { sourceText: 'a\r\nb', textBaseline: 'a\nb' };
  assert.equal(inspectorSourceValue(text, 'a\nb'), 'a\r\nb');
  assert.equal(inspectorSourceValue(text, 'a\nb!'), 'a\nb!');
  const json = { jsonInfo: { raw: '{\r\n"id":9007199254740993}' }, jsonEditing: true, jsonEditBaseline: '{\n"id":9007199254740993}' };
  assert.equal(inspectorSourceValue(json, json.jsonEditBaseline), json.jsonInfo.raw);
});
test('JSON display formatting preserves numeric tokens and bounds pathological indentation growth', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('function formatJsonSource('), main.indexOf('function toggleCellJsonEditing('));
  const format = vm.runInNewContext(`(${fn})`);
  const source = '{"id":9007199254740993,"decimal":1.234567890123456789,"id":2,"text":"a \\n b"}';
  assert.equal(format(format(source, true), false), source);
  assert.throws(() => format('['.repeat(40000) + '0' + ']'.repeat(40000), true), /保留完整原文/);
});
