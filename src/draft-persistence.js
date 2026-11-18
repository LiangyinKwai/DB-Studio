const labels = {
  idle: '编辑后自动保存 SQL 草稿',
  pending: 'SQL 草稿待保存…',
  saved: 'SQL 草稿已保存',
  error: 'SQL 草稿未保存',
};

/** Report success only after both the drafts and active-tab pointer are written. */
export function createDraftPersistence({ key, storage = () => localStorage, onStatus = () => {}, onError = () => {} }) {
  let status = 'idle';
  let failed = false;
  const update = next => {
    if (status === next) return;
    status = next;
    onStatus({ status, label: labels[status] });
  };
  onStatus({ status, label: labels[status] });
  return {
    pending() {
      // Keep a failure visible while the next edit waits for its save timer.
      if (!failed) update('pending');
    },
    save(snapshot) {
      try {
        const { tabs, activeId } = snapshot();
        const contents = JSON.stringify(tabs);
        const target = storage();
        target.setItem(key, contents);
        target.setItem(`${key}.active`, activeId || '');
      } catch (error) {
        update('error');
        if (!failed) {
          failed = true;
          onError(error);
        }
        return false;
      }
      failed = false;
      update('saved');
      return true;
    },
  };
}
