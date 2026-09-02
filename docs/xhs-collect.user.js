// ==UserScript==
// @name         获客助手
// @namespace    https://github.com/Goose666666/xhs-collect-web
// @version      1.0.0
// @description  在小红书页面里采集帖子和评论，挑出想找对象的人，生成能直接发的私信
// @author       xhs-collect-web
// @match        https://www.xiaohongshu.com/*
// @match        https://xiaohongshu.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// @downloadURL  https://goose666666.github.io/xhs-collect-web/xhs-collect.user.js
// @updateURL    https://goose666666.github.io/xhs-collect-web/xhs-collect.user.js
// ==/UserScript==

(function () {
'use strict';

// ===== 10-util.js =====
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


// ===== 20-parse.js =====
// 把钩到的接口 JSON 拆成笔记和评论。
//
// 规则照搬手机版 lib/local/parse.dart，字段名和取值顺序都一致，
// 网页版采的数据可以直接跟手机版和电脑版的合并。
//
// 同一份数据在不同接口里的形状不一样：搜索只给摘要，详情才给正文和原图，
// 页面里那份还把字段名换成了小驼峰。所以取值一律走 firstOf 这类兜底函数，
// 挨个试几种可能的键名，缺一个字段只会留空，不会把整条数据丢掉。

// 接口路径片段到桶名的映射。
//
// 片段里不写版本号，匹配前先把 /v1/ /v2/ 抹掉。小红书会悄悄给接口升版本，
// 搜索就从 v1 改成过 v2，写死版本号会导致一条都收不到，
// 而且表现是搜索永远 0 篇，看日志根本看不出是路径对不上。
//
// 顺序有讲究，homefeed 要排在 feed 前面，否则会被 feed 先接走。
const kRoutes = [
  ['/search/notes', 'search'],
  ['/homefeed', 'homefeed'],
  ['/comment/sub/page', 'sub_comment'],
  ['/comment/page', 'comment'],
  ['/comment/post', 'comment_post'],
  ['/user_posted', 'user_posted'],
  ['/user/otherinfo', 'user_info'],
  ['/feed', 'feed'],
];

// 判断一个 url 属于哪类接口，不认识返回空串。
function bucketOf(url) {
  const path = asText(url).split('?')[0].replace(/\/v\d+\//g, '/');
  for (const [frag, name] of kRoutes) {
    if (path.includes(frag)) return name;
  }
  return '';
}

// 从 url 上取查询参数。
//
// 不用 URL 这个类，是因为钩到的地址偶尔带没转义的字符，构造时会抛。
function queryOf(url) {
  const i = asText(url).indexOf('?');
  if (i < 0) return {};
  const out = {};
  for (const pair of url.slice(i + 1).split('&')) {
    const j = pair.indexOf('=');
    if (j <= 0) continue;
    let value = pair.slice(j + 1);
    try {
      value = decodeURIComponent(value);
    } catch (e) {
      // 转义坏了就用原样的值，总比整条参数丢掉强
    }
    if (value) out[pair.slice(0, j)] = value;
  }
  return out;
}

// 从评论接口的地址里取笔记 id。
//
// 评论接口的返回里不一定带笔记 id，但地址上一定有，用它把评论挂回笔记。
function noteIdInUrl(url) {
  const s = asText(url);
  let i = s.indexOf('note_id=');
  let skip = 8;
  if (i < 0) {
    i = s.indexOf('aweme_id=');
    skip = 9;
  }
  if (i < 0) return '';
  const rest = s.slice(i + skip);
  const m = rest.match(/[&#]/);
  return m ? rest.slice(0, m.index) : rest;
}

// 正文里的话题写成 #脱单[话题]# 这种样子，把那个尾巴去掉只留 #脱单。
// 不清的话人页的自述里满屏都是方括号，读起来很费劲。
function plainText(s) {
  return asText(s).replace(/\[话题\]#/g, '').trim();
}

// 一次拦截的解析结果。空结果长这样：
// { kind: '', notes: [], comments: [], hasMore: false, cursor: '' }
function emptyResult() {
  return { kind: '', notes: [], comments: [], hasMore: false, cursor: '' };
}

// 总入口：给一条钩到的 url 和响应正文，自动判断类型并解析。
//
// 任何一步出岔子都返回空结果而不是抛异常，因为这个函数跑在钩子回调里，
// 抛出去会把整个采集流程打断，而坏响应本来就是常态。
function parseCaptured(url, body, keyword) {
  if (!bucketOf(url)) return emptyResult();
  let decoded;
  try {
    decoded = JSON.parse(body);
  } catch (e) {
    return emptyResult();
  }
  if (!isMap(decoded)) return emptyResult();
  return parsePayload(url, decoded, keyword || '');
}

// 已经解码好的 JSON 走这里。测试和页面里那份 __INITIAL_STATE__ 都用得上。
function parsePayload(url, payload, keyword) {
  const kind = bucketOf(url);
  const q = queryOf(url);
  const data = mapOf(payload.data);
  const hasMore = truthy(data.has_more !== undefined ? data.has_more : data.hasMore);
  const cursor = firstOf(data, ['cursor', 'cursor_score']);
  const out = { kind: kind, notes: [], comments: [], hasMore: hasMore, cursor: cursor };

  switch (kind) {
    case 'search':
      out.notes = parseSearch(payload, keyword);
      return out;
    case 'homefeed':
    case 'feed':
      // 详情接口的响应里常常没有 xsec_token，但请求 url 上带着，
      // 少了它拼出来的笔记链接打不开，所以从 url 上取一份兜底。
      out.notes = parseFeed(payload, q.xsec_token || '', keyword);
      return out;
    case 'comment':
      out.comments = parseComments(payload, q.note_id || '');
      return out;
    case 'sub_comment':
      out.comments = parseSubComments(payload, q.note_id || '', q.root_comment_id || '');
      return out;
    case 'user_posted':
      out.notes = parseUserPosted(payload, keyword);
      return out;
    default:
      // 认识路径但没有可入库的内容，比如发评论和博主资料。
      // 仍然把 kind 带出去，调用方才能知道这次操作有没有走通。
      return out;
  }
}

// ---------- 笔记 ----------

// 解析搜索接口。只有摘要字段，正文要再进详情页拿。
function parseSearch(payload, keyword) {
  const out = [];
  for (const raw of listOf(mapOf(payload.data).items)) {
    const item = mapOf(raw);
    // 搜索结果里混着搜索建议、话题卡这些非笔记项，收进来就是脏数据。
    // model_type 缺失的按笔记算，老接口不带这个字段。
    const type = asText(item.model_type !== undefined ? item.model_type : item.modelType);
    if (type && type !== 'note') continue;
    const nc = mapOf(item.note_card !== undefined ? item.note_card : item.noteCard);
    if (!Object.keys(nc).length) continue;
    const note = buildNote(item, nc, { keyword: keyword });
    if (note) out.push(note);
  }
  return out;
}

// 解析笔记详情和首页推荐。字段最全，含正文、话题、图片原图。
function parseFeed(payload, xsecToken, keyword) {
  const out = [];
  for (const raw of listOf(mapOf(payload.data).items)) {
    const item = mapOf(raw);
    const nc = mapOf(item.note_card !== undefined ? item.note_card : item.noteCard);
    if (!Object.keys(nc).length) continue;
    const note = buildNote(item, nc, { xsecToken: xsecToken, keyword: keyword });
    if (note) out.push(note);
  }
  return out;
}

// 解析博主主页的笔记列表接口。列表项本身就是笔记卡，没有外层 note_card。
function parseUserPosted(payload, keyword) {
  const out = [];
  for (const raw of listOf(mapOf(payload.data).notes)) {
    const nc = mapOf(raw);
    if (!Object.keys(nc).length) continue;
    const note = buildNote({}, nc, { source: 'pc_user', keyword: keyword });
    if (note) out.push(note);
  }
  return out;
}

// 解析页面里那份笔记数据，字段名是小驼峰。
//
// 小红书把笔记详情接口撤了以后，正文只剩 __INITIAL_STATE__ 里这一份。
// 拍成和 parseFeed 一样的形状，上层就不用分两种情况处理。
function parseNoteState(note, xsecToken, keyword) {
  if (!isMap(note) || !Object.keys(note).length) return null;
  return buildNote({}, note, { xsecToken: xsecToken || '', keyword: keyword || '' });
}

// 各接口的笔记卡最后都汇到这里，键名的几种写法在这一处兜住。
function buildNote(item, nc, opt) {
  const o = opt || {};
  let noteId = firstOf(nc, ['note_id', 'noteId']);
  if (!noteId) noteId = firstOf(item, ['id']);
  // 没有 id 的笔记入不了库，主键是它。
  if (!noteId) return null;

  const fromItem = firstOf(item, ['xsec_token', 'xsecToken']);
  const fromCard = firstOf(nc, ['xsec_token', 'xsecToken']);
  const token = o.xsecToken ? o.xsecToken : (fromItem || fromCard);

  const user = mapOf(nc.user);
  const inter = mapOf(nc.interact_info !== undefined ? nc.interact_info : nc.interactInfo);
  const imgs = pickImages(nc);
  const tags = [];
  for (const t of listOf(nc.tag_list !== undefined ? nc.tag_list : nc.tagList)) {
    const name = firstOf(mapOf(t), ['name']);
    if (name) tags.push(name);
  }

  // 搜索给的是 cover.url_default，详情不给 cover 只给图片列表，两边都试。
  let cover = firstOf(mapOf(nc.cover), ['url_default', 'urlDefault', 'url']);
  if (!cover && imgs.length) cover = imgs[0];

  return {
    note_id: noteId,
    title: firstOf(nc, ['title', 'display_title', 'displayTitle']),
    content: plainText(firstOf(nc, ['desc'])),
    topics: tags.join(' '),
    author_id: firstOf(user, ['user_id', 'userId', 'id']),
    author_name: firstOf(user, ['nickname', 'nick_name', 'nickName']),
    likes: asInt(inter.liked_count !== undefined ? inter.liked_count : inter.likedCount),
    comment_cnt: asInt(inter.comment_count !== undefined ? inter.comment_count : inter.commentCount),
    ip_location: firstOf(nc, ['ip_location', 'ipLocation']),
    publish_time: tsToStr(nc.time),
    note_url: buildNoteUrl(noteId, token, o.source || 'pc_search'),
    xsec_token: token,
    cover: cover,
    images: imgs.join(' | '),
    keyword: o.keyword || '',
    fetched_at: nowCst(),
    site: '小红书',
    trade: 'love',
  };
}

// 取图片链接，优先原图。列表里默认那张常常是压过的预览图。
function pickImages(nc) {
  const out = [];
  for (const raw of listOf(nc.image_list !== undefined ? nc.image_list : nc.imageList)) {
    const img = mapOf(raw);
    let best = firstOf(img, ['url_default', 'urlDefault', 'url']);
    for (const rawInfo of listOf(img.info_list !== undefined ? img.info_list : img.infoList)) {
      const info = mapOf(rawInfo);
      const scene = firstOf(info, ['image_scene', 'imageScene']);
      const url = firstOf(info, ['url']);
      if (url && (scene === 'WB_DFT' || scene === 'CRD_PRV_WEBP')) {
        best = url;
        break;
      }
    }
    if (best) out.push(best);
  }
  return out;
}

// 拼笔记链接。
//
// 没有 xsec_token 的链接会被跳去登录页，等于打不开，所以带上才算完整。
function buildNoteUrl(noteId, xsecToken, source) {
  if (!noteId) return '';
  const base = 'https://www.xiaohongshu.com/explore/';
  if (!xsecToken) return base + noteId;
  return base + noteId + '?xsec_token=' + xsecToken +
    '&xsec_source=' + (source || 'pc_search');
}

// 博主主页链接。
function buildUserUrl(userId) {
  return userId ? 'https://www.xiaohongshu.com/user/profile/' + userId : '';
}

// 搜索结果页的地址。关键词必须整体转义，中文和空格直接拼进去会拼出一个打不开的地址。
function searchUrl(keyword) {
  return 'https://www.xiaohongshu.com/search_result?keyword=' +
    encodeURIComponent(asText(keyword).trim()) + '&source=web_explore_feed';
}

// ---------- 评论 ----------

// 解析评论接口。一级评论里内嵌的前几条二级评论也一起收，拍成平铺一层。
//
// 平铺是为了直接入库，父子关系靠 parent_id 和 level 两列表示。
function parseComments(payload, noteId) {
  const out = [];
  for (const raw of listOf(mapOf(payload.data).comments)) {
    const c = mapOf(raw);
    const one = buildComment(c, noteId, '');
    if (!one) continue;
    out.push(one);
    for (const rawSub of listOf(c.sub_comments !== undefined ? c.sub_comments : c.subComments)) {
      const sub = buildComment(mapOf(rawSub), noteId, one.comment_id);
      if (sub) out.push(sub);
    }
  }
  return out;
}

// 解析二级评论翻页接口。
function parseSubComments(payload, noteId, parentId) {
  const out = [];
  for (const raw of listOf(mapOf(payload.data).comments)) {
    const c = mapOf(raw);
    // 翻页请求 url 上的 root_comment_id 最可靠，没有再看响应里的 target_comment。
    const pid = parentId ||
      firstOf(mapOf(c.target_comment !== undefined ? c.target_comment : c.targetComment), ['id']);
    const one = buildComment(c, noteId, pid);
    if (one) out.push(one);
  }
  return out;
}

function buildComment(c, noteId, parentId) {
  const id = firstOf(c, ['id', 'comment_id', 'commentId']);
  // 没有 id 的评论入不了库，主键是它。
  if (!id) return null;
  const u = mapOf(c.user_info !== undefined ? c.user_info : c.userInfo);
  return {
    comment_id: id,
    note_id: noteId || firstOf(c, ['note_id', 'noteId']),
    parent_id: parentId || '',
    level: parentId ? '二级' : '一级',
    // 换行会把导出的 CSV 撑成多行，存之前先压成空格。
    content: firstOf(c, ['content']).replace(/\n/g, ' '),
    nickname: firstOf(u, ['nickname', 'nick_name', 'nickName']),
    user_id: firstOf(u, ['user_id', 'userId', 'id']),
    likes: asInt(c.like_count !== undefined ? c.like_count : c.likeCount),
    sub_count: asInt(c.sub_comment_count !== undefined ? c.sub_comment_count : c.subCommentCount),
    comment_time: tsToStr(c.create_time !== undefined ? c.create_time : c.createTime),
    ip_location: firstOf(c, ['ip_location', 'ipLocation']),
    fetched_at: nowCst(),
    site: '小红书',
    trade: 'love',
  };
}


// ===== 30-store.js =====
// 本地库。存在浏览器的 IndexedDB 里，不上传任何地方。
//
// 表名和列名照抄手机版 lib/local/db.dart，所以导出来的文件跟手机版、
// 电脑版是同一套字段，三边的数据能直接合并。
//
// 数据量就是几千条，读全表再在内存里筛完全够用，不做索引查询，
// 省下一大堆游标代码，出错的地方也少。

const DB_NAME = 'xhs_leads';
const DB_VERSION = 1;

// 一行数据存在哪张表，以及主键是哪一列。
const STORES = {
  notes: 'note_id',
  comments: 'comment_id',
  keywords: 'id',
  settings: 'k',
  tasks: 'id',
  touches: 'id',
  job: 'id',
};

let _db = null;

// 拿连接。多处同时调用只会真正打开一次。
function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const [name, key] of Object.entries(STORES)) {
        if (d.objectStoreNames.contains(name)) continue;
        // 任务和触达没有天然主键，让库自己发号
        if (name === 'tasks' || name === 'touches') {
          d.createObjectStore(name, { keyPath: key, autoIncrement: true });
        } else {
          d.createObjectStore(name, { keyPath: key });
        }
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return openDb().then((d) => d.transaction(store, mode).objectStore(store));
}

function req2promise(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function getAll(store) {
  const s = await tx(store, 'readonly');
  return (await req2promise(s.getAll())) || [];
}

async function getOne(store, key) {
  const s = await tx(store, 'readonly');
  return await req2promise(s.get(key));
}

async function putOne(store, row) {
  const s = await tx(store, 'readwrite');
  return await req2promise(s.put(row));
}

// 一批一起写。一条一条提交，几百条评论在手机上慢到肉眼可见。
async function putMany(store, rows) {
  if (!rows.length) return 0;
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const r of rows) s.put(r);
    t.oncomplete = () => resolve(rows.length);
    t.onerror = () => reject(t.error);
  });
}

async function clearStore(store) {
  const s = await tx(store, 'readwrite');
  return await req2promise(s.clear());
}

// ---------- 设置 ----------

async function getSetting(k, dflt) {
  const row = await getOne('settings', k);
  if (!row || row.v === undefined || row.v === null) return dflt;
  return row.v;
}

async function setSetting(k, v) {
  return putOne('settings', { k: k, v: v });
}

// ---------- 笔记和评论 ----------

// 存笔记，返回真正新增的条数。
//
// 已经有的会被覆盖，因为详情比搜索摘要字段全，重采一次是在补全，不是在重复。
// 但计数只算新的，不然界面上的笔记数会随着重采一直涨。
async function saveNotes(rows, keyword, site, trade) {
  if (!rows.length) return 0;
  const s = await tx('notes', 'readonly');
  const have = new Set((await req2promise(s.getAllKeys())) || []);
  const out = [];
  let fresh = 0;
  for (const r of rows) {
    if (!r || !r.note_id) continue;
    const row = Object.assign({}, r);
    if (keyword) row.keyword = keyword;
    row.site = asSite(site || row.site);
    row.trade = asTrade(trade || row.trade);
    if (!have.has(row.note_id)) fresh += 1;
    out.push(row);
  }
  await putMany('notes', out);
  return fresh;
}

// 存评论，返回真正新增的条数。界面上说的新评论就是这个数。
async function saveComments(rows, site, trade) {
  if (!rows.length) return 0;
  const s = await tx('comments', 'readonly');
  const have = new Set((await req2promise(s.getAllKeys())) || []);
  const out = [];
  let fresh = 0;
  for (const r of rows) {
    if (!r || !r.comment_id) continue;
    const row = Object.assign({}, r);
    row.site = asSite(site || row.site);
    row.trade = asTrade(trade || row.trade);
    if (!have.has(row.comment_id)) fresh += 1;
    out.push(row);
  }
  await putMany('comments', out);
  return fresh;
}

// ---------- 关键词 ----------

function keywordId(word, trade) {
  return asText(word) + '|' + asTrade(trade);
}

async function listKeywords(trade) {
  const all = await getAll('keywords');
  const t = asTrade(trade);
  return all.filter((r) => asTrade(r.trade) === t);
}

async function saveKeyword(word, trade, enabled) {
  const w = asText(word).trim();
  if (!w) return;
  const id = keywordId(w, trade);
  const old = await getOne('keywords', id);
  await putOne('keywords', {
    id: id,
    word: w,
    trade: asTrade(trade),
    enabled: enabled === false ? 0 : 1,
    last_run: old ? old.last_run || '' : '',
  });
}

async function removeKeyword(word, trade) {
  const s = await tx('keywords', 'readwrite');
  return await req2promise(s.delete(keywordId(word, trade)));
}

async function markKeywordRun(word, trade) {
  const id = keywordId(word, trade);
  const old = await getOne('keywords', id);
  if (!old) return;
  old.last_run = nowCst();
  await putOne('keywords', old);
}

// ---------- 人 ----------

// 帖主和评论者拼成一张名单，用 kind 区分两类。
//
// 自述各取各的：帖主是标题加正文，评论者是留言原文。
// 属地也各取各的，帖主用笔记的属地，评论者用自己那条评论的属地。
async function listPeople(filter) {
  const f = filter || {};
  const notes = await getAll('notes');
  const comments = await getAll('comments');
  const byId = {};
  for (const n of notes) byId[n.note_id] = n;

  const out = [];
  for (const n of notes) {
    if (!n.author_id) continue;
    const title = asText(n.title);
    const content = asText(n.content);
    // 抖音的标题就是正文第一行，直接拼会把开头念两遍。
    // 正文已经以标题打头的话，只留正文。
    const said = content && title && content.indexOf(title) === 0
      ? content
      : (title + ' ' + content).trim();
    out.push({
      kind: '帖主',
      user_id: n.author_id,
      nickname: n.author_name,
      ip_location: n.ip_location,
      said: said,
      ts: n.publish_time,
      likes: asInt(n.likes),
      note_id: n.note_id,
      xsec_token: n.xsec_token,
      note_title: title,
      note_url: n.note_url,
      keyword: n.keyword,
      comment_id: '',
      site: asSite(n.site),
      trade: asTrade(n.trade),
    });
  }
  for (const c of comments) {
    if (!c.user_id) continue;
    const n = byId[c.note_id] || {};
    out.push({
      kind: '评论者',
      user_id: c.user_id,
      nickname: c.nickname,
      ip_location: c.ip_location,
      said: asText(c.content),
      ts: c.comment_time,
      likes: asInt(c.likes),
      note_id: c.note_id,
      xsec_token: n.xsec_token || '',
      note_title: asText(n.title),
      note_url: n.note_url || '',
      keyword: asText(n.keyword),
      comment_id: c.comment_id,
      site: asSite(c.site),
      trade: asTrade(c.trade),
    });
  }
  return filterPeople(out, f);
}

function filterPeople(rows, f) {
  let out = rows;
  if (f.kind) out = out.filter((r) => r.kind === f.kind);
  if (f.site) out = out.filter((r) => r.site === f.site);
  if (f.trade) out = out.filter((r) => r.trade === f.trade);
  if (f.city) out = out.filter((r) => r.ip_location === f.city);
  if (f.keyword) out = out.filter((r) => r.keyword === f.keyword);
  if (f.search) {
    const q = f.search;
    out = out.filter((r) => r.said.includes(q) || asText(r.nickname).includes(q));
  }
  const order = f.order || 'likes';
  const cmp = {
    likes: (a, b) => b.likes - a.likes,
    time: (a, b) => asText(b.ts).localeCompare(asText(a.ts)),
    long: (a, b) => b.said.length - a.said.length,
  }[order] || ((a, b) => b.likes - a.likes);
  return out.slice().sort(cmp);
}

// ---------- 发过谁 ----------

async function addTouch(row) {
  const r = Object.assign({ created_at: nowCst() }, row);
  delete r.id;
  return putOne('touches', r);
}

async function listTouches() {
  const all = await getAll('touches');
  return all.sort((a, b) => asText(b.created_at).localeCompare(asText(a.created_at)));
}

// 拉黑过的人。发私信前要跳过他们。
async function blockedIds() {
  const all = await getAll('touches');
  const out = new Set();
  for (const t of all) {
    if (t.kind === '拉黑' && t.user_id) out.add(t.user_id);
  }
  return out;
}

// ---------- 任务 ----------

async function newTask(kind, keyword, params) {
  const s = await tx('tasks', 'readwrite');
  return await req2promise(s.add({
    kind: kind,
    keyword: keyword,
    params: JSON.stringify(params || {}),
    status: '运行中',
    note_cnt: 0,
    comment_cnt: 0,
    log: '',
    created_at: nowCst(),
    finished_at: '',
  }));
}

async function finishTask(id, status, noteCnt, commentCnt) {
  if (!id) return;
  const row = await getOne('tasks', id);
  if (!row) return;
  row.status = status;
  if (noteCnt !== undefined && noteCnt !== null) row.note_cnt = noteCnt;
  if (commentCnt !== undefined && commentCnt !== null) row.comment_cnt = commentCnt;
  if (status !== '运行中') row.finished_at = nowCst();
  await putOne('tasks', row);
}

// ---------- 采集状态 ----------
//
// 网页版跟手机版最大的不同在这儿。手机版的采集跑在一个不会消失的对象里，
// 网页版每打开一篇笔记就是一次真正的页面跳转，脚本会被整个重新加载，
// 内存里的东西全没。所以每走一步都要把进度写回库里，
// 下一个页面起来之后再读回去接着跑。

const JOB_KEY = 'job';

async function getJob() {
  return await getOne('job', JOB_KEY);
}

async function setJob(job) {
  const row = Object.assign({}, job, { id: JOB_KEY });
  await putOne('job', row);
  return row;
}

async function clearJob() {
  const s = await tx('job', 'readwrite');
  return await req2promise(s.delete(JOB_KEY));
}

// ---------- 导出和清空 ----------

// 整库导出成一份 JSON。拿去电脑上看，或者换台设备接着用。
async function exportAll() {
  const out = { version: 1, exported_at: nowCst(), tables: {} };
  for (const name of ['notes', 'comments', 'keywords', 'settings', 'tasks', 'touches']) {
    out.tables[name] = await getAll(name);
  }
  return out;
}

// 导入一份 JSON。同主键的覆盖，别的留着，所以两台设备的数据能合到一起。
async function importAll(data) {
  const tables = mapOf(mapOf(data).tables);
  let n = 0;
  for (const name of ['notes', 'comments', 'keywords', 'settings', 'tasks', 'touches']) {
    const rows = listOf(tables[name]);
    if (!rows.length) continue;
    // 自增主键的表，导进来的 id 可能跟本地撞车，去掉让库重新发号
    const clean = (name === 'tasks' || name === 'touches')
      ? rows.map((r) => {
        const c = Object.assign({}, r);
        delete c.id;
        return c;
      })
      : rows;
    if (name === 'tasks' || name === 'touches') {
      const d = await openDb();
      await new Promise((resolve, reject) => {
        const t = d.transaction(name, 'readwrite');
        const s = t.objectStore(name);
        for (const r of clean) s.add(r);
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    } else {
      await putMany(name, clean);
    }
    n += clean.length;
  }
  return n;
}

// 清数据。只清采到的东西，设置和关键词留着。
async function clearData() {
  await clearStore('notes');
  await clearStore('comments');
  await clearStore('tasks');
}

async function counts() {
  const notes = await getAll('notes');
  const comments = await getAll('comments');
  return { notes: notes.length, comments: comments.length };
}


// ===== 40-industry.js =====
// 做哪个行业。
//
// 这套东西本来是照找对象写死的：搜什么词、话术怎么生成、什么样的人算有意向，
// 全都埋在代码里。但同一套流程换个行业照样成立，美容搜手拍水光、
// 情感搜挽回前任，做的事情是一样的：找到聊这个话题的帖子，
// 在评论区留话，等人来私信。
//
// 所以把行业相关的东西抽成一份配置。换行业就是换一份配置，不用改代码。
// 内容跟手机版 lib/local/industry.dart 逐条对齐。

const allIndustries = [
  {
    key: 'love',
    name: '找对象',
    about: '在相亲和脱单话题下找想找对象的人',
    keywords: [
      '脱单', '找对象', '相亲', '恋爱', '异地恋', '单身',
      '情感咨询', '挽回', '找男朋友', '女生找对象',
    ],
    talks: [
      '同城的可以聊聊，我这边认识不少靠谱的',
      '看你条件挺好的，我这边有合适的人选',
      '有想认识的可以私信我，帮你介绍',
    ],
    wantWords: [],
  },
  {
    key: 'beauty',
    name: '医美',
    about: '在医美和护肤话题下找想做项目的人',
    keywords: [
      '#手拍水光', '#水光针', '#热玛吉', '#超声炮', '#光子嫩肤',
      '医美避坑', '皮肤管理', '抗衰', '祛痘',
    ],
    talks: [
      '这个项目我做过，有问题可以私信问我',
      '同城的话我可以推荐个靠谱的地方',
      '想了解价格和恢复期的可以找我聊',
    ],
    wantWords: [
      '想做', '求推荐', '哪家', '多少钱', '价格', '效果怎么样',
      '有没有做过', '踩坑', '避雷',
    ],
  },
  {
    key: 'emotion',
    name: '情感咨询',
    about: '在挽回和情感困惑话题下找需要咨询的人',
    keywords: [
      '#挽回前任', '#情感挽回', '分手复合', '冷暴力', '异地恋',
      '婚姻问题', '情感困惑', '前任',
    ],
    talks: [
      '这种情况我遇到过，可以私信聊聊',
      '想聊的可以找我，帮你分析一下',
      '有类似经历，需要的话私信我',
    ],
    wantWords: [
      '怎么办', '求助', '有没有办法', '想挽回', '还有机会吗',
      '求分析', '好难受', '不知道该',
    ],
  },
  {
    key: 'friend',
    name: '交友',
    about: '在同城和兴趣话题下找想认识人的人',
    keywords: [
      '#同城交友', '#找搭子', '找饭搭子', '找旅游搭子', '找运动搭子',
      '扩列', '交个朋友',
    ],
    talks: [
      '同城的可以加个好友，一起玩',
      '我也在找搭子，私信聊聊',
      '有兴趣的私信我，拉你进群',
    ],
    wantWords: [
      '求搭子', '找搭子', '一起', '有没有人', '加我', '扩列',
      '想认识', '同城',
    ],
  },
];

function industryOf(key) {
  return allIndustries.find((i) => i.key === key) || allIndustries[0];
}

// 当前在做哪个行业。判意向和出话术都要看它。
const Trade = {
  now: allIndustries[0],

  async load() {
    Trade.now = industryOf(asText(await getSetting('industry', 'love')));
    return Trade.now;
  },

  async switchTo(key) {
    Trade.now = industryOf(key);
    await setSetting('industry', Trade.now.key);
    return Trade.now;
  },
};


// ===== 45-limits.js =====
// 采多少篇，用多长时间采完。
//
// 不设每小时每天的上限，因为真人本来就不是均匀刷的。刷到一批感兴趣的帖子
// 连着翻二十分钟，然后放下手机，这才是正常节奏。全天每五分钟准时翻一篇，
// 反倒一眼就是机器。
//
// 所以只设两个数：这一轮采几篇，用多久采完。中间的间隔由程序随机切，
// 每段长短不一，采完就停。这跟手机版 lib/local/limits.dart 是同一套算法。

const kCrawlSizeDefault = 50;
const kCrawlSizeMin = 5;
const kCrawlSizeMax = 300;

const kCrawlMinutesDefault = 30;
const kCrawlMinutesMin = 5;
const kCrawlMinutesMax = 480;

// 两篇之间至少隔多少秒。
//
// 不是为了慢，是防止翻得比页面加载还快，那样评论根本来不及渲染，
// 抓回来全是空的。采集只是看，不留痕，所以可以比发东西快得多。
const kCrawlMinGapSeconds = 3;

const Limits = {
  crawlSize: kCrawlSizeDefault,
  crawlMinutes: kCrawlMinutesDefault,

  clampSize(v) {
    const n = asInt(v);
    return n < kCrawlSizeMin ? kCrawlSizeMin : (n > kCrawlSizeMax ? kCrawlSizeMax : n);
  },

  clampMinutes(v) {
    const n = asInt(v);
    return n < kCrawlMinutesMin ? kCrawlMinutesMin : (n > kCrawlMinutesMax ? kCrawlMinutesMax : n);
  },

  // 采集时两篇之间等多少秒。
  //
  // 按总时长摊到每篇上，不够最小间隔就按最小间隔来。
  // 每次在这个数上下浮动四成，固定节奏本身就是特征。
  gapSeconds() {
    const n = Limits.crawlSize <= 1 ? 1 : Limits.crawlSize - 1;
    const avg = Limits.crawlMinutes * 60 / n;
    const base = avg < kCrawlMinGapSeconds ? kCrawlMinGapSeconds : avg;
    const v = Math.round(base * (0.6 + Math.random() * 0.8));
    return v < kCrawlMinGapSeconds ? kCrawlMinGapSeconds : v;
  },

  async load() {
    Limits.crawlSize = Limits.clampSize(await getSetting('crawl_size', kCrawlSizeDefault));
    Limits.crawlMinutes = Limits.clampMinutes(
      await getSetting('crawl_minutes', kCrawlMinutesDefault));
  },

  async save(size, minutes) {
    Limits.crawlSize = Limits.clampSize(size);
    Limits.crawlMinutes = Limits.clampMinutes(minutes);
    await setSetting('crawl_size', Limits.crawlSize);
    await setSetting('crawl_minutes', Limits.crawlMinutes);
  },
};

// 页面打开之后先假装看一会儿，随手滚两到四下再动手。
// 一打开就翻到底，节奏上一眼假。
const readScrollMin = 2;
const readScrollMax = 4;
const readStepMin = 300;
const readStepMax = 900;
const readPauseMin = 700;
const readPauseMax = 1800;
const readTailMin = 1200;
const readTailMax = 3000;

// 接口等多久算没来。搜索第一屏慢一些，翻页的后续批次快。
const waitFirstMs = 20000;
const waitMoreMs = 6000;
const waitCommentMs = 10000;
const waitCommentMoreMs = 4000;

// 连着几批没有新数据就认为到底了。
const idleGiveUp = 4;

// 评论要多试几次才放弃。
//
// 评论是懒加载的，翻到底之后接口还在路上，两三次空转很常见。
// 按搜索那个次数放弃的话，每篇只能抓到最上面十几条，
// 底下真正在应征的人全漏掉了。
const commentGiveUp = 8;


// ===== 50-funnel.js =====
// 风控漏斗和意向分层。采回来的人不是都该联系的。
//
// 规则跟手机版 lib/local/funnel.dart 逐条对齐：先用黑名单和敏感词剔掉
// 不能碰的，再按意向分高中低三层，低意向直接丢掉不打扰。
// 说过别联系的人永久拉黑，一条都不再发。

// 广告号和同行的特征。这类人不但没价值，回复他们还容易被互相举报。
const kAdWords = [
  '加微信', '加V', '加v', '威信', '薇信', '➕', '私我', '扣我',
  '工作室', '团队', '接单', '代运营', '涨粉', '引流', '推广',
  '业务', '合作', '广告', '刷单', '兼职', '日入', '躺赚', '副业',
  '红娘', '婚介', '介绍所', '相亲平台', '收费', '付费', '会员费',
];

// 敏感和违规的内容。碰到这类一律跳过，连看都不看。
const kBadWords = [
  // 约这个字单独用不能拉黑，约会是正常说法；带这几个尾巴的才是
  '约炮', '约的', '约吗', '约不约', '可约',
  '包养', '援交', '一夜', '开房', '上门', '服务',
  '裸', '色情', '赌', '博彩', '贷款', '网贷', '代还',
  '刷单', '洗钱', '发票', '办证', '枪', '毒',
];

// 明确说了别联系的话。见到就永久拉黑，再也不发。
const kStopWords = [
  '别加我', '别私信', '不要联系', '别联系', '勿扰', '别打扰',
  '举报你', '滚', '骗子', '拉黑你', '别发了',
];

// 在找对象的信号。写得越具体，意向越高。
const kWantWords = [
  '找对象', '脱单', '相亲', '处对象', '找男朋友', '找女朋友',
  '奔着结婚', '认真谈', '想认识', '交往', '恋爱', '单身',
  '想找', '求推荐', '有没有合适',
  '找个伴', '想谈恋爱', '求脱单', '认识一下', '互相了解',
  '处处看', '奔现', '另一半', '征友', '征婚', '诚心找',
  '认真找', '看对眼', '合适的人', '有意向的',
];

// 在找对象的帖子底下应征的短话。
//
// 这些话单看没有找对象三个字，但发在这种帖子底下就是在举手。
// 它们必须整条匹配，不能用包含：可以两个字放进长句里到处都是。
const kShortWants = [
  '举手', '举手🙋', '我', '我可以', '可以', '可以吗', '想认识',
  '有意向', '有兴趣', '合适吗', '看看', '瞅瞅', '康康',
  '加一', '同求', '蹲一个', '蹲', '报名', '来了', '在吗',
  '还在找吗', '还找吗', '联系我', '扣我', '滴我', '冒泡',
];

// 把自己的条件写出来了，说明是认真的。
const kSelfWords = [
  '本人', '身高', '体重', '年薪', '在读', '学历',
  '坐标', '斤', 'cm', '公分',
  // 属这个单字太宽，属于两个字也会命中，换成属相
  '属相', '未婚', '离异', '有房', '有车',
  '公务员', '事业编', '国企', '年生',
  // 工作单用会命中工作不好这种跟相亲无关的话，
  // 所以只认写在自我介绍里的那几种写法
  '有稳定工作', '工作稳定', '刚工作',
];

const INTENT_HIGH = '高意向';
const INTENT_MID = '中等意向';
const INTENT_LOW = '无意向';
const INTENT_RISKY = '广告或同行';

function hasAny(s, words) {
  return words.some((w) => s.includes(w));
}

// 判断一条线索该怎么对待。text 是这个人自己写的话，帖子正文或者评论原文。
function judge(text, allowShort) {
  const s = asText(text).replace(/\s+/g, '');
  if (!s) return INTENT_LOW;

  // 先剔掉碰不得的。这一步在最前面，宁可错杀不可放过。
  if (hasAny(s, kBadWords)) return INTENT_RISKY;
  if (hasAny(s, kAdWords)) return INTENT_RISKY;

  // 短应征只在整条话就是那么一句时才算。
  //
  // 评论区里一个字的我、两个字的举手，发在找对象的帖子底下就是在应征。
  // 但这些词放进长句里到处都是，所以必须整条匹配，
  // 而且限定十个字以内，长了就不是应征而是在讲别的事。
  const bare = s.replace(/[。！!~？?、，,\s]/g, '');
  const short = allowShort !== false && s.length <= 10 &&
    kShortWants.some((w) => s === w || s === w + '。' || s === w + '！' ||
      s === w + '~' || bare === w);

  // 行业自己的应征词也算。找对象那套判据对别的行业太窄：
  // 医美底下的人问的是多少钱、哪家好，情感底下的人问的是怎么办，
  // 拿找对象的词去判，这些人一个都留不下。
  const tradeWords = (Trade.now && Trade.now.wantWords) || [];
  const wants = hasAny(s, kWantWords) || short ||
    (tradeWords.length > 0 && hasAny(s, tradeWords));
  const self = hasAny(s, kSelfWords);

  // 既说了要找对象，又把自己的条件摆出来了，这种人最值得联系
  if (wants && self) return INTENT_HIGH;
  if (wants && s.length >= 15) return INTENT_HIGH;
  if (wants) return INTENT_MID;
  // 光有自我介绍不算。判据只认一条：这个人自己说了要找对象。
  return INTENT_LOW;
}

// 判一个人该不该联系。昵称和留言分开看，取更强的那个。
//
// 不能把昵称和留言拼成一条去判：短应征只在整条话就是那么一句时才算，
// 昵称一拼上去就超过十个字，举手我可以这类应征全部失效。
// 反过来昵称里也不能认短应征，不然叫我的人人人都算在应征。
function judgePerson(nickname, said) {
  const a = judge(said, true);
  // 广告和违规一票否决，昵称干净也救不回来
  if (a === INTENT_RISKY) return a;
  if (a !== INTENT_LOW) return a;
  const b = judge(nickname, false);
  return b === INTENT_LOW ? a : b;
}

// 这个人是不是明确表示过别再联系。
function saidStop(text) {
  return hasAny(asText(text).replace(/\s+/g, ''), kStopWords);
}

// 一批人过一遍漏斗，返回能联系的那些和一份统计。
function runFunnel(all, opt) {
  const o = opt || {};
  const blocked = o.blocked || new Set();
  const keep = [];
  const stat = { all: all.length, risky: 0, low: 0, mid: 0, high: 0, blocked: 0 };

  for (const it of all) {
    if (blocked.has(it.user_id)) {
      stat.blocked += 1;
      continue;
    }
    const r = judgePerson(it.nickname, it.said);
    it.intent = r;
    if (r === INTENT_RISKY) stat.risky += 1;
    else if (r === INTENT_LOW) stat.low += 1;
    else if (r === INTENT_MID) {
      stat.mid += 1;
      if (!o.highOnly) keep.push(it);
    } else {
      stat.high += 1;
      keep.push(it);
    }
  }
  stat.left = stat.high + stat.mid;
  return { keep: keep, stat: stat };
}


// ===== 55-reply.js =====
// 看懂对方想找什么样的人，用红娘的口吻写一句私信。
//
// 这个号是替公司找人的，不是本人相亲，所以话术里不出现自己的条件，
// 只复述对方写明的要求，再说这边有对得上的人。复述得越具体，
// 对方越看得出你真读了帖子，而不是群发。
//
// 逐行照搬手机版 lib/local/reply.dart，两端生成的话一模一样。

// 认得出来的地名。够用就行，认不出来就不写地方，不硬猜。
//
// 排在前面的先匹配，所以省份放在后面，免得四川盖住成都。
const kCities = [
  '北京', '上海', '广州', '深圳', '重庆', '成都', '杭州', '武汉', '西安',
  '南京', '天津', '苏州', '长沙', '郑州', '青岛', '合肥', '福州', '厦门',
  '昆明', '济南', '宁波', '无锡', '大连', '沈阳', '哈尔滨', '长春', '贵阳',
  '南宁', '南昌', '太原', '石家庄', '兰州', '海口', '珠海', '东莞', '佛山',
  '温州', '常州', '徐州', '烟台', '潍坊', '洛阳', '襄阳', '绵阳', '柳州',
  '桂林', '中山', '惠州', '嘉兴', '金华', '台州', '泉州', '保定', '唐山',
  '乌鲁木齐', '呼和浩特', '银川', '西宁', '拉萨',
  '广东', '江苏', '浙江', '山东', '河南', '四川', '湖北', '湖南', '福建',
  '安徽', '河北', '陕西', '江西', '辽宁', '云南', '广西', '山西', '贵州',
  '黑龙江', '吉林', '甘肃', '新疆', '内蒙古', '宁夏', '青海', '西藏', '海南',
];

// 学历从低到高。
function degreeRank(s) {
  if (!s) return -1;
  if (s.includes('博士')) return 3;
  if (s.includes('研究生') || s.includes('硕士')) return 2;
  if (s.includes('本科') || s.includes('学士')) return 1;
  if (s.includes('大专') || s.includes('专科')) return 0;
  return -1;
}

// 从对方写的那段话里读出择偶要求。
function parseWants(text) {
  const empty = {
    height: null, degree: null, bornFrom: null, bornTo: null,
    city: null, noSmoke: false, noDrink: false, musts: [],
  };
  if (!asText(text).trim()) return empty;
  const s = asText(text).replace(/\s+/g, '');

  // 身高。180 加、180 以上、身高 180、178cm 都认，取下限。
  //
  // 帖子里往往有两个身高：自己的和要求对方的。只认带门槛词的写法，
  // 那才是对别人的要求。光写个数字或者身高多少，多半是在说自己，
  // 报回去反而露怯。
  let height = null;
  const heightRes = [
    /(1[5-9][0-9])\s*(?:cm|CM|厘米)?\s*(?:\+|以上|往上|起步|打底)/g,
    /(?:对方|男方|女方)[^。；;]{0,6}?身高[^0-9]{0,4}(1[5-9][0-9])/g,
  ];
  for (const re of heightRes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const v = parseInt(m[1], 10);
      if (!v || v < 150 || v > 199) continue;
      // 前面挨着本人、我这类词的是自述身高，跳过
      const from = Math.max(0, m.index - 8);
      const before = s.slice(from, m.index);
      if (/本人|我[身是的]|自己|小个子|身高小/.test(before)) continue;
      height = v;
      break;
    }
    if (height !== null) break;
  }

  // 学历。写了几档取最高那档当门槛。
  let degree = null;
  for (const d of ['大专', '本科', '研究生', '博士']) {
    if (s.includes(d)) {
      if (degree === null || degreeRank(d) > degreeRank(degree)) degree = d;
    }
  }
  if (s.includes('硕士') && degreeRank(degree || '') < 2) degree = '研究生';

  // 年龄。95 后、00 后这类写法。
  let bornFrom = null;
  let bornTo = null;
  const hou = s.match(/([0-9]{2})后/);
  if (hou) {
    const n = parseInt(hou[1], 10);
    bornFrom = n >= 50 ? 1900 + n : 2000 + n;
    bornTo = bornFrom + 9;
  }

  // 城市。对着地名表认，认不出来就当没写，宁可少说一句也别说错。
  // 光有地名还不够，去过云南旅游里的云南不是要求。
  // 前面得挨着限、坐标、在这类词，才算他划了地方。
  let city = null;
  for (const c of kCities) {
    const i = s.indexOf(c);
    if (i < 0) continue;
    const before = s.slice(Math.max(0, i - 3), i);
    if (/限|仅|只|坐标|常驻|在|求|找/.test(before)) {
      city = c;
      break;
    }
  }

  const musts = [];
  for (const k of ['稳定工作', '体制内', '有房', '有车', '不啃老', '身体健康',
    '上进', '真诚', '无不良嗜好', '顾家', '孝顺', '有责任心', '会做饭']) {
    if (s.includes(k)) musts.push(k);
  }

  return {
    height: height,
    degree: degree,
    bornFrom: bornFrom,
    bornTo: bornTo,
    city: city,
    noSmoke: s.includes('不抽烟') || s.includes('无烟') || s.includes('不吸烟'),
    noDrink: s.includes('不喝酒') || s.includes('不酗酒'),
    musts: musts,
  };
}

function wantsEmpty(w) {
  return w.height === null && w.degree === null && w.bornFrom === null &&
    w.city === null && !w.noSmoke && !w.noDrink && !w.musts.length;
}

// 把读到的要求写成人话，用来放进回复里复述给对方听。
// 最多取三条。全列出来像在念清单，反而不像人说话。
function wantsWords(w) {
  const parts = [];
  if (w.height !== null) parts.push(w.height + '以上');
  if (w.degree !== null) parts.push(w.degree);
  if (w.bornFrom !== null) parts.push(p2(w.bornFrom % 100) + '后');
  if (w.city !== null) parts.push(w.city);
  if (w.noSmoke) parts.push('不抽烟');
  if (w.noDrink) parts.push('不喝酒');
  for (const m of w.musts) parts.push(m);
  return parts.slice(0, 3).join('、');
}

// 对方自己是哪一年的。用来给人选定一个年龄相当的说法。
function theirYear(s) {
  const y = s.match(/(?:^|[^0-9])([0-9]{2})年/);
  if (y) {
    const n = parseInt(y[1], 10);
    return n >= 50 ? 1900 + n : 2000 + n;
  }
  const hou = s.match(/([0-9]{2})后/);
  if (hou) {
    const n = parseInt(hou[1], 10);
    return n >= 50 ? 1900 + n : 2000 + n;
  }
  const age = s.match(/([12][0-9])岁/);
  if (age) return new Date().getFullYear() - parseInt(age[1], 10);
  return null;
}

// 身高往上取一档整数。对方写 175，说 180 比说 176 自然。
function roundUp5(h) {
  return (Math.floor(h / 5) + 1) * 5;
}

// 对方是男是女。红娘要的是男女配对，推荐的人性别得跟对方相反，
// 给一个找女孩的男生推荐男生，是这套东西最丢人的错法。
function theirGender(text) {
  const s = asText(text).replace(/\s+/g, '');
  // 先看本人后面那句，那是最明确的自述
  const self = s.match(/本人[：:]?\s*([男女])/);
  if (self) return self[1];
  if (/我是[男]|男生找|男找女|本人男|00后男|哥哥我/.test(s)) return '男';
  if (/我是[女]|女生找|女找男|本人女|[0-9]{2}年?女|女大学生|微胖女生/.test(s)) return '女';
  // 找什么反推自己是什么
  if (/找男朋友|找个男|想找男|寻男友|要男的|找男孩|男朋友|npy?$/.test(s)) return '女';
  if (/找女朋友|找个女|想找女|寻女友|要女的|找女孩|的女孩|女朋友/.test(s)) return '男';
  return '';
}

// 该按男生还是女生来自我介绍。对方是女的就当男的说，反过来一样。
function meGender(theirs) {
  return theirs === '女' ? '男' : (theirs === '男' ? '女' : '');
}

// 身材那句。男生只报身高，女生报身高加体重。
//
// 这一条一定要有。相亲帖里对方最先看的就是身高，一句话里没有它，
// 剩下的学历工作说得再好也没人接。
//
// 对方划了身高线就压着线往上报一档，没划线报 185。
// 读不出对方性别时按男生走，只报身高，那样两边都不算说错。
function figure(me, want) {
  if (me === '女') return '160，85斤';
  // 封在 190。对方写 195 以上就顺着报 200 的话，一眼就知道是机器。
  const h = want !== null && want >= 185 ? roundUp5(want) : 185;
  return String(h > 190 ? 190 : h);
}

// 从对方那段话里挑一句能接的。有这一句，回复才像看过帖子的人写的。
function hookLine(text) {
  const s = asText(text).replace(/[#＃][^#＃\s]{0,20}/g, ' ');
  for (const line of s.split(/[\n。！!？?，,；;｜|]/)) {
    const t = line.trim();
    if (t.length < 5 || t.length > 16) continue;
    // 对方提要求那半句不能接。接出来是看你说希望对方180以上，
    // 等于把人家的条件复述一遍，像在应聘。只接讲自己想法的那半句。
    if (/对方|男方|女方|要求|以上|起步|不低于|身高|学历|年薪/.test(t)) continue;
    if (/圈子|认识不到|想找|希望|奔着|认真|真诚|试一试|踏实|简单/.test(t)) return t;
  }
  return '';
}

const kStateWords = ['在实习', '刚工作', '工作稳定', '在上班', '刚毕业'];
const kStudyWords = ['在读考研', '大四准备考研', '研一在读', '还在读书'];
const kAskWords = ['可以联系下吗', '方便联系下吗', '可以认识下吗', '能加个联系方式吗'];

// 从种子里挑一个。
//
// 每处用不同的盐，不然相邻的用户 id 会一起落进同一档，
// 表现就是连着几条话术的措辞一模一样。
function pickBySeed(list, seed, salt) {
  let h = 2166136261;
  const s = salt + '|' + seed;
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ s.charCodeAt(i)) * 16777619) & 0x7fffffff;
  }
  return list[h % list.length];
}

// 按对方的帖子写一句自我介绍，然后问能不能联系。
//
// 第一人称，说的是这个号背后那个人的条件。里面的数字是照对方的
// 要求套出来的，发之前要改成真人的条件。软件只把句子摆得像人话。
function makeReply(theirText, seed, city) {
  const w = parseWants(theirText);
  const s = asText(theirText).replace(/\s+/g, '');
  const year = theirYear(s);
  // 属地要认得出是个中国地名才敢往话里放。
  // 采回来的属地有未知、日本、中国香港这些值，直接拼进去
  // 就成了我未知95年研究生、我日本95年研究生，当场出丑。
  const raw = w.city || asText(city);
  const place = kCities.includes(raw) ? raw : '';
  const student = /在读|大学生|研究生在读|考研/.test(s);
  const ask = pickBySeed(kAskWords, seed || '', '结尾');

  // 身材那一条永远要有。相亲帖里对方最先看的就是身高，没有它，
  // 这条私信跟骚扰没区别。
  const fig = figure(meGender(theirGender(theirText)), w.height);

  // 别的都读不出来，就只报身材加一句问话
  if (wantsEmpty(w) && year === null && !place) return '我' + fig + '，' + ask;

  // 攒自我介绍。有什么说什么，缺的不提，全说满就成参数表了。
  const bits = [];
  let head = '';
  if (place) head += place;
  if (year !== null) head += p2(year % 100) + '年';
  if (student) {
    head += pickBySeed(kStudyWords, seed || '', '在读');
  } else if (w.degree !== null) {
    head += w.degree === '博士' ? '博士' : '研究生';
  }
  if (head) bits.push(head);

  // 不在读的话补一句工作状态
  if (!student && bits.length) bits.push(pickBySeed(kStateWords, seed || '', '状态'));
  bits.push(fig);

  const self = bits.join('，');
  const hook = hookLine(theirText);

  // 句式换着搭。同一个模子套几十条，比说错话还显眼。
  // 每一句都要有主语，不然出来的是 05年还在读书，185，像在说对方。
  const shapes = ['我' + self + '，' + ask];
  if (hook) shapes.push('看你说' + hook + '，我' + self + '，' + ask);
  // 我也某某年的这个开头，后面就不能再带年份，
  // 不然出来的是我也95年的，95年还在读书
  if (year !== null && bits.length > 1) {
    shapes.push('我也' + p2(year % 100) + '年的，' + bits.slice(1).join('，') + '，' + ask);
  }
  shapes.push('我这边' + self + '，' + ask);
  shapes.push('我' + self + '，' + ask);
  return pickBySeed(shapes, seed || '', '句式');
}


// ===== 58-csv.js =====
// 导出成 CSV，拿到电脑上用表格软件打开。
//
// 表头和列序跟手机版 lib/local/export.dart 完全一致，三端导出的表能直接摞在一起。

// Excel 认这个字节序标记才不会把中文显示成乱码。
const csvBom = '﻿';

// 换行用 \r\n。Excel 在 Windows 上认这个，只给 \n 会把一行拆成两行。
const csvEol = '\r\n';

function csvCell(v) {
  const s = asText(v);
  // 逗号、引号、换行都要包起来，引号本身再翻一倍
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

function csvText(header, rows) {
  let buf = csvBom + csvRow(header) + csvEol;
  for (const r of rows) buf += csvRow(r) + csvEol;
  return buf;
}

// 表头一律用界面上的说法，导出来的表和面板里看到的能对上号。
const peopleHeader = ['昵称', '类型', '属地', '说的话', '时间', '点赞', '关键词', '笔记标题'];
const notesHeader = ['标题', '作者', '属地', '正文', '话题标签', '发布时间', '点赞', '评论', '关键词', '笔记链接'];
const commentsHeader = ['昵称', '属地', '说的话', '时间', '点赞', '关键词', '笔记标题'];

function peopleCsv(rows) {
  return csvText(peopleHeader, rows.map((r) => [
    r.nickname, r.kind, r.ip_location, r.said, r.ts, r.likes, r.keyword, r.note_title,
  ]));
}

function notesCsv(rows) {
  return csvText(notesHeader, rows.map((r) => [
    r.title, r.author_name, r.ip_location, r.content, r.topics,
    r.publish_time, r.likes, r.comment_cnt, r.keyword, r.note_url,
  ]));
}

// 把一段文字存成文件让用户下载。
//
// iPhone 上点了会弹出存到文件或者用别的 app 打开，跟手机版的分享是一个意思。
function download(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}


// ===== 60-hook.js =====
// 钩住页面自己发的接口请求。
//
// 这是整套东西的地基。小红书的接口带签名，自己拼请求几乎不可能，
// 但只要让页面自己去请求，返回就是完整的，跟人工浏览没有区别。
// 我们只在 fetch 和 XMLHttpRequest 外面包一层，把返回的 JSON 抄一份。
//
// 图片和埋点不要，一秒钟几百条会把缓存撑爆。
//
// 脚本可能跑在两个地方：页面自己的环境里，或者扩展给的隔离环境里。
// 跑在隔离环境时改不到页面的 fetch，所以再往页面里塞一段同样的代码，
// 用 postMessage 把数据递回来。两条路都铺上，哪条通走哪条。

// 钩到的接口数据按桶存着，采集流程操作页面，然后来这里取数。
const Buckets = {
  _b: {},
  // 同一条返回可能被两条路各送一次，用地址加长度去重
  _seen: new Set(),

  add(url, body) {
    const name = bucketOf(url);
    if (!name || !body) return;
    const sig = name + '|' + url.length + '|' + body.length;
    if (this._seen.has(sig)) return;
    this._seen.add(sig);
    if (this._seen.size > 400) this._seen = new Set();
    if (!this._b[name]) this._b[name] = [];
    this._b[name].push({ url: url, body: body });
  },

  count(name) {
    return (this._b[name] || []).length;
  },

  // 取出并清空一个桶。
  take(name) {
    const out = this._b[name] || [];
    delete this._b[name];
    return out;
  },

  clear(name) {
    if (name) delete this._b[name];
    else this._b = {};
  },
};

// 页面里要跑的那段代码。写成字符串是因为它要被塞进页面自己的环境执行。
//
// 只认接口地址里带 /api/sns/ 或者 /aweme/ 的，其余一概不管。
const PAGE_HOOK_SRC = `(() => {
  // 防重复用 window 上的标记，不用 DOM 上的。
  //
  // 这段代码在 document-start 就跑，那会儿 documentElement 可能还没有，
  // 拿 DOM 当标记会直接抛，钩子一个都装不上，表现是采集永远 0 篇。
  if (window.__xhsHooked) return;
  window.__xhsHooked = true;

  // DOM 上那个标记是给隔离环境看的，两边只有 DOM 是共用的。
  const mark = () => {
    try { document.documentElement.dataset.xhsHook = '1'; } catch (e) {}
  };
  mark();
  document.addEventListener('DOMContentLoaded', mark);

  const care = (u) => typeof u === 'string'
    && (u.includes('/api/sns/') || u.includes('/aweme/'))
    && !u.includes('/track') && !u.includes('/log');

  const send = (url, text) => {
    try {
      window.postMessage({ __xhs: 'api', url: String(url), body: text || '' }, '*');
    } catch (e) {}
  };

  const of = window.fetch;
  window.fetch = function (...a) {
    const u = (a[0] && a[0].url) || a[0];
    return of.apply(this, a).then((r) => {
      try {
        if (care(u)) r.clone().text().then((t) => send(u, t)).catch(() => {});
      } catch (e) {}
      return r;
    });
  };

  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) {
    this.__u = u;
    return oo.call(this, m, u, ...r);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try { if (care(this.__u)) send(this.__u, this.responseText); } catch (e) {}
    });
    return os.apply(this, a);
  };

  // 隔离环境读不到页面的 __INITIAL_STATE__，所以由页面这边代读。
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__xhs !== 'ask' || d.what !== 'noteState') return;
    let text = '';
    try {
      const m = (((window.__INITIAL_STATE__ || {}).note) || {}).noteDetailMap || {};
      const one = m[d.noteId] || Object.values(m)[0];
      const n = (one && one.note) || null;
      text = n ? JSON.stringify(n) : '';
    } catch (e) {}
    window.postMessage({ __xhs: 'answer', id: d.id, text: text }, '*');
  });
})();`;

let _hookReady = false;

// 装钩子。页面每次加载都要装一次，脚本自己会防重复。
function installHooks() {
  if (_hookReady) return;
  _hookReady = true;

  // 收页面递过来的数据。两条路最后都汇到这里。
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__xhs !== 'api') return;
    Buckets.add(asText(d.url), asText(d.body));
  });

  // 先直接改一遍。脚本本来就跑在页面环境里的话，这一下就成了。
  try {
    // eslint-disable-next-line no-eval
    (0, eval)(PAGE_HOOK_SRC);
  } catch (e) {
    // 隔离环境里改的是自己那份 fetch，没用，但也不会出错
  }

  // 再往页面里塞一份。上面那次已经装上的话，这一份看到标记就自己退出。
  //
  // 塞的时候 documentElement 可能还没建出来，所以塞不进去就等一会儿再塞，
  // 最迟也要在页面自己的脚本跑起来之前塞上，晚了就钩不到第一批请求。
  let tries = 0;
  const inject = () => {
    if (document.documentElement && document.documentElement.dataset.xhsHook === '1') {
      return;
    }
    try {
      const host = document.head || document.documentElement;
      if (!host) throw new Error('还没有 DOM');
      const s = document.createElement('script');
      s.textContent = PAGE_HOOK_SRC;
      host.appendChild(s);
      s.remove();
      return;
    } catch (e) {}
    if (++tries < 50) setTimeout(inject, 0);
  };
  inject();
  document.addEventListener('DOMContentLoaded', inject);
}

// 钩子到底装上了没有。装不上的话采集会一条都采不到，
// 界面上必须说清楚，不能让人对着一个不动的进度条干等。
function hookInstalled() {
  return document.documentElement.dataset.xhsHook === '1';
}

// ---------- 问页面要数据 ----------

let _askId = 0;
const _asking = {};

window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || d.__xhs !== 'answer') return;
  const fn = _asking[d.id];
  if (!fn) return;
  delete _asking[d.id];
  fn(asText(d.text));
});

// 从页面自带的那份数据里读笔记正文。
//
// 小红书把笔记详情接口撤了，打开详情页不再发 feed 请求，正文只能从
// window.__INITIAL_STATE__ 里读。能直接读就直接读，读不到再问页面要。
function readNoteState(noteId) {
  try {
    const m = (((window.__INITIAL_STATE__ || {}).note) || {}).noteDetailMap || {};
    const one = m[noteId] || Object.values(m)[0];
    const n = (one && one.note) || null;
    if (n) return Promise.resolve(JSON.stringify(n));
  } catch (e) {}

  return new Promise((resolve) => {
    const id = ++_askId;
    _asking[id] = resolve;
    try {
      window.postMessage({ __xhs: 'ask', what: 'noteState', noteId: noteId, id: id }, '*');
    } catch (e) {
      resolve('');
    }
    // 页面那边没人应答就当没有，不能挂在这儿
    setTimeout(() => {
      if (_asking[id]) {
        delete _asking[id];
        resolve('');
      }
    }, 1500);
  });
}

// ---------- 操作页面 ----------

// 往下滚一段。
//
// 不点翻页按钮，因为搜索结果和评论区都是滚到底自动加载，
// 根本没有翻页按钮可点。
//
// 两处都滚：窗口本身，以及页面里最高的那个能滚的容器。
// 笔记详情页的评论区是独立滚动容器，只滚窗口的话评论一条都翻不出来。
function scrollSome(dy) {
  try {
    const box = [...document.querySelectorAll('div')]
      .filter((e) => e.scrollHeight - e.clientHeight > 200 &&
        /auto|scroll/.test(getComputedStyle(e).overflowY))
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (box) box.scrollTop += dy;
    window.scrollBy(0, dy);
  } catch (e) {}
}

// 点开展开更多回复，把二级评论翻出来。
// 一次最多点三个，点太多也是一种异常节奏。
function expandReplies() {
  try {
    const hit = [...document.querySelectorAll('div,span,a')]
      .filter((e) => e.offsetParent !== null && /展开.{0,6}条回复/.test(e.innerText || ''));
    hit.slice(0, 3).forEach((e) => {
      try { e.click(); } catch (err) {}
    });
    return hit.length;
  } catch (e) {
    return 0;
  }
}

// 页面撞上风控时会出现的提示。不查的话只会拿到空数据，看不出原因。
const kRiskWords = ['当前操作环境异常', '滑动验证', '请完成验证', '访问频繁',
  '操作过于频繁', '你访问的笔记不见了', '登录后查看'];

function riskWord() {
  try {
    const t = (document.body && document.body.innerText) || '';
    for (const s of kRiskWords) {
      if (t.includes(s)) return s;
    }
  } catch (e) {}
  return '';
}

// 页面在要登录，不是限流也不是验证码。
//
// 这两种要分开处理：限流是等一等再来，登录失效是等到明年也没用，
// 必须停下来让人重新登录。混在一起报的话，界面上只会一个词一个词跳过，
// 跑完显示一条没采到，看不出是登录掉了。
function isLoginWall(s) {
  return asText(s).includes('登录');
}


// ===== 70-engine.js =====
// 采集引擎。
//
// 跟手机版做同一件事：搜关键词、翻页拿到一批帖子、逐篇打开拿正文和评论。
// 区别在于手机版整轮跑在一个不会消失的对象里，网页版每打开一篇帖子
// 就是一次真正的页面跳转，脚本会被整个重新加载，内存里的东西全没。
//
// 所以这里写成一台状态机：每走一步就把进度写回库，
// 新页面起来之后读回进度，看自己该干什么，接着干。
// 中途关掉标签页、手机锁屏、甚至重启浏览器，回到小红书都能接着跑。

// 这个标签页的身份。同时开两个标签页时，只让一个真正干活，
// 另一个只看进度，不然两边抢着跳转，页面会来回乱蹦。
//
// 身份存在 sessionStorage 里，因为它正好是按标签页存的，同一个标签页
// 跳多少次都不变，另开一个标签页则是新的一份。
// 直接生成一个随机数不行：采集本身就是靠跳页面推进的，每跳一次身份就变，
// 新页面会认为有别的标签页在干活，于是谁也不动，整轮卡在第一步。
function readTabId() {
  try {
    let v = sessionStorage.getItem('xhs_tab');
    if (!v) {
      v = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('xhs_tab', v);
    }
    return v;
  } catch (e) {
    // 用不了就不分标签页了。宁可两个标签页抢，也不能一个都不干活。
    return 'nostorage';
  }
}

const TAB_ID = readTabId();

// 心跳超过这个时长没更新，就认为原来那个标签页已经关了，本页可以接手。
const TAKEOVER_MS = 45000;

// 界面要跟着变的东西全从这里读。
const Runtime = {
  job: null,
  // 停止和暂停要立刻生效，不能等下一次读库
  stopFlag: false,
  pauseFlag: false,
  onChange: null,
  // 正在这个页面里干活，防止同一页重复起两条流程
  busy: false,
};

function emit() {
  if (Runtime.onChange) {
    try { Runtime.onChange(Runtime.job); } catch (e) {}
  }
}

async function saveJob(patch) {
  const job = Object.assign({}, Runtime.job || {}, patch || {});
  job.tab = TAB_ID;
  job.beat = Date.now();
  Runtime.job = job;
  await setJob(job);
  emit();
  return job;
}

function logLine(job, line) {
  const log = (job.log || []).slice(-79);
  log.push(nowCst().slice(11) + ' ' + line);
  return log;
}

async function say(line, extra) {
  const job = Runtime.job || {};
  await saveJob(Object.assign({ message: line, log: logLine(job, line) }, extra || {}));
}

// 估算这一轮总共要处理多少篇。
//
// 已经处理完的按实际数，当前这个词按真实搜到的篇数，后面还没搜的词只能按上限估。
// 每搜完一个词就重算一次，所以进度条越跑越准。
function estimateTotal(done, hits, wordsLeft, maxNotes) {
  return done + hits + wordsLeft * maxNotes;
}

// 进度比例，永远落在 0 到 1 之间。总数还没估出来时按 0 算。
function progressRatio(done, total) {
  if (total <= 0) return 0;
  const r = done / total;
  return r < 0 ? 0 : (r > 1 ? 1 : r);
}

// ---------- 该待在哪个页面 ----------

function currentWord(job) {
  return (job.keywords || [])[job.wi] || '';
}

function currentHit(job) {
  return (job.hits || [])[job.ni] || null;
}

// 这一步该打开的地址。
function wantUrl(job) {
  if (job.phase === 'note') {
    const h = currentHit(job);
    if (!h) return '';
    return buildNoteUrl(h.note_id, h.xsec_token, 'pc_search');
  }
  return searchUrl(currentWord(job));
}

// 现在这个页面是不是该干活的那个。
function onWantedPage(job) {
  const path = location.pathname;
  if (job.phase === 'note') {
    const h = currentHit(job);
    return !!h && path.indexOf('/explore/' + h.note_id) === 0;
  }
  if (path.indexOf('/search_result') !== 0) return false;
  let kw = '';
  try {
    kw = new URLSearchParams(location.search).get('keyword') || '';
  } catch (e) {}
  return kw === currentWord(job);
}

// ---------- 等待 ----------

// 停下来了没有。停止和暂停在等待的每一小段之间检查，所以按下去很快有反应。
function shouldStop() {
  return Runtime.stopFlag;
}

// 等一段时间，切成半秒一段。
//
// 切段是为了停止能及时生效，也为了界面上的倒计时能走。
// 一觉睡到底的话，按了停止要等到这一段结束才有反应，看着就像卡死了。
async function nap(ms, note) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (shouldStop()) return;
    await holdIfPaused();
    if (shouldStop()) return;
    const left = Math.ceil((until - Date.now()) / 1000);
    if (note && left > 0) {
      Runtime.job = Object.assign({}, Runtime.job, {
        message: note + ' ' + left + ' 秒',
        countdown: left,
      });
      emit();
    }
    await sleep(Math.min(500, Math.max(50, until - Date.now())));
  }
  if (Runtime.job) {
    Runtime.job = Object.assign({}, Runtime.job, { countdown: 0 });
  }
}

// 暂停时就挂在这儿，直到点继续或者点停止。
//
// 挂着的时候不走秒，剩下的等待时间原样留着，
// 不然暂停十分钟回来发现间隔已经等完了，等于没暂停。
async function holdIfPaused() {
  while (Runtime.pauseFlag && !Runtime.stopFlag) {
    await sleep(400);
  }
}

// 等某个桶里来数据。等到了返回 true。
async function waitBucket(name, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (Buckets.count(name) > 0) return true;
    if (shouldStop()) return Buckets.count(name) > 0;
    await sleep(300);
  }
  return Buckets.count(name) > 0;
}

// 打开页面之后先看一会儿，随手滚两下。一打开就翻到底，节奏上一眼假。
async function readAWhile() {
  const n = randInt(readScrollMin, readScrollMax);
  for (let i = 0; i < n; i++) {
    if (shouldStop()) return;
    scrollSome(randInt(readStepMin, readStepMax));
    await nap(randInt(readPauseMin, readPauseMax));
  }
  await nap(randInt(readTailMin, readTailMax));
}

// ---------- 取数 ----------

function drainNotes(bucket, seen, out, word) {
  let added = 0;
  for (const pack of Buckets.take(bucket)) {
    const got = parseCaptured(pack.url, pack.body, word);
    for (const n of got.notes) {
      if (!n.note_id || seen.has(n.note_id)) continue;
      seen.add(n.note_id);
      out.push(n);
      added += 1;
    }
  }
  return added;
}

function drainComments(bucket, seen, out) {
  let added = 0;
  for (const pack of Buckets.take(bucket)) {
    const got = parseCaptured(pack.url, pack.body, '');
    const nid = noteIdInUrl(pack.url);
    for (const c of got.comments) {
      if (!c.comment_id || seen.has(c.comment_id)) continue;
      seen.add(c.comment_id);
      if (!c.note_id && nid) c.note_id = nid;
      out.push(c);
      added += 1;
    }
  }
  return added;
}

// ---------- 搜索 ----------

// 在搜索结果页上翻，攒够这个词要的篇数。
async function stepSearch(job) {
  const word = currentWord(job);
  await say('搜索 ' + word + '，目标 ' + job.maxNotes + ' 篇');
  // 这里不能清桶。页面一加载就自己去请求了第一屏，那份数据在我们
  // 开始干活之前就已经钩到手了，清掉的话第一屏二十条全没，
  // 只能靠往下翻才拿得到，翻不动的词就是一篇都采不到。
  // 桶本来就是每次页面加载新建的，没有上一页的脏数据要清。
  await readAWhile();
  if (shouldStop()) return;
  await waitBucket('search', waitFirstMs);

  const rows = [];
  const seen = new Set();
  let idle = 0;
  while (rows.length < job.maxNotes && idle < idleGiveUp && !shouldStop()) {
    const added = drainNotes('search', seen, rows, word);
    if (added > 0) {
      idle = 0;
      await say(word + ' 已拿 ' + rows.length + ' 篇');
    } else {
      idle += 1;
      if (idle === 2) {
        const risk = riskWord();
        if (isLoginWall(risk)) {
          await say('登录失效了，页面在要登录，整轮停下');
          await finish(job, '已停止');
          return;
        }
        if (risk) {
          await say('搜索页出现 ' + risk + '，这个词先跳过');
          break;
        }
      }
    }
    if (rows.length >= job.maxNotes) break;
    scrollSome(randInt(1900, 2500));
    await waitBucket('search', waitMoreMs);
  }
  // 收尾，把最后一批也解析掉
  drainNotes('search', seen, rows, word);

  const hits = rows.slice(0, job.maxNotes)
    // 小红书没有 token 打不开笔记，这种直接不要，免得白跑一趟
    .filter((n) => n.note_id && n.xsec_token);

  const stats = Object.assign({}, job.stats);
  stats.total = estimateTotal(
    stats.done, hits.length, (job.keywords.length - job.wi - 1), job.maxNotes);

  await say(word + ' 拿到 ' + hits.length + ' 篇');
  await saveJob({ hits: hits, ni: 0, phase: 'note', stats: stats });
  await goNext();
}

// ---------- 一篇笔记 ----------

async function stepNote(job) {
  const hit = currentHit(job);
  const word = currentWord(job);
  if (!hit) {
    await nextWord();
    return;
  }
  await say('[' + word + ' ' + (job.ni + 1) + '/' + job.hits.length + '] 打开帖子');
  // 同样不能清桶，评论接口也是页面一加载就发的
  await readAWhile();
  if (shouldStop()) return;

  let detail = [];
  if (await waitBucket('feed', 6000)) {
    drainNotes('feed', new Set(), detail, word);
  }
  if (!detail.length) {
    // 页面是异步填的，所以轮询等，不能一开局就取
    for (let i = 0; i < 24 && !shouldStop(); i++) {
      const raw = await readNoteState(hit.note_id);
      if (raw) {
        let obj = null;
        try { obj = JSON.parse(raw); } catch (e) {}
        const one = obj ? parseNoteState(obj, hit.xsec_token, word) : null;
        if (one) {
          detail = [one];
          break;
        }
      }
      await sleep(500);
    }
  }
  if (!detail.length) {
    const risk = riskWord();
    // 正文拿不到不等于这篇没用。搜索结果里已经有标题、作者、点赞、
    // 属地这些字段，够建一条能看的记录。整篇丢掉的话，一旦页面结构
    // 变了，采集会显示跑完但库里一条没有。
    if (risk) {
      await say('笔记 ' + hit.note_id + ' 出现 ' + risk + '，跳过');
      await nextNote(0, 0);
      return;
    }
    await say('这篇没拿到正文，先按搜索摘要存下');
    detail = [hit];
  }

  const comments = job.onlyOwner ? [] : await collectComments(job.maxComments);
  if (shouldStop()) return;

  // 合并：详情比摘要全，但摘要里的关键词和 token 要留着
  const note = Object.assign({}, hit, detail[0]);
  note.keyword = word;
  note.xsec_token = note.xsec_token || hit.xsec_token;
  note.note_url = note.note_url || buildNoteUrl(note.note_id, note.xsec_token, 'pc_search');

  for (const c of comments) {
    if (!c.note_id) c.note_id = hit.note_id;
  }

  const freshNotes = await saveNotes([note], word, '小红书', job.trade);
  const freshComments = await saveComments(comments, '小红书', job.trade);
  await nextNote(freshNotes, freshComments, head(note.title || note.content, 18));
}

// 在已经打开的详情页里翻评论区。
async function collectComments(maxComments) {
  const rows = [];
  const seen = new Set();
  let idle = 0;
  await waitBucket('comment', waitCommentMs);
  while (rows.length < maxComments && idle < commentGiveUp && !shouldStop()) {
    let added = drainComments('comment', seen, rows);
    added += drainComments('sub_comment', seen, rows);
    idle = added > 0 ? 0 : idle + 1;
    if (rows.length >= maxComments) break;
    expandReplies();
    scrollSome(randInt(1000, 1400));
    // 空转过一次就多等一会儿。评论是懒加载的，翻到底之后
    // 接口还要一两秒才回来，按固定短时长等会把还在路上的那批当成没有。
    await waitBucket('comment', idle === 0 ? waitCommentMoreMs : waitCommentMoreMs * 2);
  }
  drainComments('comment', seen, rows);
  drainComments('sub_comment', seen, rows);
  return rows.slice(0, maxComments);
}

// ---------- 往下走 ----------

async function nextNote(freshNotes, freshComments, title) {
  const job = Runtime.job;
  const stats = Object.assign({}, job.stats);
  stats.done += 1;
  stats.notes += freshNotes || 0;
  stats.comments += freshComments || 0;
  const line = '[' + currentWord(job) + ' ' + (job.ni + 1) + '/' + job.hits.length + '] ' +
    (title ? title + ' ' : '') + '新评论 ' + (freshComments || 0) +
    '，累计 ' + stats.comments;
  await saveJob({ ni: job.ni + 1, stats: stats, message: line, log: logLine(job, line) });
  await goNext();
}

async function nextWord() {
  const job = Runtime.job;
  await markKeywordRun(currentWord(job), job.trade);
  const wi = job.wi + 1;
  if (wi >= job.keywords.length) {
    await finish(job, '完成');
    return;
  }
  await saveJob({ wi: wi, ni: 0, hits: [], phase: 'search' });
  await goNext();
}

// 这一步做完了，等够间隔再去下一个页面。
//
// 等待放在跳转之前，是为了倒计时能显示在一个不会被刷新掉的页面上。
async function goNext() {
  const job = Runtime.job;
  if (shouldStop()) {
    await finish(job, '已停止');
    return;
  }
  if (job.phase === 'note' && job.ni >= (job.hits || []).length) {
    await nextWord();
    return;
  }
  const url = wantUrl(job);
  if (!url) {
    await nextWord();
    return;
  }
  const gap = Limits.gapSeconds() * 1000;
  await saveJob({ nextAt: Date.now() + gap });
  await nap(gap, '歇一下，还有');
  if (shouldStop()) {
    await finish(Runtime.job, '已停止');
    return;
  }
  location.href = url;
}

async function finish(job, status) {
  Runtime.stopFlag = false;
  Runtime.pauseFlag = false;
  const stats = (job && job.stats) || { notes: 0, comments: 0 };
  await finishTask(job && job.taskId, status, stats.notes, stats.comments);
  await saveJob({
    running: false,
    paused: false,
    phase: '',
    hits: [],
    countdown: 0,
    message: status + '，笔记 ' + stats.notes + ' 评论 ' + stats.comments,
    log: logLine(job || {}, status + '，笔记 ' + stats.notes + ' 评论 ' + stats.comments),
  });
}

// ---------- 对外 ----------

// 开一轮采集。
async function startCollect(opt) {
  const words = (opt.keywords || []).map((s) => asText(s).trim()).filter(Boolean);
  if (!words.length) return;
  Runtime.stopFlag = false;
  Runtime.pauseFlag = false;
  const taskId = await newTask('采集', words.join('、'), {
    keywords: words,
    max_notes: opt.maxNotes,
    max_comments: opt.maxComments,
    only: opt.onlyOwner ? '帖主' : '',
  });
  await saveJob({
    running: true,
    paused: false,
    trade: opt.trade || Trade.now.key,
    keywords: words,
    wi: 0,
    ni: 0,
    hits: [],
    phase: 'search',
    maxNotes: opt.maxNotes,
    maxComments: opt.maxComments,
    onlyOwner: !!opt.onlyOwner,
    taskId: taskId,
    stats: { done: 0, total: words.length * opt.maxNotes, notes: 0, comments: 0 },
    nextAt: 0,
    countdown: 0,
    message: '准备开始',
    log: [],
  });
  for (const w of words) await saveKeyword(w, opt.trade || Trade.now.key, true);
  await drive();
}

async function pauseCollect() {
  Runtime.pauseFlag = true;
  await saveJob({ paused: true, message: '暂停了，点继续接着采' });
}

async function resumeCollect() {
  Runtime.pauseFlag = false;
  await saveJob({ paused: false, message: '接着采' });
  if (!Runtime.busy) await drive();
}

// 收到停止。正在跑的这一步会做完，不会半路掐掉。
async function stopCollect() {
  Runtime.stopFlag = true;
  Runtime.pauseFlag = false;
  await saveJob({ paused: false, message: '收到停止，等这一步跑完' });
  // 没有流程在跑的时候，光设标志没人来收尾，这里直接结掉
  if (!Runtime.busy) await finish(Runtime.job, '已停止');
}

// 页面起来之后看看自己该干什么。
//
// 这是整台状态机的入口，每次页面加载都要调一次。
async function drive() {
  if (Runtime.busy) return;
  const job = Runtime.job;
  if (!job || !job.running) return;

  // 另一个标签页正在干活，本页只看不动
  if (job.tab && job.tab !== TAB_ID && Date.now() - (job.beat || 0) < TAKEOVER_MS) {
    return;
  }
  if (job.paused) {
    Runtime.pauseFlag = true;
    return;
  }

  Runtime.busy = true;
  try {
    if (!onWantedPage(job)) {
      const url = wantUrl(job);
      if (!url) {
        await nextWord();
        return;
      }
      // 上一页已经等过间隔了就不再等，只有刷新或者中途回来才补等
      const left = (job.nextAt || 0) - Date.now();
      if (left > 0) await nap(left, '歇一下，还有');
      if (shouldStop()) {
        await finish(job, '已停止');
        return;
      }
      location.href = url;
      return;
    }
    if (job.phase === 'note') await stepNote(job);
    else await stepSearch(job);
    // 这一步是被停止打断的。步骤里的每个等待都只是提前醒来就返回，
    // 谁也没负责收尾，不在这儿补一刀的话，这一轮会永远显示在跑，
    // 界面上停止按钮按下去像没反应。
    if (shouldStop() && Runtime.job && Runtime.job.running) {
      await finish(Runtime.job, '已停止');
    }
  } catch (e) {
    await say('出错了 ' + (e && e.message ? e.message : e));
    await finish(Runtime.job, '已停止');
  } finally {
    Runtime.busy = false;
  }
}

// 心跳。让别的标签页知道这一个还活着。
function startHeartbeat() {
  setInterval(() => {
    const job = Runtime.job;
    if (!job || !job.running) return;
    if (job.tab !== TAB_ID) return;
    setJob(Object.assign({}, job, { beat: Date.now() }));
  }, 15000);
}


// ===== 80-ui.js =====
// 悬浮面板。整套界面都在这一个盒子里，不动小红书自己的页面。
//
// 手机上是从底下升起来的一张卡，电脑上是右边的一条竖栏，
// 两种都能单手够到。页面每跳一次这个面板就重建一次，
// 状态从库里读回来，所以看起来像一直开着。

const PANEL_CSS = `
.xhsc-root, .xhsc-root * { box-sizing: border-box; font-family: -apple-system,
  BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif; }
.xhsc-fab { position: fixed; right: 16px; bottom: 88px; z-index: 2147483000;
  width: 54px; height: 54px; border-radius: 27px; border: none;
  background: #ff2e4d; color: #fff; font-size: 13px; font-weight: 600;
  box-shadow: 0 6px 20px rgba(0,0,0,.28); cursor: pointer; }
.xhsc-fab.on { background: #111; }
.xhsc-panel { position: fixed; z-index: 2147483000; background: #fff; color: #111;
  display: flex; flex-direction: column; box-shadow: 0 -8px 40px rgba(0,0,0,.25);
  left: 0; right: 0; bottom: 0; height: 78vh; border-radius: 18px 18px 0 0; }
@media (min-width: 900px) {
  .xhsc-panel { left: auto; top: 0; width: 420px; height: 100vh;
    border-radius: 0; box-shadow: -8px 0 40px rgba(0,0,0,.18); }
  .xhsc-fab { bottom: 24px; }
}
.xhsc-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid #eee; }
.xhsc-title { font-size: 17px; font-weight: 700; flex: 1; }
.xhsc-x { border: none; background: #f2f2f4; width: 34px; height: 34px;
  border-radius: 17px; font-size: 17px; cursor: pointer; color: #444; }
.xhsc-tabs { display: flex; border-bottom: 1px solid #eee; }
.xhsc-tab { flex: 1; padding: 13px 0; text-align: center; font-size: 15px;
  color: #888; cursor: pointer; border-bottom: 2px solid transparent; }
.xhsc-tab.on { color: #ff2e4d; font-weight: 600; border-bottom-color: #ff2e4d; }
.xhsc-body { flex: 1; overflow-y: auto; padding: 14px 16px 28px; }
.xhsc-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.xhsc-row > label { font-size: 15px; width: 84px; flex: none; color: #333; }
.xhsc-root input[type=text], .xhsc-root input[type=number], .xhsc-root select {
  flex: 1; min-width: 0; height: 42px; padding: 0 12px; font-size: 15px;
  border: 1px solid #ddd; border-radius: 10px; background: #fff; color: #111; }
.xhsc-root button { font-size: 15px; }
.xhsc-btn { height: 42px; padding: 0 18px; border-radius: 10px; border: none;
  background: #ff2e4d; color: #fff; font-weight: 600; cursor: pointer; }
.xhsc-btn.ghost { background: #f2f2f4; color: #222; }
.xhsc-btn:disabled { opacity: .45; }
.xhsc-btns { display: flex; gap: 10px; margin: 14px 0; }
.xhsc-btns .xhsc-btn { flex: 1; }
.xhsc-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.xhsc-chip { padding: 8px 13px; border-radius: 16px; background: #f2f2f4;
  font-size: 14px; cursor: pointer; color: #444; }
.xhsc-chip.on { background: #ffe8ec; color: #ff2e4d; font-weight: 600; }
.xhsc-bar { height: 8px; border-radius: 4px; background: #eee; overflow: hidden;
  margin: 12px 0 8px; }
.xhsc-bar i { display: block; height: 100%; background: #ff2e4d; width: 0; }
.xhsc-msg { font-size: 14px; color: #444; min-height: 20px; }
.xhsc-log { margin-top: 12px; background: #fafafa; border: 1px solid #eee;
  border-radius: 10px; padding: 10px; font-size: 12.5px; line-height: 1.7;
  color: #666; max-height: 210px; overflow-y: auto;
  font-family: ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; }
.xhsc-card { border: 1px solid #eee; border-radius: 12px; padding: 12px;
  margin-bottom: 10px; }
.xhsc-card h4 { margin: 0 0 6px; font-size: 15px; font-weight: 600;
  color: #111; line-height: 1.4; }
.xhsc-card p { margin: 0 0 8px; font-size: 14px; color: #555; line-height: 1.6; }
.xhsc-meta { font-size: 12.5px; color: #999; display: flex; gap: 10px;
  flex-wrap: wrap; margin-bottom: 8px; }
.xhsc-tag { display: inline-block; padding: 2px 8px; border-radius: 9px;
  font-size: 12px; background: #f2f2f4; color: #666; }
.xhsc-tag.high { background: #ffe8ec; color: #ff2e4d; }
.xhsc-tag.mid { background: #fff4e0; color: #d68000; }
.xhsc-mini { display: flex; gap: 8px; }
.xhsc-mini button { flex: 1; height: 36px; border-radius: 9px; border: 1px solid #eee;
  background: #fff; color: #333; cursor: pointer; }
.xhsc-empty { text-align: center; color: #aaa; font-size: 14px; padding: 40px 0; }
.xhsc-warn { background: #fff4e0; color: #a35a00; border-radius: 10px;
  padding: 11px 12px; font-size: 14px; line-height: 1.6; margin-bottom: 12px; }
@media (prefers-color-scheme: dark) {
  .xhsc-panel { background: #17171a; color: #f2f2f4; }
  .xhsc-head, .xhsc-tabs { border-color: #2a2a2f; }
  .xhsc-x { background: #26262b; color: #ccc; }
  .xhsc-tab { color: #888; }
  .xhsc-row > label { color: #ccc; }
  .xhsc-root input[type=text], .xhsc-root input[type=number], .xhsc-root select {
    background: #1f1f24; border-color: #33333a; color: #f2f2f4; }
  .xhsc-btn.ghost { background: #26262b; color: #eee; }
  .xhsc-chip { background: #26262b; color: #bbb; }
  .xhsc-chip.on { background: #45161f; color: #ff8ba0; }
  .xhsc-bar { background: #2a2a2f; }
  .xhsc-log { background: #1c1c20; border-color: #2a2a2f; color: #999; }
  .xhsc-card { border-color: #2a2a2f; }
  .xhsc-card h4 { color: #f2f2f4; }
  .xhsc-card p { color: #bbb; }
  .xhsc-tag { background: #26262b; color: #aaa; }
  .xhsc-mini button { background: #1f1f24; border-color: #33333a; color: #ddd; }
}
`;

const UI = {
  root: null,
  panel: null,
  fab: null,
  open: false,
  tab: '采集',
  picked: new Set(),
};

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function mountPanel() {
  if (UI.root) return;
  const root = el('div', 'xhsc-root');
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  root.appendChild(style);

  const fab = el('button', 'xhsc-fab', '获客');
  fab.addEventListener('click', () => togglePanel());
  root.appendChild(fab);

  const panel = el('div', 'xhsc-panel');
  panel.style.display = 'none';
  panel.innerHTML =
    '<div class="xhsc-head"><div class="xhsc-title">获客助手</div>' +
    '<button class="xhsc-x">×</button></div>' +
    '<div class="xhsc-tabs"></div><div class="xhsc-body"></div>';
  root.appendChild(panel);

  document.body.appendChild(root);
  UI.root = root;
  UI.panel = panel;
  UI.fab = fab;

  panel.querySelector('.xhsc-x').addEventListener('click', () => togglePanel(false));
  const tabs = panel.querySelector('.xhsc-tabs');
  for (const name of ['采集', '帖子', '人', '设置']) {
    const t = el('div', 'xhsc-tab' + (name === UI.tab ? ' on' : ''), name);
    t.addEventListener('click', () => {
      UI.tab = name;
      for (const o of tabs.children) o.classList.toggle('on', o.textContent === name);
      renderBody();
    });
    tabs.appendChild(t);
  }
}

function togglePanel(want) {
  UI.open = want === undefined ? !UI.open : want;
  UI.panel.style.display = UI.open ? 'flex' : 'none';
  UI.fab.classList.toggle('on', UI.open);
  if (UI.open) renderBody();
}

function body() {
  return UI.panel.querySelector('.xhsc-body');
}

function renderBody() {
  const b = body();
  b.innerHTML = '';
  if (UI.tab === '采集') renderCollect(b);
  else if (UI.tab === '帖子') renderNotes(b);
  else if (UI.tab === '人') renderPeople(b);
  else renderSettings(b);
}

// ---------- 采集页 ----------

function renderCollect(b) {
  const job = Runtime.job || {};
  const running = !!job.running;

  if (!hookInstalled()) {
    b.appendChild(el('div', 'xhsc-warn',
      '钩子没装上，采不到数据。把脚本管理器里的注入方式改成页面环境，刷新重试。'));
  }

  if (running) {
    renderRunning(b, job);
    return;
  }

  // 行业
  const rowTrade = el('div', 'xhsc-row', '<label>行业</label>');
  const sel = el('select');
  for (const i of allIndustries) {
    const o = document.createElement('option');
    o.value = i.key;
    o.textContent = i.name;
    if (i.key === Trade.now.key) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', async () => {
    await Trade.switchTo(sel.value);
    UI.picked = new Set();
    renderBody();
  });
  rowTrade.appendChild(sel);
  b.appendChild(rowTrade);

  // 关键词
  const chips = el('div', 'xhsc-chips');
  const words = Trade.now.keywords.slice();
  for (const w of UI.picked) {
    if (!words.includes(w)) words.push(w);
  }
  for (const w of words) {
    const c = el('div', 'xhsc-chip' + (UI.picked.has(w) ? ' on' : ''), esc(w));
    c.addEventListener('click', () => {
      if (UI.picked.has(w)) UI.picked.delete(w);
      else UI.picked.add(w);
      renderBody();
    });
    chips.appendChild(c);
  }
  b.appendChild(chips);

  const rowAdd = el('div', 'xhsc-row');
  const inp = el('input');
  inp.type = 'text';
  inp.placeholder = '自己加一个词';
  const addBtn = el('button', 'xhsc-btn ghost', '加上');
  const doAdd = () => {
    const v = inp.value.trim();
    if (!v) return;
    UI.picked.add(v);
    inp.value = '';
    renderBody();
  };
  addBtn.addEventListener('click', doAdd);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAdd();
  });
  rowAdd.appendChild(inp);
  rowAdd.appendChild(addBtn);
  b.appendChild(rowAdd);

  // 参数
  const numRow = (label, value, min, max) => {
    const r = el('div', 'xhsc-row', '<label>' + label + '</label>');
    const i = el('input');
    i.type = 'number';
    i.value = value;
    i.min = min;
    i.max = max;
    r.appendChild(i);
    b.appendChild(r);
    return i;
  };
  const nNotes = numRow('采几篇', Limits.crawlSize, kCrawlSizeMin, kCrawlSizeMax);
  const nMin = numRow('多少分钟采完', Limits.crawlMinutes, kCrawlMinutesMin, kCrawlMinutesMax);
  const nCmt = numRow('每篇评论', 60, 0, 500);

  const rowOnly = el('div', 'xhsc-row', '<label>只要帖主</label>');
  const chk = el('input');
  chk.type = 'checkbox';
  chk.style.cssText = 'width:22px;height:22px;flex:none;';
  rowOnly.appendChild(chk);
  rowOnly.appendChild(el('div', '', ''));
  b.appendChild(rowOnly);

  const btns = el('div', 'xhsc-btns');
  const start = el('button', 'xhsc-btn', '开始采集');
  start.addEventListener('click', async () => {
    const picked = [...UI.picked];
    if (!picked.length) {
      alert('先选一个关键词');
      return;
    }
    await Limits.save(nNotes.value, nMin.value);
    start.disabled = true;
    await startCollect({
      keywords: picked,
      maxNotes: Limits.clampSize(nNotes.value),
      maxComments: asInt(nCmt.value),
      onlyOwner: chk.checked,
      trade: Trade.now.key,
    });
  });
  btns.appendChild(start);
  b.appendChild(btns);

  if (job.message) b.appendChild(el('div', 'xhsc-msg', esc(job.message)));
  if ((job.log || []).length) {
    b.appendChild(el('div', 'xhsc-log', esc(job.log.slice(-40).join('\n'))));
  }
}

function renderRunning(b, job) {
  const stats = job.stats || {};
  const bar = el('div', 'xhsc-bar', '<i></i>');
  bar.firstChild.style.width = Math.round(progressRatio(stats.done, stats.total) * 100) + '%';
  b.appendChild(el('div', 'xhsc-msg',
    esc('第 ' + (job.wi + 1) + '/' + job.keywords.length + ' 个词 ' + currentWord(job) +
      '　' + (stats.done || 0) + '/' + (stats.total || 0) + ' 篇')));
  b.appendChild(bar);
  b.appendChild(el('div', 'xhsc-msg', esc(job.message || '')));
  b.appendChild(el('div', 'xhsc-msg',
    esc('笔记 ' + (stats.notes || 0) + '　评论 ' + (stats.comments || 0))));

  const btns = el('div', 'xhsc-btns');
  const pause = el('button', 'xhsc-btn ghost', job.paused ? '继续' : '暂停');
  pause.addEventListener('click', async () => {
    if (job.paused) await resumeCollect();
    else await pauseCollect();
  });
  const stop = el('button', 'xhsc-btn', '停止');
  stop.addEventListener('click', async () => {
    await stopCollect();
  });
  btns.appendChild(pause);
  btns.appendChild(stop);
  b.appendChild(btns);

  if ((job.log || []).length) {
    b.appendChild(el('div', 'xhsc-log', esc(job.log.slice(-40).join('\n'))));
  }
}

// ---------- 帖子页 ----------

async function renderNotes(b) {
  b.appendChild(el('div', 'xhsc-empty', '读取中'));
  const rows = (await getAll('notes'))
    .filter((n) => asTrade(n.trade) === Trade.now.key)
    .sort((a, b2) => asInt(b2.likes) - asInt(a.likes));
  b.innerHTML = '';
  if (!rows.length) {
    b.appendChild(el('div', 'xhsc-empty', '还没有采到帖子'));
    return;
  }
  for (const n of rows.slice(0, 200)) {
    const c = el('div', 'xhsc-card');
    c.appendChild(el('h4', '', esc(n.title || head(n.content, 24) || '无标题')));
    c.appendChild(el('div', 'xhsc-meta',
      '<span>' + esc(n.author_name) + '</span>' +
      '<span>赞 ' + asInt(n.likes) + '</span>' +
      '<span>评论 ' + asInt(n.comment_cnt) + '</span>' +
      (n.ip_location ? '<span>' + esc(n.ip_location) + '</span>' : '') +
      (n.keyword ? '<span class="xhsc-tag">' + esc(n.keyword) + '</span>' : '')));
    if (n.content) c.appendChild(el('p', '', esc(head(n.content, 90))));
    const mini = el('div', 'xhsc-mini');
    const open = el('button', '', '打开原帖');
    open.addEventListener('click', () => {
      if (n.note_url) window.open(n.note_url, '_blank');
    });
    mini.appendChild(open);
    c.appendChild(mini);
    b.appendChild(c);
  }
}

// ---------- 人页 ----------

async function renderPeople(b) {
  b.appendChild(el('div', 'xhsc-empty', '读取中'));
  const all = await listPeople({ trade: Trade.now.key, order: 'likes' });
  const blocked = await blockedIds();
  const res = runFunnel(all, { blocked: blocked, highOnly: false });
  b.innerHTML = '';

  const s = res.stat;
  b.appendChild(el('div', 'xhsc-meta',
    '<span class="xhsc-tag">共 ' + s.all + '</span>' +
    '<span class="xhsc-tag high">高 ' + s.high + '</span>' +
    '<span class="xhsc-tag mid">中 ' + s.mid + '</span>' +
    '<span class="xhsc-tag">丢 ' + s.low + '</span>' +
    '<span class="xhsc-tag">广告 ' + s.risky + '</span>' +
    '<span class="xhsc-tag">拉黑 ' + s.blocked + '</span>'));

  if (!res.keep.length) {
    b.appendChild(el('div', 'xhsc-empty', '还没有可联系的人'));
    return;
  }
  for (const p of res.keep.slice(0, 200)) {
    const c = el('div', 'xhsc-card');
    const cls = p.intent === INTENT_HIGH ? 'high' : 'mid';
    c.appendChild(el('h4', '', esc(p.nickname || '无名') +
      ' <span class="xhsc-tag ' + cls + '">' + esc(p.intent) + '</span>'));
    c.appendChild(el('div', 'xhsc-meta',
      '<span>' + esc(p.kind) + '</span>' +
      (p.ip_location ? '<span>' + esc(p.ip_location) + '</span>' : '') +
      (p.ts ? '<span>' + esc(p.ts) + '</span>' : '')));
    c.appendChild(el('p', '', esc(head(p.said, 120))));

    const reply = makeReply(p.said, p.user_id, p.ip_location);
    const box = el('p', '', esc(reply));
    box.style.cssText = 'background:rgba(255,46,77,.07);padding:10px;border-radius:9px;';
    c.appendChild(box);

    const mini = el('div', 'xhsc-mini');
    const copy = el('button', '', '复制话术');
    copy.addEventListener('click', async () => {
      await copyText(reply);
      copy.textContent = '已复制';
      await addTouch({
        kind: '私信', note_id: p.note_id, comment_id: p.comment_id,
        user_id: p.user_id, nickname: p.nickname, text: reply,
        status: '已复制', detail: head(p.said, 60), site: p.site, trade: p.trade,
      });
    });
    const go = el('button', '', '去他主页');
    go.addEventListener('click', () => {
      const u = buildUserUrl(p.user_id);
      if (u) window.open(u, '_blank');
    });
    const ban = el('button', '', '拉黑');
    ban.addEventListener('click', async () => {
      await addTouch({
        kind: '拉黑', user_id: p.user_id, nickname: p.nickname,
        text: '', status: '已拉黑', detail: head(p.said, 60),
        site: p.site, trade: p.trade,
      });
      c.remove();
    });
    mini.appendChild(copy);
    mini.appendChild(go);
    mini.appendChild(ban);
    c.appendChild(mini);
    b.appendChild(c);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {}
  try {
    const t = document.createElement('textarea');
    t.value = text;
    t.style.cssText = 'position:fixed;top:-1000px;';
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- 设置页 ----------

async function renderSettings(b) {
  const c = await counts();
  b.appendChild(el('div', 'xhsc-meta',
    '<span class="xhsc-tag">帖子 ' + c.notes + '</span>' +
    '<span class="xhsc-tag">评论 ' + c.comments + '</span>' +
    '<span class="xhsc-tag">' + (hookInstalled() ? '钩子已装' : '钩子没装上') + '</span>'));

  const add = (text, fn, ghost) => {
    const row = el('div', 'xhsc-btns');
    const btn = el('button', 'xhsc-btn' + (ghost ? ' ghost' : ''), text);
    btn.addEventListener('click', fn);
    row.appendChild(btn);
    b.appendChild(row);
    return btn;
  };

  add('导出全部数据', async () => {
    const data = await exportAll();
    download('获客数据_' + todayCst() + '.json', JSON.stringify(data), 'application/json');
  }, true);

  add('导出人名单表格', async () => {
    const rows = await listPeople({ trade: Trade.now.key, order: 'likes' });
    const blocked = await blockedIds();
    const res = runFunnel(rows, { blocked: blocked });
    download('人_' + todayCst() + '.csv', peopleCsv(res.keep), 'text/csv');
  }, true);

  add('导出帖子表格', async () => {
    const rows = (await getAll('notes')).filter((n) => asTrade(n.trade) === Trade.now.key);
    download('帖子_' + todayCst() + '.csv', notesCsv(rows), 'text/csv');
  }, true);

  const rowImp = el('div', 'xhsc-btns');
  const file = el('input');
  file.type = 'file';
  file.accept = '.json';
  file.style.display = 'none';
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const n = await importAll(JSON.parse(await f.text()));
      alert('导入了 ' + n + ' 条');
    } catch (e) {
      alert('这个文件读不了');
    }
    renderBody();
  });
  const imp = el('button', 'xhsc-btn ghost', '导入数据文件');
  imp.addEventListener('click', () => file.click());
  rowImp.appendChild(imp);
  b.appendChild(rowImp);
  b.appendChild(file);

  add('清空采到的数据', async () => {
    if (!confirm('帖子和评论会全部删掉，先导出一份再清。确定清空？')) return;
    await clearData();
    renderBody();
  });
}


// ===== 90-main.js =====
// 入口。
//
// 钩子要在页面自己的脚本跑起来之前装好，所以这一段在 document-start 就执行。
// 界面得等 body 出来才能挂，所以分两步。

installHooks();

async function boot() {
  // 采集在跑的时候，页面每跳一次这里就重来一次，
  // 所以这几步必须便宜且可以重复做。
  await Trade.load();
  await Limits.load();
  Runtime.job = (await getJob()) || null;

  mountPanel();

  let wasRunning = null;
  Runtime.onChange = (job) => {
    if (!UI.open) {
      // 关着的时候只让按钮变个色，说明有活在跑
      UI.fab.textContent = job && job.running ? '采集中' : '获客';
      return;
    }
    if (UI.tab !== '采集') return;
    // 采集页在跑的时候没有输入框，随便重画；不跑的时候重画会把
    // 用户填了一半的参数抹掉，所以只在运行状态变了的时候重画
    const running = !!(job && job.running);
    if (running || wasRunning !== running) renderBody();
    wasRunning = running;
  };
  wasRunning = !!(Runtime.job && Runtime.job.running);
  if (wasRunning) {
    UI.fab.textContent = '采集中';
    togglePanel(true);
  }

  startHeartbeat();
  // 有没有活要接着干，问状态机自己
  await drive();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    boot();
  });
} else {
  boot();
}

// 出问题时能从控制台看一眼内部状态。
//
// 这套东西跑在别人的手机上，看不到日志，出了问题只能让人打开控制台
// 敲一句 __xhs.Buckets 看看钩子有没有收到东西。留这个口子比猜便宜得多。
window.__xhs = {
  Buckets: Buckets,
  Runtime: Runtime,
  drive: drive,
  startCollect: startCollect,
  stopCollect: stopCollect,
  parseCaptured: parseCaptured,
  Limits: Limits,
  Trade: Trade,
  hookInstalled: hookInstalled,
  exportAll: exportAll,
  importAll: importAll,
  listPeople: listPeople,
  makeReply: makeReply,
  renderBody: renderBody,
  UI: UI,
};


})();
