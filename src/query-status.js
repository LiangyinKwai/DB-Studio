/** Return true for backend errors caused by an explicit query cancellation. */
export function isQueryCancellation(error) {
  const text = String(error?.message ?? error ?? "").toLowerCase();
  const code = String(error?.code ?? error?.sqlState ?? error?.sqlstate ?? "").toLowerCase();
  return (
    code === "57014" ||
    text.includes("查询已取消") ||
    text.includes("查询取消") ||
    text.includes("query canceled") ||
    text.includes("query cancelled") ||
    /\b57014\b/.test(text)
  );
}
