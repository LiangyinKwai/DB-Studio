const commands = [
  ["GET", "key", "读取字符串"], ["SET", "key value [NX|XX] [EX seconds|PX milliseconds]", "写入字符串"],
  ["MGET", "key [key ...]", "读取多个字符串"], ["MSET", "key value [key value ...]", "写入多个字符串"],
  ["DEL", "key [key ...]", "删除键"], ["UNLINK", "key [key ...]", "异步删除键"],
  ["EXISTS", "key [key ...]", "检查键是否存在"], ["TYPE", "key", "查看类型"],
  ["TTL", "key", "查看剩余秒数"], ["PTTL", "key", "查看剩余毫秒数"],
  ["EXPIRE", "key seconds", "设置过期时间"], ["PERSIST", "key", "移除过期时间"],
  ["INCR", "key", "递增"], ["DECR", "key", "递减"], ["INCRBY", "key increment", "按指定值递增"],
  ["APPEND", "key value", "追加字符串"], ["STRLEN", "key", "读取字符串长度"],
  ["HGET", "key field", "读取哈希字段"], ["HSET", "key field value [field value ...]", "写入哈希字段"],
  ["HGETALL", "key", "读取全部哈希字段"], ["HDEL", "key field [field ...]", "删除哈希字段"],
  ["HKEYS", "key", "列出哈希字段"], ["HLEN", "key", "读取哈希字段数"],
  ["LPUSH", "key element [element ...]", "从列表头部插入"], ["RPUSH", "key element [element ...]", "从列表尾部插入"],
  ["LRANGE", "key start stop", "读取列表范围"], ["LLEN", "key", "读取列表长度"], ["LPOP", "key [count]", "弹出列表头部"], ["RPOP", "key [count]", "弹出列表尾部"],
  ["SADD", "key member [member ...]", "添加集合成员"], ["SMEMBERS", "key", "读取集合成员"],
  ["SREM", "key member [member ...]", "删除集合成员"], ["SCARD", "key", "读取集合大小"], ["SISMEMBER", "key member", "检查集合成员"],
  ["ZADD", "key score member [score member ...]", "添加有序集合成员"], ["ZRANGE", "key start stop [WITHSCORES]", "读取有序集合范围"],
  ["ZREM", "key member [member ...]", "删除有序集合成员"], ["ZSCORE", "key member", "读取成员分数"], ["ZCARD", "key", "读取有序集合大小"],
  ["SCAN", "cursor [MATCH pattern] [COUNT count]", "扫描键"], ["HSCAN", "key cursor [MATCH pattern] [COUNT count]", "扫描哈希"],
  ["SSCAN", "key cursor [MATCH pattern] [COUNT count]", "扫描集合"], ["ZSCAN", "key cursor [MATCH pattern] [COUNT count]", "扫描有序集合"],
  ["PING", "[message]", "检查连接"], ["INFO", "[section]", "读取服务器信息"], ["DBSIZE", "", "读取键数量"],
  ["SELECT", "index", "切换数据库"], ["RENAME", "key newkey", "重命名键"], ["RENAMENX", "key newkey", "仅在目标不存在时重命名"],
  ["KEYS", "pattern", "按模式列出所有 Key（控制台可用，大实例建议 SCAN）"],
  ["MULTI", "", "开始事务"], ["EXEC", "", "执行事务队列"], ["DISCARD", "", "放弃事务队列"],
  ["WATCH", "key [key ...]", "监视 Key"], ["UNWATCH", "", "取消监视"],
  ["MEMORY", "USAGE key | STATS", "查看内存用量"], ["OBJECT", "ENCODING key | IDLETIME key", "查看对象信息"],
  ["HEXISTS", "key field", "检查哈希字段"], ["XLEN", "key", "读取流长度"],
  ["XADD", "key ID field value [field value ...]", "添加流消息"], ["XRANGE", "key start end [COUNT count]", "读取流消息"],
];
export const redisCompletions = commands.map(([label, detail, info]) => ({ label, detail, info, type: "keyword" }));
export function redisCommandHint(text) {
  const name = text.trimStart().split(/\s/)[0].toUpperCase();
  const item = redisCompletions.find((item) => item.label === name);
  return item ? `${item.label} ${item.detail} · ${item.info}` : "";
}
export function redisCommandCandidates(text, pos = text.length) {
  const line = text.slice(0, pos).split("\n").at(-1);
  const match = line.match(/^\s*([a-z]*)$/i);
  return match ? redisCompletions.filter((item) => item.label.startsWith(match[1].toUpperCase())) : [];
}

const keyCommands = new Set("GET SET MGET MSET DEL UNLINK EXISTS TYPE TTL PTTL EXPIRE PERSIST INCR DECR INCRBY APPEND STRLEN HGET HSET HGETALL HDEL HKEYS HLEN LPUSH RPUSH LRANGE LLEN LPOP RPOP SADD SMEMBERS SREM SCARD SISMEMBER ZADD ZRANGE ZREM ZSCORE ZCARD HSCAN SSCAN ZSCAN RENAME RENAMENX XADD XRANGE".split(" "));
const writeCommands = new Set("SET MSET DEL UNLINK EXPIRE PERSIST INCR DECR INCRBY APPEND HSET HDEL LPUSH RPUSH LPOP RPOP SADD SREM ZADD ZREM RENAME RENAMENX XADD".split(" "));
function completionInfo(item) {
  return () => {
    const dom = document.createElement("div");
    dom.className = "redis-completion-info";
    const title = document.createElement("strong"); title.textContent = item.label;
    const badge = document.createElement("span"); badge.className = "redis-command-kind";
    badge.textContent = writeCommands.has(item.label) ? "写入" : "读取 / 管理";
    const usage = document.createElement("code"); usage.textContent = `${item.label} ${item.detail}`;
    const description = document.createElement("p"); description.textContent = item.info;
    dom.append(title, badge, usage, description);
    return { dom };
  };
}
export function quoteRedisArgument(value) {
  return /[\s"'\\]/.test(value) ? '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"' : value;
}
export function redisCompletionSource(context, keys = []) {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.sliceDoc(line.from, context.pos);
  const command = before.match(/^\s*([a-z]*)$/i);
  if (command) {
    if (!command[1] && !context.explicit) return null;
    return { from: context.pos - command[1].length, validFor: /^[a-z]*$/i,
      options: redisCompletions.map(item => ({ label: item.label, type: "keyword", detail: item.info, info: completionInfo(item) })) };
  }
  const argument = before.match(/^\s*([a-z]+)\s+([^\s"']*)$/i);
  if (!argument || !keyCommands.has(argument[1].toUpperCase())) return null;
  const prefix = argument[2];
  return { from: context.pos - prefix.length, validFor: /^[^\s"']*$/,
    options: [...new Set(keys)].slice(0, 1000).map(key => ({ label: key, type: "variable", detail: "当前 DB 的 Key", apply: quoteRedisArgument(key) })) };
}
