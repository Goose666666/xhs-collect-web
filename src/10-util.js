// 取值和转换的小工具。
//
// 采回来的字段经常缺，或者该是数字的地方给了字符串，所以一律走这几个函数。
// 坏数据只会变成空串和 0，不会让整批数据存不进去。

function asText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

// 小红书把点赞数写成 1.2万 这种，直接 parseInt 会读成 1。
function asInt(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  if (!s) return 0;
  // 千分位逗号要先去掉，不然正则匹到逗号就停，1,234 会读成 1
  const lower = s.toLowerCase().replace(/[,，\s]/g, '');
  const mult = lower.includes('亿')
    ? 100000000
    : (lower.includes('万') || lower.includes('w') ? 10000 : 1);
  const m = lower.match(/[0-9]+(\.[0-9]+)?/);
  if (!m) return 0;
  return Math.round(parseFloat(m[0]) * mult);
}

// 平台缺省算小红书。留空的话按哪个平台筛都筛不出来，等于凭空消失。
function asSite(v) {
  const s = asText(v);
  return s || '小红书';
}

// 行业缺省算找对象。加这一列之前采的数据没记行业。
function asTrade(v) {
  const s = asText(v);
  return s || 'love';
}

function p2(v) {
  return String(v).padStart(2, '0');
}

// 时间统一按东八区写，跟手机版和电脑版一个格式。
//
// 不跟着设备时区走，是因为出国或者改了系统时区之后，存进去的时间会跟
// 另外两端对不上，按天分组的统计就全乱了。
function nowCst() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + p2(t.getUTCMonth() + 1) + '-' +
    p2(t.getUTCDate()) + ' ' + p2(t.getUTCHours()) + ':' +
    p2(t.getUTCMinutes()) + ':' + p2(t.getUTCSeconds());
}

function todayCst() {
  return nowCst().slice(0, 10);
}

// 时间戳转北京时间字符串。
//
// 接口给的可能是毫秒、秒，也可能已经是排好版的文字，最后那种原样留着。
function tsToStr(v) {
  const s = asText(v).trim();
  if (!s) return '';
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  let ms = Math.trunc(n);
  if (ms <= 0) return '';
  if (ms <= 10000000000) ms *= 1000;
  const t = new Date(ms + 8 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + p2(t.getUTCMonth() + 1) + '-' +
    p2(t.getUTCDate()) + ' ' + p2(t.getUTCHours()) + ':' +
    p2(t.getUTCMinutes()) + ':' + p2(t.getUTCSeconds());
}

function isMap(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mapOf(v) {
  return isMap(v) ? v : {};
}

function listOf(v) {
  return Array.isArray(v) ? v : [];
}

// 按给定顺序挨个试键名，返回第一个非空值。
function firstOf(m, keys) {
  for (const k of keys) {
    const s = asText(m[k]).trim();
    if (s) return s;
  }
  return '';
}

function truthy(v) {
  if (typeof v === 'boolean') return v;
  const s = asText(v).toLowerCase();
  return s === 'true' || s === '1';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(a, b) {
  return b <= a ? a : a + Math.floor(Math.random() * (b - a + 1));
}

// 一段文字裁到多少个字，超出的补省略号。
function head(s, n) {
  const t = asText(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

function esc(s) {
  return asText(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
