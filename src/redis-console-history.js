// Budget retained UTF-16 text, including commands. Do not alter the command
// sent to Redis: these limits apply only to the console's local history.
export const MAX_CONSOLE_HISTORY_BYTES = 4 * 1024 * 1024;
export const MAX_CONSOLE_OUTPUT_BYTES = 1024 * 1024;
export const MAX_CONSOLE_COMMAND_BYTES = 64 * 1024;
export const MAX_CONSOLE_ENTRIES = 100;

function prefix(text, bytes) {
  let end = Math.floor(bytes / 2);
  if (end >= text.length) return text;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  // A substring can retain its much larger source buffer in the JS engine.
  // Reparse just the bounded prefix to detach it without changing code units.
  return JSON.parse(JSON.stringify(text.slice(0, Math.max(0, end))));
}

export const consoleHistoryBytes = history => history.reduce((bytes, entry) =>
  bytes + 2 * ((entry.command || '').length + (entry.output || '').length), 0);

export function boundConsoleHistory(history) {
  if (history.length > MAX_CONSOLE_ENTRIES) history.splice(0, history.length - MAX_CONSOLE_ENTRIES);
  for (const entry of history) {
    const command = String(entry.command || '');
    entry.command = prefix(command, MAX_CONSOLE_COMMAND_BYTES);
    entry.commandTruncated ||= entry.command.length !== command.length;
    const output = String(entry.output || '');
    entry.output = prefix(output, MAX_CONSOLE_OUTPUT_BYTES);
    entry.outputTruncated ||= entry.output.length !== output.length;
  }
  let bytes = consoleHistoryBytes(history);
  // Keep commands for reuse; release the oldest outputs first.
  for (const entry of history.slice(0, -1)) {
    if (bytes <= MAX_CONSOLE_HISTORY_BYTES) break;
    if (!entry.output || entry.pending) continue;
    bytes -= entry.output.length * 2;
    entry.output = '';
    entry.outputReleased = true;
  }
  while (bytes > MAX_CONSOLE_HISTORY_BYTES && history.length > 1) {
    const entry = history.shift();
    bytes -= 2 * ((entry.command || '').length + (entry.output || '').length);
  }
  return history;
}

export function consoleOutputNotice(entry) {
  if (entry.outputReleased) return '旧输出缓存已释放；命令仍可复用。';
  if (entry.outputTruncated || entry.truncated) return '仅显示部分输出，复制也只包含此预览；请分段读取完整数据。';
  return '';
}

export function consoleOutputForCopy(entry) {
  if (!entry || entry.pending || entry.outputReleased) throw new Error('该输出不可复制，请重新读取');
  const notice = consoleOutputNotice(entry);
  return notice ? `[${notice}]\n${entry.output || ''}` : entry.output || '';
}
