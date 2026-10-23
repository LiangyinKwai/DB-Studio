// Type text remains readable without color; external Redis TYPE strings never enter markup.
const definitions = {
  string: {
    label: 'String · 字符串', description: '字符串 / 二进制值',
  },
  hash: {
    label: 'Hash · 哈希', description: '字段与值的映射',
  },
  list: {
    label: 'List · 列表', description: '按顺序排列的元素',
  },
  set: {
    label: 'Set · 集合', description: '不重复的无序元素',
  },
  zset: {
    label: 'ZSet · 有序集合', description: '按分数排序的不重复元素',
  },
  stream: {
    label: 'Stream · 消息流', description: '按 ID 排列的消息序列',
  },
  unknown: {
    label: 'Redis Key · 类型待加载', description: '尚未获取类型',
  },
  missing: {
    label: 'Redis Key · 已不存在', description: 'Key 已过期或被删除',
  },
  module: {
    label: 'Redis Key · 扩展类型', description: '由 Redis 模块提供的数据类型',
  },
};

const presentations = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([type, { label, description }]) => [
  type,
  Object.freeze({
    type, label, description,
    icon: `<span class="redis-key-icon redis-key-icon--${type}" role="img" aria-label="${label}" title="${label}">${({ unknown: '?', missing: '失效', module: 'module' })[type] || type}</span>`,
  }),
])));

/** Redis built-in TYPE names are case-insensitive here. Unrecognized module types use a safe fallback. */
export function redisKeyTypePresentation(type) {
  const normalized = typeof type === 'string' ? type.trim().toLowerCase() : '';
  const knownType = Object.hasOwn(presentations, normalized) ? normalized
    : normalized === 'none' ? 'missing'
      : normalized ? 'module' : 'unknown';
  return presentations[knownType];
}

export function redisKeyIcon(type) {
  return redisKeyTypePresentation(type).icon;
}
