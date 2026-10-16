/** Run before CodeMirror's default Mod-Enter binding, which inserts a blank
 * line and collapses the SQL selection. Consume propagation so the document
 * handler cannot submit the same query a second time. */
export function createSqlExecutionKeymap(runQuery) {
  return [{
    key: 'Mod-Enter',
    run: () => { void runQuery(); return true; },
    preventDefault: true,
    stopPropagation: true,
  }];
}
