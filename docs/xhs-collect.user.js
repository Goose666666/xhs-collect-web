// ==UserScript==
// @name         获客助手
// @namespace    https://github.com/Goose666666/xhs-collect-web
// @version      1.3.1
// @description  在小红书和抖音页面里采集帖子和评论，挑出想找对象的人，发私信和评论
// @author       xhs-collect-web
// @match        https://www.xiaohongshu.com/*
// @match        https://xiaohongshu.com/*
// @match        https://www.douyin.com/*
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

// 把带时效的图片地址换成不过期的那一个。
//
// 采回来的地址长这样：
// sns-webpic-qc.xhscdn.com/时间/一串哈希/notes_pre_post/图片号!处理参数
// 前面那两段是签出来的，隔两天整条地址一律回 403，换什么请求头都没用，
// 表现就是翻旧帖子一片空白。换成 sns-img-qc 这个域名、只留图片号那几段，
// 同一张图永远取得到。
//
// 顺带按宽度要压缩版，列表和九宫格都用不到原图那么大。
// 认不出来的地址原样返回，不瞎改。
function stableUrl(url, width) {
  const u = asText(url);
  if (!u.includes('xhscdn.com')) return u;
  // 自己切路径，不用 URL 那个类。地址偶尔带没转义的字符，构造时会抛，
  // 而这个函数是画一行就调一次的，抛出去整页都不显示了。
  const noProto = u.replace(/^[a-z]+:\/\//i, '');
  const slash = noProto.indexOf('/');
  if (slash < 0) return u;
  const parts = noProto.slice(slash + 1).split('?')[0].split('#')[0]
    .split('/').filter(Boolean);
  if (parts.length < 2) return u;
  // 时间那一段和哈希那一段去掉，图片号后面的处理参数也去掉
  const keep = parts
    .filter((x) => !/^\d{10,14}$/.test(x))
    .filter((x) => !/^[0-9a-f]{32}$/.test(x))
    .map((x) => x.split('!')[0])
    .filter(Boolean);
  if (!keep.length) return u;
  return 'https://sns-img-qc.xhscdn.com/' + keep.join('/') +
    '?imageView2/2/w/' + (width || 540) + '/format/webp';
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


// ===== 22-douyin.js =====
// 抖音的接口解析。跟小红书那套一个路子：页面自己发请求，我们只截返回。
//
// 抖音的签名比小红书还严，参数里带 a_bogus 和 msToken，自己拼请求几乎不可能，
// 但只要让网页自己去请求，返回就是完整的，跟人工浏览没有区别。
//
// 逐条对着手机版 lib/local/douyin.dart 搬的，产出的字段跟小红书那套对齐，
// 上层不用分平台处理。

// 接口路径到桶名的映射。
//
// 抖音的搜索接口有好几个入口，通用搜索和视频搜索返回的结构一样，所以都归到 search。
const kDouyinRoutes = [
  ['/general/search/single', 'search'],
  ['/search/item', 'search'],
  ['/search/single', 'search'],
  ['/comment/list/reply', 'sub_comment'],
  ['/comment/list', 'comment'],
  ['/aweme/detail', 'feed'],
  ['/aweme/post', 'user_posted'],
  ['/user/profile/other', 'user_info'],
];

// 这个地址是不是抖音的接口，是的话属于哪一类。
function douyinBucketOf(url) {
  const s = asText(url);
  if (!s.includes('/aweme/')) return '';
  const path = s.split('?')[0].replace(/\/v\d+\//g, '/');
  for (const [frag, name] of kDouyinRoutes) {
    if (path.includes(frag)) return name;
  }
  return '';
}

// 抖音的数字有时是字符串有时是数字，统一按第一串数字读。
function dyInt(v) {
  if (typeof v === 'number') return Math.round(v);
  const m = asText(v).match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

// 作品地址。抖音的视频页就是这个格式。
function videoUrl(id) {
  return id ? 'https://www.douyin.com/video/' + id : '';
}

// 抖音的搜索页，type=general 是综合，视频和用户都在里面。
function douyinSearchUrl(keyword) {
  return 'https://www.douyin.com/search/' +
    encodeURIComponent(asText(keyword).trim()) + '?type=general';
}

// 主页地址只认 sec_uid，那是一串带字母的长码。
//
// 纯数字的是内部 uid，拿它拼出来的地址会被重定向到别处，
// 程序在错的页面上找私信按钮，找到的多半是顶栏那个消息入口。
function douyinUserUrl(secUid) {
  return secUid ? 'https://www.douyin.com/user/' + secUid : '';
}

function canOpenDouyinProfile(userId) {
  const s = asText(userId);
  // 纯数字的是内部 uid，开不了
  return s.length > 0 && /[A-Za-z_-]/.test(s);
}

// 视频封面。抖音给一串候选地址，取第一个能用的。
function dyCover(aweme) {
  for (const key of ['video', 'cover', 'images']) {
    const v = aweme[key];
    if (isMap(v)) {
      for (const k of ['origin_cover', 'cover', 'dynamic_cover']) {
        const urls = listOf(mapOf(v[k]).url_list);
        if (urls.length) return asText(urls[0]).trim();
      }
    }
    if (Array.isArray(v) && v.length) {
      const urls = listOf(mapOf(v[0]).url_list);
      if (urls.length) return asText(urls[0]).trim();
    }
  }
  return '';
}

// 图文作品的全部图片。纯视频没有这一项。
function dyImages(aweme) {
  const out = [];
  for (const it of listOf(aweme.images)) {
    const urls = listOf(mapOf(it).url_list);
    if (urls.length) out.push(asText(urls[0]).trim());
  }
  return out.join(' ');
}

// 抖音没有单独的标题，第一行就是标题。
function firstLine(s) {
  const one = asText(s).split(/[\n。！!？?]/)[0].trim();
  if (!one) return s.length > 30 ? s.slice(0, 30) : s;
  return one.length > 40 ? one.slice(0, 40) : one;
}

function dyTopics(aweme) {
  const out = [];
  for (const t of listOf(aweme.text_extra)) {
    const name = asText(mapOf(t).hashtag_name).trim();
    if (name) out.push('#' + name);
  }
  return out.join(' ');
}

// 属地。抖音给的是 IP属地:重庆 这种带前缀的写法。
function dyPlace(s) {
  return asText(s)
    .replace(/^IP属地[:：]?/, '')
    .replace(/^IP[:：]?/, '')
    .replace('中国', '')
    .trim();
}

// 属地藏在好几个位置，接口版本不同给的键还不一样，挨个试，谁先有值用谁的。
//
// CN、中国这种国家级的值等于没说，红娘要的是城市。
// 抖音只在评论里给城市，作品本身给到国家为止。
function dyIp(aweme, author) {
  for (const v of [
    aweme.ip_attribution,
    author.ip_location,
    mapOf(aweme.author).ip_location,
    mapOf(aweme.anchor_info).extra,
    aweme.region,
  ]) {
    const s = dyPlace(asText(v));
    if (!s || s.length > 8) continue;
    if (/^(CN|China|中国|cn)$/.test(s)) continue;
    return s;
  }
  return '';
}

// 一条作品。抖音把视频和图文都叫 aweme，结构一样。
function noteFromAweme(aweme, keyword) {
  const id = asText(aweme.aweme_id !== undefined ? aweme.aweme_id : aweme.awemeId).trim();
  if (!id) return null;
  const author = mapOf(aweme.author);
  const stat = mapOf(aweme.statistics);
  const desc = asText(aweme.desc).trim();

  return {
    note_id: id,
    title: firstLine(desc),
    content: desc,
    topics: dyTopics(aweme),
    // 主页地址只认 sec_uid
    author_id: asText(author.sec_uid).trim(),
    author_name: asText(author.nickname).trim(),
    likes: dyInt(stat.digg_count),
    comment_cnt: dyInt(stat.comment_count),
    ip_location: dyIp(aweme, author),
    publish_time: tsToStr(aweme.create_time),
    note_url: videoUrl(id),
    // 抖音不用 token 换取访问权，这一列留空，链接照样能开
    xsec_token: '',
    cover: dyCover(aweme),
    images: dyImages(aweme),
    keyword: keyword || '',
    fetched_at: nowCst(),
    site: '抖音',
    trade: 'love',
  };
}

// 一条评论。
function commentFromDouyin(c, noteId) {
  const id = asText(c.cid).trim();
  if (!id) return null;
  const user = mapOf(c.user);
  const reply = asText(c.reply_id).trim();
  const root = asText(c.reply_to_reply_id).trim();
  // 回复的回复要挂到根评论上，不然树形对不起来
  const parent = root && root !== '0' ? root : reply;
  const pid = parent === '0' ? '' : parent;

  return {
    comment_id: id,
    note_id: noteId || asText(c.aweme_id).trim(),
    parent_id: pid,
    level: pid ? '二级' : '一级',
    // 只认 sec_uid。拿数字 uid 拼出来的主页地址打不开，
    // 会被平台重定向到别处，私信那一步就找不着人。
    // 宁可这个人不进名单，也不能拿个开不了的地址去发。
    user_id: asText(user.sec_uid).trim(),
    nickname: asText(user.nickname).trim(),
    content: asText(c.text).replace(/\n/g, ' '),
    likes: dyInt(c.digg_count),
    sub_count: dyInt(c.reply_comment_total),
    comment_time: tsToStr(c.create_time),
    ip_location: dyPlace(asText(c.ip_label)),
    fetched_at: nowCst(),
    site: '抖音',
    trade: 'love',
  };
}

// 从搜索结果里取作品。搜索返回的是一层包装，作品在 aweme_info 里。
function douyinFromSearch(j, keyword) {
  const out = [];
  for (const it of listOf(j.data !== undefined ? j.data : j.aweme_list)) {
    const m = mapOf(it);
    // 搜索结果里混着用户卡、话题卡这些，只有带 aweme_info 的才是作品
    const aweme = m.aweme_info !== undefined
      ? mapOf(m.aweme_info)
      : (m.aweme_id !== undefined ? m : {});
    if (!Object.keys(aweme).length) continue;
    const n = noteFromAweme(aweme, keyword);
    if (n) out.push(n);
  }
  return out;
}

// 评论接口的地址上带着作品 id，用它把评论挂回作品。
function douyinNoteIdIn(url) {
  const s = asText(url);
  const i = s.indexOf('aweme_id=');
  if (i < 0) return '';
  const rest = s.slice(i + 9);
  const m = rest.match(/[&#]/);
  return m ? rest.slice(0, m.index) : rest;
}

// 解析一次拦截到的抖音返回。
function parseDouyin(url, body, keyword) {
  const kind = douyinBucketOf(url);
  if (!kind || !body) return emptyResult();
  let j;
  try {
    j = JSON.parse(body);
  } catch (e) {
    return emptyResult();
  }
  if (!isMap(j)) return emptyResult();

  const out = {
    kind: kind,
    notes: [],
    comments: [],
    hasMore: dyInt(j.has_more) === 1,
    cursor: asText(j.cursor),
  };

  switch (kind) {
    case 'search':
      out.notes = douyinFromSearch(j, keyword || '');
      return out;
    case 'user_posted':
      for (const it of listOf(j.aweme_list)) {
        const n = noteFromAweme(mapOf(it), keyword || '');
        if (n) out.notes.push(n);
      }
      return out;
    case 'feed': {
      const items = j.aweme_detail === undefined || j.aweme_detail === null
        ? listOf(j.aweme_list)
        : [j.aweme_detail];
      for (const it of items) {
        const n = noteFromAweme(mapOf(it), keyword || '');
        if (n) out.notes.push(n);
      }
      return out;
    }
    case 'comment':
    case 'sub_comment': {
      const noteId = douyinNoteIdIn(url);
      for (const it of listOf(j.comments)) {
        const c = commentFromDouyin(mapOf(it), noteId);
        if (c) out.comments.push(c);
      }
      return out;
    }
    default:
      return out;
  }
}

// ---------- 当前在哪个站 ----------

// 平台按域名定，不做开关。
//
// 两个站是两个域，浏览器的库是按域分的，抖音采的东西存在 douyin.com 名下，
// 小红书的存在 xiaohongshu.com 名下，天然分开。做一个假开关让人以为
// 在小红书页面上能看到抖音的数据，反而是骗人。
function siteNow() {
  return location.hostname.includes('douyin.com') ? '抖音' : '小红书';
}

function onDouyin() {
  return siteNow() === '抖音';
}

// 另一个站的首页，顶上那个开关点过去用。
function otherSiteUrl() {
  return onDouyin()
    ? 'https://www.xiaohongshu.com/explore'
    : 'https://www.douyin.com/';
}

// 按当前平台解析。两边的返回结构完全不同，但产出同一套字段。
function parseHere(url, body, keyword) {
  return onDouyin()
    ? parseDouyin(url, body, keyword)
    : parseCaptured(url, body, keyword);
}

// 按当前平台认接口。
function bucketHere(url) {
  return onDouyin() ? douyinBucketOf(url) : bucketOf(url);
}

// 按当前平台拼搜索页地址。
function searchUrlHere(keyword) {
  return onDouyin() ? douyinSearchUrl(keyword) : searchUrl(keyword);
}

// 按当前平台拼作品地址。
function noteUrlHere(noteId, token) {
  return onDouyin() ? videoUrl(noteId) : buildNoteUrl(noteId, token, 'pc_search');
}

// 按当前平台拼主页地址。
function userUrlHere(userId) {
  return onDouyin() ? douyinUserUrl(userId) : buildUserUrl(userId);
}

// 人要看这篇原帖时打开的地址。
//
// 抖音的 www.douyin.com/video 是整个站的单页应用，一进去就拉推荐流、
// 起播放器、装一大堆埋点，手机上卡得几乎滑不动。分享页是同一条作品的
// 轻量版，只有视频本身和作者信息，打开快得多。
//
// 采集不能走这个地址，那边不发我们要钩的那批接口。
function viewUrl(note) {
  const id = asText(note.note_id);
  if (!id) return asText(note.note_url);
  if (asSite(note.site) === '抖音') {
    return 'https://www.iesdouyin.com/share/video/' + id + '/';
  }
  return asText(note.note_url) || buildNoteUrl(id, note.xsec_token, 'pc_search');
}

// 这个人的主页开得了开不了。抖音要 sec_uid，小红书随便什么 id 都能开。
function canOpenProfile(userId) {
  return onDouyin() ? canOpenDouyinProfile(userId) : !!asText(userId);
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
      // 帖主不传帖子正文当上下文。那正是他自己写的话，
      // 拿它去反推等于拿自己推自己，推出来的性别正好是反的。
      sex: guessGender(n.author_name, said, ''),
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
    // 他在谁的帖子底下说话，这是判男女的第三档依据
    const noteText = (asText(n.title) + ' ' + asText(n.content)).trim();
    out.push({
      kind: '评论者',
      user_id: c.user_id,
      nickname: c.nickname,
      ip_location: c.ip_location,
      said: asText(c.content),
      sex: guessGender(c.nickname, c.content, noteText),
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

// ---------- 触达流水 ----------
//
// 发出去的每一条都要留痕：发给谁、发的什么、成没成、当时页面回了什么。
// 不记的话一天几条额度烧完了都不知道烧在哪。

async function touches(limit) {
  const all = await getAll('touches');
  all.sort((a, b) => asInt(b.id) - asInt(a.id));
  return limit ? all.slice(0, limit) : all;
}

// 拉黑一个人，以后一条都不再发给他。
async function blockUser(userId, nickname, why) {
  if (!userId) return;
  await addTouch({
    kind: '拉黑',
    user_id: userId,
    nickname: nickname || '',
    text: why || '手动拉黑',
    status: '成功',
  });
}

// 上一条是什么时候发的。用来拦住两条贴在一起发。
async function lastTouchAt() {
  const all = await getAll('touches');
  let best = '';
  for (const t of all) {
    if (t.kind === '拉黑') continue;
    const at = asText(t.created_at);
    if (at > best) best = at;
  }
  return best;
}

// 离上一条过去了多少秒。没发过就是很大的数。
async function secondsSinceLastTouch() {
  const at = await lastTouchAt();
  if (!at) return 1e9;
  // 存的是东八区的字符串，拿同一套换算比，不碰设备时区
  const now = nowCst();
  return Math.round((Date.parse(now.replace(' ', 'T') + 'Z') -
    Date.parse(at.replace(' ', 'T') + 'Z')) / 1000);
}

// 今天这类互动成功了多少次。用来卡每天的上限，别把号做没了。
async function touchCountToday(kind) {
  const all = await getAll('touches');
  const day = todayCst();
  return all.filter((t) => t.kind === kind && t.status === '成功' &&
    asText(t.created_at).slice(0, 10) === day).length;
}

// 试过的人，不管成没成都不再试。
//
// 只跳过成功的话，失败的下一轮又排进来。同一个人被连着试好几次，
// 而且有一种失败叫查不到发出去的消息，那种情况话可能已经发出去了
// 只是没读到证据，再发一遍就是给人连发两条。
async function triedIds(kind) {
  const all = await touches(2000);
  const out = new Set();
  for (const t of all) {
    if (t.kind === kind && t.user_id) out.add(t.user_id);
  }
  return out;
}

// 发过谁，他当初说了什么，我们回了什么。
//
// 流水表里只有我们发的话，对方原话在评论表里，按 user_id 关联。
// 一个人可能在好几条帖子底下都留过言，取最近那条，
// 因为话术就是照着最近那条生成的。
async function sentList(limit, trade) {
  const all = await touches(limit || 500);
  const comments = await getAll('comments');
  const byUser = {};
  for (const c of comments) {
    if (!c.user_id) continue;
    const old = byUser[c.user_id];
    if (!old || asText(c.comment_time) > asText(old.comment_time)) {
      byUser[c.user_id] = c;
    }
  }
  const out = [];
  for (const t of all) {
    if (t.kind !== '私信') continue;
    const c = byUser[t.user_id] || {};
    const tr = asTrade(c.trade || t.trade);
    if (trade && tr !== trade) continue;
    out.push({
      nickname: asText(t.nickname),
      user_id: asText(t.user_id),
      text: asText(t.text),
      status: asText(t.status),
      detail: asText(t.detail),
      at: asText(t.created_at),
      said: asText(c.content),
      site: asSite(c.site || t.site),
      trade: tr,
    });
  }
  return out;
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
    await Trade.loadTalks();
    return Trade.now;
  },

  async switchTo(key) {
    Trade.now = industryOf(key);
    await setSetting('industry', Trade.now.key);
    // 话术是按行业各存各的，换过去要重读，不然还用着上一个行业那几条
    await Trade.loadTalks();
    return Trade.now;
  },
};

// ---------- 评论话术 ----------
//
// 话术必须能自己改。同一句话在找对象行业说得通，换到医美就不知所云，
// 而对接人手上有美容、情感、恋爱、交友好几摊生意。
//
// 每条记着勾没勾，发评论时只从勾上的里面随机挑。
// 不想删又不想发的就取消勾选。

function talksKey(industryKey) {
  return 'talks_' + industryKey;
}

Trade.talks = [];

Trade.pickedTalks = function () {
  return Trade.talks.filter((t) => t.on).map((t) => t.text);
};

Trade.loadTalks = async function () {
  const raw = await getSetting(talksKey(Trade.now.key), null);
  if (Array.isArray(raw) && raw.length) {
    Trade.talks = raw.map((e) => ({
      text: asText(isMap(e) ? e.text : e),
      on: isMap(e) ? e.on !== false : true,
    }));
  } else {
    // 第一次进这个行业，把预置的几条铺进去，都默认勾上
    Trade.talks = Trade.now.talks.map((t) => ({ text: t, on: true }));
  }
  return Trade.talks;
};

Trade.saveTalks = async function () {
  await setSetting(talksKey(Trade.now.key), Trade.talks);
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

// ---------- 发送的节奏 ----------
//
// 采集只是看，发东西是留痕的。一天几十条加上一分钟连发，
// 是被判成营销号最快的两条路，所以这几个数比一般人想的严得多。

// 一批发几个人。
const kBatchSizeDefault = 20;
const kBatchSizeMin = 1;
const kBatchSizeMax = 60;

// 这一批用多少分钟发完。
const kBatchMinutesDefault = 20;
const kBatchMinutesMin = 5;
const kBatchMinutesMax = 240;

// 两条之间至少隔多少秒。
//
// 不是为了慢，是防止程序卡住或者页面秒开时瞬间连发好几条。
// 真人再快也要看一眼再点。
const kMinGapSeconds = 20;

// 一天最多发几条评论。私信的上限按一批算，见 batchSize。
const kCommentPerDay = 10;

// 平均每条快到什么程度就该提醒一句。
//
// 比最小间隔宽一些。二十分钟发六十个平均二十秒，刚好压在最小间隔上，
// 按最小间隔判的话它算合格，可那个速度已经不是人能做到的了。
const kSaneGapSeconds = 30;

Limits.batchSize = kBatchSizeDefault;
Limits.batchMinutes = kBatchMinutesDefault;

Limits.clampBatchSize = function (v) {
  const n = asInt(v);
  return n < kBatchSizeMin ? kBatchSizeMin : (n > kBatchSizeMax ? kBatchSizeMax : n);
};

Limits.clampBatchMinutes = function (v) {
  const n = asInt(v);
  return n < kBatchMinutesMin
    ? kBatchMinutesMin
    : (n > kBatchMinutesMax ? kBatchMinutesMax : n);
};

// 平均每条隔多少秒。用来告诉人这个组合快到什么程度。
Limits.avgGapSeconds = function () {
  return Limits.batchSize <= 1
    ? 0
    : Limits.batchMinutes * 60 / (Limits.batchSize - 1);
};

// 这个组合快不快过真人。
//
// 真快成这样也照发，只是把话说在前面。二十分钟发二十个是正常的，
// 刷到一批合适的人集中发完就是这个节奏。
Limits.tooFast = function () {
  return Limits.batchSize > 1 && Limits.avgGapSeconds() < kSaneGapSeconds;
};

// 把这一批的时间随机切成若干段。
//
// 返回的是每条发送之前要等的秒数，第一条不等所以从第二条开始算，
// 一共 n-1 段，加起来正好是设定的总时长。
//
// 切法是先给每段一个随机权重再按比例分，这样长短参差不齐。
// 平均分再加个抖动的话，所有间隔都挤在平均值附近，
// 那个规律性本身就是特征。
Limits.plan = function (n, minutes) {
  if (n <= 1) return [];
  const total = (minutes === undefined ? Limits.batchMinutes : minutes) * 60;
  const gaps = n - 1;

  // 先垫上最小间隔，剩下的才拿去随机分
  const floor = kMinGapSeconds * gaps;
  const free = total - floor;
  if (free <= 0) {
    // 时间不够垫最小间隔，那就全按最小间隔来，宁可超时也不连发
    return new Array(gaps).fill(kMinGapSeconds);
  }

  const w = [];
  for (let i = 0; i < gaps; i++) w.push(Math.random() + 0.15);
  const sum = w.reduce((a, b) => a + b, 0);
  const out = [];
  let used = 0;
  for (let i = 0; i < gaps; i++) {
    // 最后一段拿走剩下全部，免得取整之后总时长对不上
    const extra = i === gaps - 1 ? free - used : Math.round(free * w[i] / sum);
    used += extra;
    out.push(kMinGapSeconds + extra);
  }
  return out;
};

Limits.loadBatch = async function () {
  Limits.batchSize = Limits.clampBatchSize(
    await getSetting('batch_size', kBatchSizeDefault));
  Limits.batchMinutes = Limits.clampBatchMinutes(
    await getSetting('batch_minutes', kBatchMinutesDefault));
};

Limits.saveBatch = async function (size, minutes) {
  Limits.batchSize = Limits.clampBatchSize(size);
  Limits.batchMinutes = Limits.clampBatchMinutes(minutes);
  await setSetting('batch_size', Limits.batchSize);
  await setSetting('batch_minutes', Limits.batchMinutes);
};


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

// 能接上对方原话的那半句。回复里带上它，才像读过他说的话写的。
function echoOf(text) {
  return hookLine(text);
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

// ---------- 判男女 ----------
//
// 红娘要的是男女配对，一屏评论里看不出谁是男谁是女，就得逐条点进主页看。
// 平台的接口不给性别这一项，只能从这个人自己写的话、昵称、
// 以及他在什么帖子底下说话推出来。
//
// 判不出来就不标。标错比不标贵得多：给一个找女孩的男生推荐男生，
// 是这套东西最丢人的错法。

// 猜这个人是男是女。返回男、女，或者空串表示看不出来。
//
// 逐行照着手机版 lib/local/reply.dart 的同名函数写，判据和顺序完全一样，
// 两端对同一个人必须给出同一个结论，不然导出的表摞到一起会自相矛盾。
//
// 宁可不标，不可标错。判据都是明写出来的说法，含糊的一律不认。
//
// [noteText] 是他评论的那篇帖子的正文。帖主自己不要传，
// 传了会拿他自己的帖子去反推，正好推反。
function guessGender(nickname, said, noteText) {
  const byWords = theirGender(said);
  if (byWords) return byWords;

  const s = asText(said).replace(/\s+/g, '');
  // 评论区里常见的短自述。这些说法单独成句时意思很明确。
  if (/^(我)?(是)?男(的|生|滴)?[。！!~]?$/.test(s)) return '男';
  if (/^(我)?(是)?女(的|生|滴)?[。！!~]?$/.test(s)) return '女';
  if (/男嘉宾|男同胞|作为男生|我们男生|哥哥来了/.test(s)) return '男';
  if (/女嘉宾|姐妹们|作为女生|我们女生|妹妹来了|姐妹/.test(s)) return '女';

  const n = asText(nickname).replace(/\s+/g, '');
  // 昵称里的称呼。放在后面，因为它最弱：叫小哥哥的不一定是男的。
  //
  // 昵称在说要找谁的一概不认。想找个哥哥是女生说的话，
  // 按哥字判就判反了，而这种昵称在相亲帖底下并不少见。
  if (n && !/找|求|征|想要/.test(n)) {
    if (/哥$|弟$|先生$|少年|男孩|大叔|老王|小伙/.test(n)) return '男';
    if (/姐$|妹$|女士$|小姐姐|女孩|姑娘|美女|宝妈|仙女/.test(n)) return '女';
  }

  // 最后看他在谁的帖子底下说话。
  //
  // 应征的人跟发帖的人正是要凑成一对的两方，所以帖主是女的，
  // 底下举手的多半是男的。只在这个人确实在应征时才这么推，
  // 路过灌水的不算，那种人性别跟帖主没有关系。
  const post = asText(noteText);
  if (!post) return '';
  const owner = theirGender(post);
  if (!owner) return '';
  const v = judge(said, true);
  if (v !== INTENT_HIGH && v !== INTENT_MID) return '';
  return owner === '女' ? '男' : '女';
}


// ===== 56-poster.js =====
// 在页面上真的动手：找输入框、把话填进去、点发送、核对发出去没有。
//
// 这一整套是从手机版 lib/local/poster.dart 搬过来的。那边这些代码本来就是
// JavaScript，只是包在 Dart 字符串里发给 WebView 执行，搬到用户脚本里
// 反而更直接：脚本本身就跑在页面上，不用再隔一层。
//
// 两个平台的输入框长得不一样，类名还经常变，所以不写死选择器，
// 改成按特征找：可编辑的元素，占位文字里带说点什么或者评论。
// 找不到就跳过这一条，绝不乱点别的按钮。

// 发一条的结果。
//
// 分这么细是因为一天只有几条额度，报错必须能看出卡在哪一步。
const POST_OK = 'ok';
const POST_NO_BOX = 'nobox';
const POST_NO_BTN = 'nobtn';
const POST_NOT_SENT = 'notsent';
const POST_UNKNOWN = 'unknown';
const POST_NO_TARGET = 'notarget';
const POST_FAILED = 'failed';

const POST_LABEL = {
  ok: '成功',
  nobox: '没找到输入框',
  nobtn: '没找到按钮',
  notsent: '填进去了但没发出去',
  unknown: '查不到发出去的消息',
  notarget: '打不开那个人',
  failed: '失败',
};

// 脚本返回的是 nobox:INPUT|搜索 这种带后缀的串，后缀是排障用的现场信息。
// 按整串精确匹配的话全都落到出错上，真正的原因反而看不见了。
function resultOf(s) {
  const head = asText(s).split(':')[0].trim();
  return POST_LABEL[head] ? head : POST_FAILED;
}

// ---------- 风控 ----------

// 页面上有没有风控提示。
//
// 撞了风控还接着一条条发，是把限流打成封号的主要原因。
// 见到就整轮停，不要只跳过当前这条。
const kPostRiskWords = ['操作频繁', '操作太频繁', '发送频繁', '发送过于频繁',
  '请稍后再试', '稍后再试', '请勿频繁', '当前操作频繁',
  '安全验证', '滑动验证', '验证码', '人机验证', '验证中心',
  '操作存在风险', '账号异常', '账号受限', '存在安全风险',
  '无法发送', '不允许私信', '功能受限'];

function postRiskWord() {
  try {
    const t = document.body ? document.body.innerText : '';
    for (const w of kPostRiskWords) {
      if (t.indexOf(w) >= 0) return w;
    }
    // 验证码是个全屏 iframe，它的文字不进 innerText，只能按结构认
    if (document.querySelector('#captcha_container')) return '验证码遮罩';
  } catch (e) {}
  return '';
}

// ---------- 评论区 ----------

// 切到评论那个标签页。
//
// 抖音作品页右边是两个并排的标签，相关推荐和评论，默认停在相关推荐上，
// 这时候页面上一条评论都没有，直接搜昵称必然搜不到。
// 标签上写的是 评论(720) 这种带条数的文字，按这个找最准。
function openComments() {
  // 判据是评论输入框在不在，不是页面上有没有那几个字。
  //
  // 全部评论和留下你的精彩评论吧这两句在没展开评论区的页面上也会出现，
  // 拿它们当证据的结果是：一直以为评论区开着，实际上输入框压根没渲染。
  if (document.querySelector('[data-e2e="comment-input"]') ||
      document.querySelector(
        '[data-e2e="comment-list"] [contenteditable]:not([contenteditable=false])')) {
    return 'ok:已经开着';
  }
  if (document.querySelectorAll('[data-e2e="comment-item"]').length > 2) {
    return 'ok:有评论';
  }

  // 有些版本要点一下才展开，兜底认这几种写法
  const pat = [
    /^评论\s*[（(]\s*[\d.万]+\s*[)）]$/,
    /^评论\s*[\d.万]+$/,
    /^评论$/,
  ];
  const all = [...document.querySelectorAll(
    'div,span,button,a,[role=tab],[role=button],li')];
  for (const re of pat) {
    const tab = all
      .filter((e) => re.test((e.textContent || '').trim()))
      .filter((e) => {
        const r = e.getBoundingClientRect();
        // 标签本身很小，套着它的大块和看不见的都排掉
        return r.width > 16 && r.width < 300 &&
          r.height > 10 && r.height < 90 &&
          r.top >= 0 && r.top < window.innerHeight;
      })
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    if (tab) {
      tab.click();
      return 'ok:' + (tab.textContent || '').trim().slice(0, 12);
    }
  }
  return 'nobtn:没找到评论标签 元素' + all.length;
}

// ---------- 私信浮窗 ----------

// 两边都从个人主页进，主页上都有常驻的私信按钮。点了右侧才挂出聊天浮窗。
function openDm(nickname) {
  const who = asText(nickname);
  const panel = document.querySelector('[class*="componentsRightPanelwrapper"]');
  if (panel) {
    // 浮窗开着不等于开的是这个人。上一条发完浮窗会留着，
    // 不核对就往里发，等于把这条话发进上一个人的对话框。
    const title = panel.querySelector('[class*="RightPanelHeadertitle"]');
    const name = title ? (title.textContent || '').trim() : '';
    if (name && who && name.indexOf(who) >= 0) return 'ok:已经开着';
    return 'wrong:' + name;
  }

  // 只在主体内容里找私信按钮。左侧导航栏里也有私信两个字，
  // 而且排在文档前面，取第一个会点进消息中心，
  // 那里默认选中最近一次会话，话就发给上一个人了。
  const main = document.querySelector(
    'main,[class*="userDetail"],[class*="userInfo"]') || document.body;

  // 按位置认，不按顺序取第一个。
  //
  // 主页上那个私信一定跟关注按钮并排，所以先定位关注按钮，
  // 再要求私信跟它在同一行、在它右边。找不到关注按钮就退回原来那套。
  const named = [...main.querySelectorAll('button,[role=button],span,div')]
    .filter((e) => {
      const t = (e.textContent || '').trim();
      // 抖音写私信，小红书写发私信
      return t === '私信' || t === '发私信';
    })
    .filter((e) => !e.closest('nav,aside,header,[class*="navigation"],' +
      '[class*="sidebar"],[class*="header"],[class*="topbar"],[class*="nav-"]'))
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 20 && r.height > 12;
    });

  const follow = [...main.querySelectorAll('button,[role=button],div,span')]
    .filter((e) => /^(关注|已关注|互相关注)$/.test((e.textContent || '').trim()))
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width >= 44 && r.height >= 26 && r.height <= 70;
    })
    .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];

  let btn = null;
  if (follow && named.length) {
    const fr = follow.getBoundingClientRect();
    const mid = fr.top + fr.height / 2;
    btn = named.filter((e) => {
      const r = e.getBoundingClientRect();
      return Math.abs((r.top + r.height / 2) - mid) < 40;
    })[0];
  }
  if (!btn) btn = named[0];
  if (!btn) {
    // 小红书主页上私信是个没有文字的圆形气泡图标，按文字找不到，
    // 但它自己带类名 xhs-user-im-btn，直接按类名认就行。
    const im = document.querySelector(
      '.xhs-user-im-btn,[class*="xhs-user-im"],[class*="user-im-btn"]');
    if (im) {
      im.scrollIntoView({ block: 'center' });
      im.click();
      return 'ok:小红书气泡';
    }
    const body = document.body ? document.body.innerText : '';
    return 'nobtn:没有私信键 ' + body.slice(0, 30).replace(/\s+/g, ' ');
  }
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  return 'ok';
}

// 小红书那个私信键在哪。
//
// 它只认真实手势，脚本点不动，所以要把它挪到屏幕中间，
// 让人一眼看见、伸手就能按。手机版是让程序对着屏幕真按一下，
// 浏览器里没有这个本事，只能请人代劳。
function highlightDmButton() {
  const b = document.querySelector(
    '.xhs-user-im-btn,[class*="xhs-user-im"],[class*="user-im-btn"]');
  if (!b) return false;
  const r = b.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  b.scrollIntoView({ block: 'center' });
  try {
    b.style.outline = '3px solid #ff2e4d';
    b.style.outlineOffset = '3px';
    b.style.borderRadius = '50%';
  } catch (e) {}
  return true;
}

// 聊天框挂上来了没有。
function chatBoxReady() {
  return document.querySelectorAll(
    '[contenteditable]:not([contenteditable=false]),textarea').length > 0;
}

// 开出来的是消息中心还是单人对话框。
//
// 点错入口会把整个消息中心拉开，里面是一长串会话列表。那种情况下
// 页面上确实有输入框，往里填字就发给了列表里默认选中的那个人，
// 也就是最近聊过的人，跟这一轮要发的人毫无关系。
function looksLikeInbox() {
  const items = document.querySelectorAll(
    '[class*="conversationConversationItem"],[class*="ConversationItem"],' +
    '[class*="sessionItem"],[class*="chatListItem"]');
  return items.length >= 3 ? 'inbox:' + items.length : '';
}

// 发之前核对聊天窗口对面是不是目标那个人。
//
// 没有这一步的话，浮窗留存、点错入口、地址失效跳到别的页面，
// 任何一种都会把话发给错的人，而且日志全绿，事后查不出来。
function verifyPeer(nickname) {
  const who = asText(nickname);
  if (!who) return 'noname';
  // 先确认聊天窗口真的开着。窗口都没开就去比标题，比中的是页面上别的东西。
  const box = document.querySelector(
    '[class*="componentsRightPanelwrapper"],[class*="imChat"],[class*="im-chat"],' +
    '[class*="chatBox"],[class*="ChatContainer"]');
  if (!box) return 'notitle';

  const sel = '[class*="RightPanelHeadertitle"],' +
    '[class*="conversationConversationItemtitle"],' +
    '[class*="chat-header"],[class*="ChatHeader"],[class*="im-header"]';
  const nodes = [...box.querySelectorAll(sel)]
    .map((t) => (t.textContent || '').trim())
    .filter((t) => t.length > 0 && t.length < 40);
  if (!nodes.length) return 'notitle';
  for (const t of nodes) {
    // 标题里带昵称就算对上。反过来只在标题被截断时才认，
    // 否则标题两个字就能匹配上任何以它开头的昵称。
    if (t.indexOf(who) >= 0) return 'ok';
    if (t.length >= 2 && who.indexOf(t) === 0 && t.length >= who.length - 2) {
      return 'ok';
    }
  }
  return 'wrong:' + nodes.slice(0, 2).join('|');
}

// ---------- 输入框 ----------

// 找输入框并把话填进去。填字发送和只填字共用它。
//
// 两条路必须落在同一个输入框上。各写一份迟早会分叉，
// 到那时一条路发得出去另一条填不进去，还查不出差在哪。
//
// 填不进去返回一个 nobox 开头的串，填进去了返回那个元素。
function fillBox(want) {
  // 回复框的占位文字是 回复 @某某 这种，带上 @ 和昵称才认得全
  const hint = /说点什么|评论|留下|说两句|友善|发消息|发送消息|回复|@|善语结善缘/;

  // 私信的输入框先按各家的专属写法找。这些是从开源项目里扒的，
  // 比按占位文字猜准得多。找不到再走下面那套通用的。
  const named = document.querySelector(
    '.xhs-im-input-bar-editor[contenteditable="true"],' +
    '.messageEditorimChatEditorContainer [contenteditable="true"],' +
    '[class*="componentsRightPanelwrapper"] [contenteditable="true"]');

  // 找评论框。先找可编辑的 div，再找 textarea 和 input。
  //
  // 选择器不能写死 contenteditable=true：抖音的编辑器常写成
  // plaintext-only，也有光秃写个 contenteditable 的，还有不写 type 的
  // input，这三种精确匹配全都漏掉，表现就是找不到输入框。
  const box = named || (() => {
    const all = [...document.querySelectorAll(
      '[contenteditable]:not([contenteditable=false]),textarea,' +
      'input:not([type=hidden]):not([type=checkbox]):not([type=radio])')];
    const words = (e) =>
      (e.getAttribute('placeholder') || e.getAttribute('data-placeholder') ||
        e.getAttribute('aria-label') || '') + (e.textContent || '');
    const big = all.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width >= 60 && r.height >= 12;
    });

    // 回复框优先。帖主底下那个公共评论框写着留下你的精彩评论吧，
    // 在 DOM 里还排在前面，按顺序取第一个必然取到它，
    // 那样回复就变成了在人家评论区公开留言，最招举报。
    const reply = big.filter((e) => /回复|@/.test(words(e)));
    if (reply.length) return reply[0];
    const other = big.filter((e) => hint.test(words(e)));
    if (other.length) return other[0];
    // 占位文字没匹配上时，退而求其次：页面最下面那个可编辑元素
    const edits = all.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 120 && r.height > 12 && r.top > window.innerHeight * 0.4;
    });
    return edits.length ? edits[edits.length - 1] : null;
  })();

  if (!box) {
    // 把页面上所有可编辑元素的占位文字报回来，好知道输入框长什么样
    const seen = [...document.querySelectorAll(
      '[contenteditable]:not([contenteditable=false]),textarea,input')]
      .map((e) => String(e.getAttribute('placeholder') ||
        e.getAttribute('data-placeholder') ||
        e.getAttribute('aria-label') || e.tagName).slice(0, 14));
    return 'nobox:' + [...new Set(seen)].slice(0, 6).join('|') +
      ' 可编辑' + document.querySelectorAll(
        '[contenteditable]:not([contenteditable=false])').length +
      ' 浮窗' + document.querySelectorAll(
        '[class*="componentsRightPanelwrapper"]').length;
  }

  box.scrollIntoView({ block: 'center' });
  box.focus();
  box.click();

  // 填字。可编辑 div 和输入框的写法不一样，两种都要走一遍事件，
  // 不然前端框架不认这次输入，发送键一直是灰的。
  if (box.isContentEditable) {
    // 先试 execCommand。抖音的评论框是 Slate 编辑器，小红书是 Vue，
    // 这类富文本自己维护一套内部状态，直接改 textContent 它不认，
    // 发送键会一直是灰的。execCommand 会走原生的 beforeinput 和 input，
    // 效果跟真人打字一样。
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, want);
    } catch (e) {}
    if (!ok || (box.textContent || '').indexOf(want.slice(0, 4)) < 0) {
      box.textContent = want;
      box.dispatchEvent(new InputEvent('input',
        { bubbles: true, inputType: 'insertText', data: want }));
    }
  } else {
    const proto = box.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(box, want);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return box;
}

// 把话填进输入框并点发送。
function fillAndSend(text) {
  const want = asText(text);
  const box = fillBox(want);
  if (typeof box === 'string') return box;

  // 抖音给发送键挂了 data-e2e，优先用
  const marked = document.querySelector('[data-e2e="comment-publish"]');
  if (marked) {
    marked.click();
    return 'ok';
  }

  // 只认写着发送发布评论的按钮，且要在评论框附近，免得点到页面上别的地方去
  const near = box.closest('form,section,div[class*=comment],div[class*=input]') ||
    document.body;
  const btn = [...near.querySelectorAll('button,[role=button],span,div')]
    .filter((e) => /^(发送|发布|评论|发表)$/.test((e.textContent || '').trim()))[0];
  if (btn) {
    btn.click();
    return 'ok';
  }

  // 没有发送键就按回车。抖音的评论框和私信框都没有独立的发送按钮，
  // 回车即发，这是唯一的发送方式。
  //
  // 回车要打给重新查出来的那个元素：Slate 编辑器在首次输入之后会把
  // 原来的节点换掉，拿着旧引用发按键，事件落在一个已经脱离文档的
  // 节点上，什么都不会发生。
  const live = document.querySelector(
    '.xhs-im-input-bar-editor[contenteditable="true"],' +
    '.messageEditorimChatEditorContainer [contenteditable="true"],' +
    '[class*="componentsRightPanelwrapper"] [contenteditable="true"]') || box;
  live.focus();
  for (const type of ['keydown', 'keypress', 'keyup']) {
    live.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true, cancelable: true,
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    }));
  }
  return 'ok';
}

// 只把话填进输入框，不点发送。
//
// 最后那一下留给人自己按，所以连回车都不能派。私信框回车即发，
// 派一个就等于替人做了决定，这条路的意义正是不替人做这个决定。
function fillOnly(text) {
  const box = fillBox(asText(text));
  return typeof box === 'string' ? box : 'ok';
}

// ---------- 核对 ----------

// 发完之后看看到底发出去没有。
//
// 要正着找证据：会话里最后那条自己发的气泡，文字对得上才算数。
// 反着看输入框空不空全是坑：安全验证会把整个聊天浮窗从 DOM 里摘走，
// 一个可编辑元素都遍历不到；前端按回车先清框再发请求，请求被频控挡掉
// 框也一样是空的；富文本发完还会换掉节点，新节点本来就是空的。
// 三种情况都会报成功，而一天只有几条额度。
function checkSent(text) {
  const want = asText(text);
  // 前后空白在气泡里会被重排，比对前一律去掉
  const norm = (s) => (s || '').replace(/\s+/g, '');
  const key = norm(want).slice(0, 12);
  if (!key) return 'unknown:没有话可比对';

  // 输入框清空只当辅助信号，单独不作数，只跟在结论后面帮着排障。
  let cleared = true;
  for (const b of document.querySelectorAll(
      '[contenteditable]:not([contenteditable=false]),textarea,input')) {
    const t = (b.isContentEditable ? b.textContent : b.value) || '';
    if (norm(t).indexOf(key) >= 0) cleared = false;
  }

  // 找自己发出去的那条气泡。这些类名是从开源项目扒来的，平台一改版就失效，
  // 所以排成一串候选逐个试，前面的选不出来就往后退。
  const sels = [
    '.xhs-im-bubble__text',
    '[class*="MessageItem"][class*="isFromMe"] [class*="pureText"]',
    '[class*="MessageItem"][class*="isFromMe"] [class*="bubbleTextContent"]',
    '[class*="isFromMe"] [class*="pureText"]',
    '[class*="isFromMe"] [class*="bubbleTextContent"]',
    '[class*="MessageItem"][class*="isFromMe"]',
    '[class*="isFromMe"]',
  ];
  let mine = [];
  for (const s of sels) {
    const got = [...document.querySelectorAll(s)];
    if (got.length) {
      mine = got;
      break;
    }
  }

  if (mine.length) {
    const texts = mine.map((e) => norm(e.innerText || e.textContent || ''));
    // 只看末尾几条。整段会话里可能有以前发过的同一句话，
    // 全表搜等于把上一次的成绩算到这一次头上。
    for (let i = texts.length - 1; i >= 0 && i > texts.length - 4; i--) {
      if (texts[i].indexOf(key) >= 0) return 'ok:气泡';
    }
    return 'notsent:气泡' + texts.length + '条都不是这句 清空' + (cleared ? '是' : '否');
  }

  // 评论区没有气泡这一说。退一步找：这句话出现在某个不能编辑的元素里，
  // 说明它已经进了列表，不是还留在输入框里没发出去。
  const posted = [...document.querySelectorAll('span,div,p')]
    .filter((e) => e.children.length === 0)
    .filter((e) => norm(e.textContent || '').indexOf(key) >= 0)
    .filter((e) => !e.closest('[contenteditable]:not([contenteditable=false]),textarea'));
  if (posted.length) return 'ok:列表';

  // 找不到就明说找不到。含糊报成功是最贵的一种错。
  return 'unknown:没找到发出去的那条 清空' + (cleared ? '是' : '否');
}

// ---------- 回复某条评论 ----------

// 在评论区找到这个人那条评论，点它的回复。
//
// 只回复评论区的人，不去帖主底下留言。帖主的评论区是公开的门面，
// 陌生人往那儿贴广告最招人烦，也最容易被举报。回复某条评论要软得多，
// 而且评论区的人本来就是主动来搭话的，转化也高。
//
// 昵称为空直接放弃，绝不退回去评论帖主。
function clickReply(nickname) {
  const who = asText(nickname);
  if (!who) return 'nofound';

  // 先找到写着这个昵称的那一块，再从这块里找回复。
  //
  // 抖音给评论项挂了 data-e2e 属性，比 class 名稳，改版也不容易变，
  // 有它就直接用，省掉下面那套从小往外扩的猜法。
  const marked = [...document.querySelectorAll('[data-e2e="comment-item"]')]
    .filter((e) => (e.innerText || '').indexOf(who) >= 0)[0];
  if (marked) {
    marked.scrollIntoView({ block: 'center' });
    const b = [...marked.querySelectorAll('button,[role=button],span,div,a,p')]
      .filter((e) => /^(回复|回覆)$/.test((e.textContent || '').trim()))[0];
    if (b) {
      b.click();
      return 'ok:标记项';
    }
  }

  // 取最小的那块会只圈住昵称本身，回复按钮在外面；取最大的又会圈住
  // 整个评论区。所以从最小的往外走，直到这块里既有昵称又有别的内容，
  // 那才是一整条评论。
  const nodes = [...document.querySelectorAll('div,section,li,article')]
    .filter((e) => (e.innerText || '').indexOf(who) >= 0)
    .filter((e) => (e.innerText || '').length < 600)
    .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
  if (!nodes.length) return 'nofound';

  let item = nodes[0];
  // 往外走几层，找到装得下整条评论的那一块
  for (let i = 0; i < 6; i++) {
    const t = (item.innerText || '').trim();
    if (t.length > who.length + 6 && item.querySelectorAll('*').length > 3) break;
    if (!item.parentElement) break;
    item = item.parentElement;
  }
  item.scrollIntoView({ block: 'center' });

  // 网页版的回复按钮是鼠标悬停才冒出来的，手机上没有悬停这回事，
  // 所以先手动派一串鼠标事件过去，把它逼出来。
  for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
    item.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
  }

  // 不按尺寸筛。
  //
  // 桌面版把回复按钮做成鼠标悬停才显形，量出来是 0x0，按尺寸筛
  // 等于亲手把唯一能用的那个扔了。click 根本不看元素可不可见，
  // 藏起来的照样点得动。
  const find = (scope) =>
    [...scope.querySelectorAll('button,[role=button],span,div,a,p')]
      .filter((e) => /^(回复|回覆)$/.test((e.textContent || '').trim()))[0];

  let btn = find(item);
  if (!btn) {
    // 悬停事件有时候要一帧才生效，同步再找一次
    item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
    btn = find(item);
  }
  if (!btn) {
    // 派发的事件触发不了 CSS 的 hover，那是靠真实指针位置驱动的。
    // 所以直接把它强制显示出来，连同上面几层一起刷，
    // 因为藏起来的往往是外层那个容器。
    const hidden = [...item.querySelectorAll('*')]
      .filter((e) => /^(回复|回覆)$/.test((e.textContent || '').trim()));
    for (const h of hidden) {
      let n = h;
      for (let i = 0; i < 4 && n && n !== item; i++) {
        n.style.setProperty('display', 'inline-block', 'important');
        n.style.setProperty('visibility', 'visible', 'important');
        n.style.setProperty('opacity', '1', 'important');
        n.style.setProperty('pointer-events', 'auto', 'important');
        n = n.parentElement;
      }
    }
    btn = find(item);
  }
  if (!btn) {
    // 往上退一层再找。只退一层：退两层就到整个评论列表了，
    // 那时候取到的是别人那条评论的回复按钮，话会回给错的人。
    const up = item.parentElement;
    if (up && (up.innerText || '').indexOf(who) >= 0 &&
        (up.innerText || '').length < 800) {
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
        up.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
      }
      btn = find(up);
    }
  }
  if (!btn) {
    // 还是没有，把这一块和它父级的短文字全报回来，好知道按钮到底叫什么
    const scope = item.parentElement || item;
    const words = [...scope.querySelectorAll('span,div,button,a')]
      .map((e) => (e.textContent || '').trim())
      .filter((t) => t.length > 0 && t.length < 8);
    return 'nobtn:' + [...new Set(words)].slice(0, 12).join('|');
  }

  // 直接点，不派那一串事件。
  //
  // 逐层派 touch、pointer、mouse、click 会一次发出去三十多个事件，
  // 其中好几个 click 逐层冒泡到根监听器。React 那种在根节点收事件的
  // 框架会看到多次独立点击，开关式的处理器就变成开关开关，净结果是没开。
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  return 'ok';
}


// ===== 57-draft.js =====
// 照着一条评论写一句回复。
//
// 评论区里的人说什么，回什么。群发同一句话谁都看得出来，也最容易被举报，
// 而看得出你读了他那句话的回复，才会有人来问。
//
// 找对象行业有一整套读条件的规则，直接用那份。别的行业没有那么细的判据，
// 就从这个行业自己的话术里挑一条，能接上对方原话的排前面。
//
// 逐行照着手机版 lib/local/draft.dart 写，两端出的话必须一样。

// 给这条评论写一句回复。
//
// said 是对方说的话，who 是他的昵称或者 id，where 是属地。
// nonce 换一个数就换一句，用来实现换一句。
function draftFor(opt) {
  const o = opt || {};
  const said = asText(o.said);
  const who = asText(o.who);
  const where = asText(o.where);
  const nonce = asInt(o.nonce);

  if (Trade.now.key === 'love') {
    return makeReply(said, who + nonce, where);
  }
  const talks = draftTalks();
  if (!talks.length) return '';
  const ranked = rankTalks(talks, said);
  const one = ranked[Math.abs(nonce) % ranked.length];
  // 接上对方那半句原话，这条回复才像是读过他说的话写的。
  // 接不上就只发话术本身，硬拼一句反而更假。
  const echo = echoOf(said);
  return echo ? '看你说' + echo + '，' + one : one;
}

// 可用的话术。勾上的优先，一条都没勾就用这个行业预置的那几条。
function draftTalks() {
  const picked = Trade.pickedTalks();
  if (picked.length) return picked;
  const all = Trade.talks.map((t) => t.text).filter(Boolean);
  return all.length ? all : Trade.now.talks;
}

// 能接上对方原话的排前面。
//
// 判据只有一条：这句话术里出现了对方也提到的那个词。相亲帖里有人说想脱单，
// 底下回一句带脱单的话，比回一句通用寒暄贴切得多。
function rankTalks(talks, said) {
  const s = asText(said).replace(/\s+/g, '');
  if (!s) return talks;
  const words = Trade.now.wantWords || [];
  const hit = [];
  const rest = [];
  for (const t of talks) {
    const touched = words.some((w) => s.includes(w) && t.includes(w));
    (touched ? hit : rest).push(t);
  }
  return hit.concat(rest);
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
// 性别接在最后一列。
//
// 手机版那张表没有这一列，摆在中间会让两边的表摞不齐；
// 挂在末尾的话，前八列还是一一对上的，手机版导出的行只是最后一格空着。
const peopleHeader = ['昵称', '类型', '属地', '说的话', '时间', '点赞', '关键词',
  '笔记标题', '性别'];
const notesHeader = ['标题', '作者', '属地', '正文', '话题标签', '发布时间', '点赞', '评论', '关键词', '笔记链接'];
const commentsHeader = ['昵称', '属地', '说的话', '时间', '点赞', '关键词', '笔记标题'];

function peopleCsv(rows) {
  return csvText(peopleHeader, rows.map((r) => [
    r.nickname, r.kind, r.ip_location, r.said, r.ts, r.likes, r.keyword,
    r.note_title, r.sex,
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
    // 两个平台的路径没有交集，所以两张表都试一遍就行，
    // 不用先知道当前在采哪个平台。
    const name = bucketOf(url) || douyinBucketOf(url);
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
    return noteUrlHere(h.note_id, h.xsec_token);
  }
  return searchUrlHere(currentWord(job));
}

// 现在这个页面是不是该干活的那个。
function onWantedPage(job) {
  const path = location.pathname;
  if (job.phase === 'note') {
    const h = currentHit(job);
    if (!h) return false;
    // 小红书是 /explore/id，抖音是 /video/id
    return path.indexOf('/explore/' + h.note_id) === 0 ||
      path.indexOf('/video/' + h.note_id) === 0;
  }
  if (onDouyin()) {
    // 抖音把关键词放在路径里，不是查询串里
    if (path.indexOf('/search/') !== 0) return false;
    let word = '';
    try {
      word = decodeURIComponent(path.slice('/search/'.length));
    } catch (e) {}
    return word === currentWord(job);
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
    const got = parseHere(pack.url, pack.body, word);
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
    const got = parseHere(pack.url, pack.body, '');
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
    // 小红书没有 token 打不开笔记，这种直接不要，免得白跑一趟。
    // 抖音压根不用 token，一律要求有 token 的话，抖音会一篇都采不到。
    .filter((n) => n.note_id && (onDouyin() || n.xsec_token));

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
  note.note_url = note.note_url || noteUrlHere(note.note_id, note.xsec_token);

  for (const c of comments) {
    if (!c.note_id) c.note_id = hit.note_id;
  }

  // 平台在这里定死，不留给后面去猜。以前是看 xsec_token 空不空反推，
  // 重采一次把 token 覆盖没了，人就被判到另一个平台去了。
  const freshNotes = await saveNotes([note], word, siteNow(), job.trade);
  const freshComments = await saveComments(comments, siteNow(), job.trade);
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
  // 起头就返回，理由同发送那边：这一轮要跑几十分钟，等在这儿没有意义
  drive();
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


// ===== 74-sender.js =====
// 发私信和发评论。
//
// 跟采集一样是一台状态机：每发一条就跳一次页面，脚本被重新加载，
// 所以进度只能存在库里，新页面起来读回去接着发。
//
// 跟手机版的区别只有一处，但很关键：小红书个人主页上那个私信键
// 只认真实手势，浏览器里派多少事件它都不理。手机版是让程序对着屏幕
// 真按一下绕过去的，用户脚本没有这个本事，所以到那一步会停下来，
// 把按键标红请人按一下，按完程序接着把话填进去发出去。
// 抖音那个私信键脚本点得动，全程不用人管。

const SEND_KEY = 'send';

const Sender = {
  job: null,
  stopFlag: false,
  pauseFlag: false,
  busy: false,
  onChange: null,
};

function emitSend() {
  if (Sender.onChange) {
    try { Sender.onChange(Sender.job); } catch (e) {}
  }
}

async function getSendJob() {
  return await getOne('job', SEND_KEY);
}

async function saveSendJob(patch) {
  const job = Object.assign({}, Sender.job || {}, patch || {});
  job.id = SEND_KEY;
  job.tab = TAB_ID;
  job.beat = Date.now();
  Sender.job = job;
  await putOne('job', job);
  emitSend();
  return job;
}

async function saySend(line, extra) {
  const job = Sender.job || {};
  await saveSendJob(Object.assign(
    { message: line, log: logLine(job, line) }, extra || {}));
}

// ---------- 挑人 ----------

// 挑出该发的人。
//
// 三道关：拉黑过的直接剔掉，广告号水军灌水的过不了漏斗，试过的人不再试。
// 同一个人发两遍最招人烦，也最容易被举报。
async function pickTargets(all, kind) {
  const blocked = await blockedIds();
  // 判的是对方原话。拿要发出去的话术去判，等于问我们自己有没有意向。
  const r = runFunnel(all, { blocked: blocked });
  const done = await triedIds(kind);
  const left = kind === '私信' ? Limits.batchSize : kCommentPerDay;

  const out = [];
  let skipped = 0;
  // 开不了主页的和没帖子的分开数。混在一起报的话，界面上只会说
  // 一个都发不了，看不出到底是被漏斗筛掉了还是地址有问题。
  let noWay = 0;
  for (const t of r.keep) {
    if (out.length >= left) break;
    // 私信只要有人就行，评论还得有帖子
    if (kind === '评论' && !t.note_id) {
      noWay += 1;
      continue;
    }
    // 地址开不了的人直接跳过，不拿一个会被重定向的地址去发
    if (kind === '私信' && !canOpenProfile(t.user_id)) {
      noWay += 1;
      continue;
    }
    if (!asText(t.text).trim()) {
      noWay += 1;
      continue;
    }
    if (t.user_id && done.has(t.user_id)) {
      skipped += 1;
      continue;
    }
    if (t.user_id) done.add(t.user_id);
    out.push(t);
  }
  return { list: out, stat: r.stat, skipped: skipped, noWay: noWay };
}

// 一个都挑不出来时要说清楚为什么。
//
// 一声不吭跑完的话，界面上进度条一收，看着就像按钮点了没反应。
function whyNone(picked, total) {
  const stat = picked.stat;
  const why = [];
  if (stat.blocked > 0) why.push('拉黑过 ' + stat.blocked + ' 个');
  if (stat.risky > 0) why.push('广告号 ' + stat.risky + ' 个');
  if (stat.low > 0) why.push('看不出有意向 ' + stat.low + ' 个');
  if (picked.skipped > 0) why.push('试过 ' + picked.skipped + ' 个');
  if (picked.noWay > 0) why.push('打不开 ' + picked.noWay + ' 个');
  return why.length
    ? '这 ' + total + ' 个人都没发：' + why.join('，')
    : '这批人一个都发不了';
}

// ---------- 开跑 ----------

// kind 是私信或者评论。评论一律只填字，最后那一下由人自己按。
async function startSend(people, kind) {
  if (Runtime.job && Runtime.job.running) {
    return { ok: false, why: '采集还在跑，先停下来再发' };
  }
  // 话没准备好就现生成一条。
  //
  // 界面上那几个入口都会先把话备好，但这个函数也是排障时直接调的口子，
  // 少了这一步会静静地一个人都挑不出来，谁也看不出是因为没有话可发。
  const all = (people || []).map((p) => Object.assign({}, p, {
    text: asText(p.text).trim() || makeReply(p.said, p.user_id, p.ip_location),
  }));
  const picked = await pickTargets(all, kind);
  if (!picked.list.length) {
    return { ok: false, why: whyNone(picked, all.length) };
  }
  Sender.stopFlag = false;
  Sender.pauseFlag = false;

  const targets = picked.list.map((p) => ({
    note_id: p.note_id,
    xsec_token: p.xsec_token,
    user_id: p.user_id,
    nickname: p.nickname,
    said: p.said,
    text: p.text,
    site: p.site,
  }));

  await saveSendJob({
    running: true,
    paused: false,
    kind: kind,
    // 公开评论一律真人按最后那一下。评论是贴在别人门面上的，最招举报。
    byHand: kind === '评论',
    targets: targets,
    i: 0,
    // 开跑之前把这一批的时间切好。发几个人是定的，总时长也是定的，
    // 中间怎么分由这里一次算完，长短参差不齐，加起来正好是设定的总时长。
    gaps: kind === '私信' ? Limits.plan(targets.length) : [],
    stats: { ok: 0, fail: 0, done: 0 },
    trade: Trade.now.key,
    nextAt: 0,
    waiting: '',
    message: '准备开始',
    log: [],
  });
  // 起头就返回，不等这一批跑完。
  //
  // 这一批可能要发二十分钟，中间还会跳页面、停下来等人按键。
  // 调用方等在这儿的话，界面上那个按钮会一直转，
  // 真正的进度反而要靠状态回调才看得到。
  driveSend();
  return { ok: true, n: targets.length };
}

async function pauseSend() {
  Sender.pauseFlag = true;
  await saveSendJob({ paused: true, message: '暂停了，点继续接着发' });
}

async function resumeSend() {
  Sender.pauseFlag = false;
  await saveSendJob({ paused: false, message: '接着发' });
  if (!Sender.busy) await driveSend();
}

async function stopSend() {
  Sender.stopFlag = true;
  Sender.pauseFlag = false;
  await saveSendJob({ paused: false, message: '收到停止，等这一条走完' });
  if (!Sender.busy) await finishSend('已停止');
}

async function finishSend(status) {
  Sender.stopFlag = false;
  Sender.pauseFlag = false;
  const job = Sender.job || {};
  const s = job.stats || { ok: 0, fail: 0 };
  const line = status + '，成功 ' + s.ok + ' 失败 ' + s.fail;
  await saveSendJob({
    running: false,
    paused: false,
    waiting: '',
    targets: [],
    message: line,
    log: logLine(job, line),
  });
}

// 人已经在页面上按过发送了，接着下一个。
async function humanDone() {
  if (!Sender.job || !Sender.job.waiting) return;
  await saveSendJob({ waiting: '' });
}

// ---------- 等待 ----------

function sendStopped() {
  return Sender.stopFlag;
}

async function sendNap(ms, note) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (sendStopped()) return;
    while (Sender.pauseFlag && !Sender.stopFlag) await sleep(400);
    if (sendStopped()) return;
    const left = Math.ceil((until - Date.now()) / 1000);
    if (note && left > 0) {
      Sender.job = Object.assign({}, Sender.job, { message: note + ' ' + left + ' 秒' });
      emitSend();
    }
    await sleep(Math.min(500, Math.max(50, until - Date.now())));
  }
}

// 等人在页面上动手。等不到就一直等，人不动这条就不算发过。
async function waitHuman(what, ready) {
  await saveSendJob({ waiting: what });
  for (let i = 0; i < 1200 && !sendStopped(); i++) {
    if (ready && ready()) break;
    if (!Sender.job || !Sender.job.waiting) break;
    await sleep(500);
  }
  const got = ready ? ready() : true;
  await saveSendJob({ waiting: '' });
  return got;
}

// ---------- 一条 ----------

function sendTarget(job) {
  return (job.targets || [])[job.i] || null;
}

function sendWantUrl(job) {
  const t = sendTarget(job);
  if (!t) return '';
  return job.kind === '私信'
    ? userUrlHere(t.user_id)
    : noteUrlHere(t.note_id, t.xsec_token);
}

function onSendPage(job) {
  const t = sendTarget(job);
  if (!t) return false;
  const want = job.kind === '私信' ? t.user_id : t.note_id;
  return !!want && location.href.indexOf(want) >= 0;
}

// 等页面真的把内容渲染出来再动手。
//
// 只按秒数等的话，网慢一点就在半成品页面上乱找，白跑一轮。
// 门槛按页面类型分：个人主页就一个昵称几个数字，简介还常常是空的，
// 按三百字等永远等不到。
async function waitPageReady(want, isDm) {
  for (let i = 0; i < 12 && !sendStopped(); i++) {
    await sendNap(2000);
    // 地址对不对优先判。地址失效会跳首页或者登录页，
    // 那些页面文字反而更多，只看字数会以为加载好了。
    if (want && location.href.indexOf(want) < 0) {
      return 'wrong:' + location.href.slice(0, 60);
    }
    const t = document.body ? document.body.innerText : '';
    if (t.length > (isDm ? 60 : 300)) return 'ok';
  }
  return 'slow';
}

// 发一条私信。
async function sendOneDm(t) {
  const trace = [];
  const note = (s) => trace.push(s);

  const ready = await waitPageReady(t.user_id, true);
  if (ready.indexOf('wrong') === 0) {
    note('跑到别的页面了 ' + ready);
    return { result: POST_NO_TARGET, detail: trace.join(' | ') };
  }
  note('页面 ' + ready);

  const risk = postRiskWord();
  if (risk) {
    note('撞到风控 ' + risk);
    return { result: POST_FAILED, detail: trace.join(' | '), risk: risk };
  }

  // 先让脚本自己点。抖音这一下就成了，小红书多半点不动。
  let open = '';
  for (let i = 0; i < 4 && !sendStopped(); i++) {
    open = openDm(t.nickname);
    if (open.indexOf('ok') === 0) break;
    await sendNap(2500, '等私信键出现');
  }
  note('点私信键 ' + open);

  // 点不动就请人按。
  //
  // 小红书那个键只认真实手势，脚本里 click 也好，派一整套鼠标和指针
  // 事件也好，页面一点反应都没有。手机版是对着屏幕真按一下，
  // 浏览器里做不到，所以把键标红请人按，这是唯一诚实的做法。
  if (!chatBoxReady()) {
    const marked = highlightDmButton();
    await saySend(marked
      ? '点一下页面上标红那个私信键，我接着把话发出去'
      : '在页面上打开跟 ' + (t.nickname || '这个人') + ' 的私信，我接着发');
    const got = await waitHuman('dmkey', chatBoxReady);
    note('等人按私信键 ' + (got ? '开了' : '没开'));
    if (!got) return { result: POST_NO_BTN, detail: trace.join(' | ') };
  }

  // 浮窗是异步挂上来的，实测一秒多到十几秒都有
  for (let i = 0; i < 10 && !chatBoxReady() && !sendStopped(); i++) {
    await sendNap(1500, '等聊天框挂上来');
  }
  if (!chatBoxReady()) {
    note('聊天框没挂上来');
    return { result: POST_NO_BOX, detail: trace.join(' | ') };
  }

  // 点错入口会把整个消息中心拉开，里面是一长串会话列表。
  // 那种情况下页面上确实有输入框，往里填字就发给了最近聊过的人。
  const inbox = looksLikeInbox();
  if (inbox) {
    note('开出来的是消息中心 ' + inbox);
    return { result: POST_NO_TARGET, detail: trace.join(' | ') };
  }

  const peer = verifyPeer(t.nickname);
  note('核对对面 ' + peer);
  if (peer.indexOf('wrong') === 0) {
    return { result: POST_NO_TARGET, detail: trace.join(' | ') };
  }

  const sent = fillAndSend(t.text);
  note('填字发送 ' + sent);
  if (resultOf(sent) !== POST_OK) {
    return { result: resultOf(sent), detail: trace.join(' | ') };
  }

  // 发完等一会儿再核对。请求还在路上就去找气泡，一定找不到。
  await sendNap(3000);
  const check = checkSent(t.text);
  note('核对结果 ' + check);
  return { result: resultOf(check), detail: trace.join(' | ') };
}

// 发一条评论。只填字，最后那一下由人自己按。
//
// 人按下去的那一刻程序看不见，所以这条路不查发送结果、不记流水、
// 也不占今天的额度。记了就是拿猜的结果冒充事实。
async function sendOneComment(t) {
  const ready = await waitPageReady(t.note_id, false);
  if (ready.indexOf('wrong') === 0) return { result: POST_NO_TARGET, detail: ready };

  const risk = postRiskWord();
  if (risk) return { result: POST_FAILED, detail: '风控 ' + risk, risk: risk };

  if (onDouyin()) {
    const open = openComments();
    if (open.indexOf('ok') !== 0) await sendNap(3000, '等评论区展开');
  }

  // 带昵称的是回复某个人，先在评论区找到他那条评论点回复，
  // 挂在他下面他才会收到通知。
  //
  // 不做这一步的话，话会填进帖主底下那个公共评论框，
  // 变成在人家评论区公开留言，那是最招举报的一种发法。
  if (t.nickname) {
    let hit = '';
    for (let i = 0; i < 4 && !sendStopped(); i++) {
      hit = clickReply(t.nickname);
      if (hit.indexOf('ok') === 0) break;
      // 评论是懒加载的，翻一屏再找
      scrollSome(randInt(600, 1000));
      await sendNap(2500, '在评论区找这个人');
    }
    if (hit.indexOf('ok') !== 0) {
      return { result: POST_NO_TARGET, detail: '评论区里找不到这个人 ' + hit };
    }
    await sendNap(1200);
  }

  let filled = '';
  for (let i = 0; i < 4 && !sendStopped(); i++) {
    filled = fillOnly(t.text);
    if (filled.indexOf('ok') === 0) break;
    await sendNap(2500, '等评论框出现');
  }
  if (filled.indexOf('ok') !== 0) return { result: resultOf(filled), detail: filled };

  await saySend('话填好了，你按页面上的发送键，然后点下一个');
  await waitHuman('send', null);
  return { result: 'byhand', detail: '人自己按的' };
}

// ---------- 状态机 ----------

async function driveSend() {
  if (Sender.busy) return;
  const job = Sender.job;
  if (!job || !job.running) return;
  if (job.tab && job.tab !== TAB_ID && Date.now() - (job.beat || 0) < TAKEOVER_MS) {
    return;
  }
  if (job.paused) {
    Sender.pauseFlag = true;
    return;
  }

  Sender.busy = true;
  try {
    const t = sendTarget(job);
    if (!t) {
      await finishSend('完成');
      return;
    }
    if (!onSendPage(job)) {
      const url = sendWantUrl(job);
      if (!url) {
        await nextTarget(null);
        return;
      }
      const left = (job.nextAt || 0) - Date.now();
      if (left > 0) await sendNap(left, '歇一下，还有');
      if (sendStopped()) {
        await finishSend('已停止');
        return;
      }
      await saySend('打开 ' + (t.nickname || t.note_id));
      location.href = url;
      return;
    }

    const got = job.kind === '私信' ? await sendOneDm(t) : await sendOneComment(t);
    if (got.risk) {
      // 撞了风控还接着一条条发，是把限流打成封号的主要原因。
      // 见到就整轮停，不要只跳过当前这条。
      await saySend('页面提示「' + got.risk + '」，全停了，今天别再发');
      await finishSend('撞风控停了');
      return;
    }
    await nextTarget(got);
    if (sendStopped() && Sender.job && Sender.job.running) {
      await finishSend('已停止');
    }
  } catch (e) {
    await saySend('出错了 ' + (e && e.message ? e.message : e));
    await finishSend('已停止');
  } finally {
    Sender.busy = false;
  }
}

async function nextTarget(got) {
  const job = Sender.job;
  const t = sendTarget(job);
  const stats = Object.assign({}, job.stats);
  let line = '';

  if (got && t) {
    if (got.result === 'byhand') {
      // 人自己按的，不记流水也不算数
      line = '[' + (job.i + 1) + '/' + job.targets.length + '] ' +
        (t.nickname || '') + ' 话填好了';
    } else {
      const ok = got.result === POST_OK;
      stats[ok ? 'ok' : 'fail'] += 1;
      await addTouch({
        kind: job.kind,
        note_id: t.note_id,
        user_id: t.user_id,
        nickname: t.nickname,
        text: t.text,
        status: ok ? '成功' : '失败',
        detail: (ok ? '' : POST_LABEL[got.result] + ' ') + (got.detail || ''),
        site: t.site,
        trade: job.trade,
      });
      line = '[' + (job.i + 1) + '/' + job.targets.length + '] ' +
        (t.nickname || '') + ' ' + (ok ? '发出去了' : POST_LABEL[got.result]);
    }
  }
  stats.done += 1;

  const i = job.i + 1;
  if (i >= job.targets.length || sendStopped()) {
    await saveSendJob({ i: i, stats: stats, message: line, log: logLine(job, line) });
    await finishSend(sendStopped() ? '已停止' : '完成');
    return;
  }

  // 间隔是一开始就随机切好的，长短参差不齐，加起来正好是设定的总时长。
  // 每次现算一个随机数的话，所有间隔都挤在平均值附近。
  const gap = (job.gaps || [])[job.i] || kMinGapSeconds;
  await saveSendJob({
    i: i,
    stats: stats,
    message: line,
    log: logLine(job, line),
    nextAt: Date.now() + gap * 1000,
  });
  await sendNap(gap * 1000, '歇一下，还有');
  if (sendStopped()) {
    await finishSend('已停止');
    return;
  }
  const url = sendWantUrl(Sender.job);
  if (url) location.href = url;
  else await finishSend('完成');
}


// ===== 80-ui.js =====
// 悬浮面板。整套界面都在这一个盒子里，不动平台自己的页面。
//
// 手机上是从底下升起来的一张卡，电脑上是右边的一条竖栏，
// 两种都能单手够到。页面每跳一次这个面板就重建一次，
// 状态从库里读回来，所以看起来像一直开着。
//
// 页面结构照着手机版来：采集、帖子、人、私信、设置。

const PANEL_CSS = `
.xhsc-root, .xhsc-root * { box-sizing: border-box; font-family: -apple-system,
  BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif; }
.xhsc-fab { position: fixed; right: 16px; bottom: 88px; z-index: 2147483000;
  width: 54px; height: 54px; border-radius: 27px; border: none;
  background: var(--xc-accent); color: #fff; font-size: 13px; font-weight: 600;
  box-shadow: 0 6px 20px rgba(0,0,0,.28); cursor: pointer; }
.xhsc-fab.on { background: #111; }
.xhsc-panel { position: fixed; z-index: 2147483000; background: #fff; color: #111;
  display: flex; flex-direction: column; box-shadow: 0 -8px 40px rgba(0,0,0,.25);
  left: 0; right: 0; bottom: 0; height: 80vh; border-radius: 18px 18px 0 0; }
@media (min-width: 900px) {
  .xhsc-panel { left: auto; top: 0; width: 430px; height: 100vh;
    border-radius: 0; box-shadow: -8px 0 40px rgba(0,0,0,.18); }
  .xhsc-fab { bottom: 24px; }
}
.xhsc-head { display: flex; align-items: center; gap: 10px; padding: 13px 16px;
  border-bottom: 1px solid #eee; }
.xhsc-title { font-size: 17px; font-weight: 700; flex: 1; }
.xhsc-site { padding: 6px 12px; border-radius: 15px; background: #f2f2f4;
  font-size: 13px; color: #444; cursor: pointer; }
.xhsc-x { border: none; background: #f2f2f4; width: 34px; height: 34px;
  border-radius: 17px; font-size: 17px; cursor: pointer; color: #444; }
.xhsc-tabs { display: flex; border-bottom: 1px solid #eee; }
.xhsc-tab { flex: 1; padding: 12px 0; text-align: center; font-size: 14.5px;
  color: #888; cursor: pointer; border-bottom: 2px solid transparent; }
.xhsc-tab.on { color: var(--xc-accent); font-weight: 600;
  border-bottom-color: var(--xc-accent); }
.xhsc-body { flex: 1; overflow-y: auto; padding: 14px 16px 24px; }
.xhsc-foot { border-top: 1px solid #eee; padding: 12px 16px;
  display: flex; gap: 10px; background: #fff; }
.xhsc-foot .xhsc-btn { flex: 1; }
.xhsc-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.xhsc-row > label { font-size: 15px; width: 96px; flex: none; color: #333; }
.xhsc-root input[type=text], .xhsc-root input[type=number], .xhsc-root select,
.xhsc-root textarea {
  flex: 1; min-width: 0; height: 42px; padding: 0 12px; font-size: 15px;
  border: 1px solid #ddd; border-radius: 10px; background: #fff; color: #111;
  font-family: inherit; }
.xhsc-root textarea { height: 66px; padding: 10px 12px; line-height: 1.6; }
.xhsc-root button { font-size: 15px; font-family: inherit; }
.xhsc-btn { height: 44px; padding: 0 18px; border-radius: 10px; border: none;
  background: var(--xc-accent); color: #fff; font-weight: 600; cursor: pointer; }
.xhsc-btn.ghost { background: #f2f2f4; color: #222; }
.xhsc-btn:disabled { opacity: .45; }
.xhsc-btns { display: flex; gap: 10px; margin: 14px 0; }
.xhsc-btns .xhsc-btn { flex: 1; }
.xhsc-nums { display: flex; gap: 10px; margin-bottom: 12px; }
.xhsc-num { flex: 1; padding: 11px 0; text-align: center; border-radius: 12px;
  background: #fff; border: 1px solid #eee; cursor: pointer; }
.xhsc-num.on { background: var(--xc-soft); border-color: transparent; }
.xhsc-num b { display: block; font-size: 20px; font-weight: 700; color: #111; }
.xhsc-num.on b { color: var(--xc-accent); }
.xhsc-num span { font-size: 12px; color: #999; }
.xhsc-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.xhsc-chip { padding: 8px 13px; border-radius: 16px; background: #f2f2f4;
  font-size: 14px; cursor: pointer; color: #444; }
.xhsc-chip.on { background: var(--xc-soft); color: var(--xc-accent);
  font-weight: 600; }
.xhsc-bar { height: 8px; border-radius: 4px; background: #eee; overflow: hidden;
  margin: 12px 0 8px; }
.xhsc-bar i { display: block; height: 100%; background: var(--xc-accent); width: 0; }
.xhsc-msg { font-size: 14px; color: #444; min-height: 20px; line-height: 1.7; }
.xhsc-log { margin-top: 12px; background: #fafafa; border: 1px solid #eee;
  border-radius: 10px; padding: 10px; font-size: 12.5px; line-height: 1.7;
  color: #666; max-height: 200px; overflow-y: auto;
  font-family: ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; }
.xhsc-card { border: 1px solid #eee; border-radius: 12px; padding: 13px 14px;
  margin-bottom: 10px; }
.xhsc-who { display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  margin-bottom: 7px; }
.xhsc-ava { width: 26px; height: 26px; border-radius: 13px; flex: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; color: #fff; }
.xhsc-name { font-size: 15px; font-weight: 600; color: #111; }
.xhsc-card p { margin: 0 0 9px; font-size: 14px; color: #555; line-height: 1.7; }
.xhsc-talk { background: var(--xc-soft); border-radius: 9px; padding: 10px 12px;
  color: #222; }
.xhsc-tag { display: inline-block; padding: 2px 8px; border-radius: 9px;
  font-size: 12px; background: #f2f2f4; color: #666; }
.xhsc-tag.hot { background: var(--xc-soft); color: var(--xc-accent); }
.xhsc-tag.bad { background: #ffe9e9; color: #c62828; }
/* 男女各给一个颜色，一屏评论扫过去靠颜色比靠读字快得多。
   这两个颜色是写死的，不跟着平台主色走：主色在小红书是红、抖音是黑，
   跟着走的话女标在小红书跟别的红字混在一起，男标到了抖音又跟主色撞。 */
.xhsc-tag.he { background: rgba(63,114,184,.12); color: #3f72b8; }
.xhsc-tag.she { background: rgba(200,90,134,.12); color: #c85a86; }
/* 评论行。在举手的换个底色，选中要回复的再描一圈边。 */
.xhsc-crow { border: 1px solid #eee; border-radius: 12px; padding: 11px 14px;
  margin-bottom: 8px; cursor: pointer; }
.xhsc-crow.worth { background: var(--xc-soft); border-color: transparent; }
.xhsc-crow.on { border: 2px solid var(--xc-accent); padding: 10px 13px; }
.xhsc-crow .top { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.xhsc-crow .top .name { font-size: 14px; font-weight: 600; flex: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xhsc-crow p { margin: 0; font-size: 14px; line-height: 1.6; }
.xhsc-grid { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.xhsc-more { border: none; background: none; color: var(--xc-accent);
  font-size: 13.5px; cursor: pointer; padding: 4px 0; }
.xhsc-topbar { display: flex; justify-content: space-between;
  align-items: center; margin-bottom: 8px; }
.xhsc-foot.col { flex-direction: column; align-items: stretch; gap: 8px; }
.xhsc-foot .who { display: flex; align-items: center; gap: 4px; font-size: 13px;
  font-weight: 600; color: #999; }
.xhsc-foot .who b { flex: 1; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.xhsc-foot .who button { border: none; background: none; color: var(--xc-accent);
  font-size: 13px; cursor: pointer; padding: 4px 8px; }
.xhsc-send { display: flex; gap: 8px; align-items: flex-end; }
.xhsc-time { font-size: 12px; color: #aaa; }
.xhsc-mini { display: flex; gap: 8px; }
.xhsc-mini button { flex: 1; height: 36px; border-radius: 9px; border: 1px solid #eee;
  background: #fff; color: #333; cursor: pointer; font-size: 13.5px; }
.xhsc-empty { text-align: center; color: #aaa; font-size: 14px; padding: 40px 0; }
.xhsc-cover { width: 64px; height: 64px; border-radius: 9px; object-fit: cover;
  flex: none; background: #f2f2f4; display: block; }
.xhsc-noterow { display: flex; gap: 12px; align-items: flex-start; }
.xhsc-noterow > div { flex: 1; min-width: 0; }
.xhsc-warn { background: #fff4e0; color: #a35a00; border-radius: 10px;
  padding: 11px 12px; font-size: 14px; line-height: 1.7; margin-bottom: 12px; }
.xhsc-big { background: var(--xc-soft); color: var(--xc-accent); border-radius: 12px;
  padding: 14px; font-size: 15px; line-height: 1.7; margin-bottom: 12px;
  font-weight: 600; }
.xhsc-pager { display: flex; align-items: center; justify-content: center;
  gap: 16px; padding: 14px 0; font-size: 13.5px; color: #666; }
.xhsc-pager button { border: none; background: none; color: var(--xc-accent);
  cursor: pointer; }
.xhsc-pager button:disabled { color: #ccc; }
/* 配色照手机版 lib/theme.dart。小红书那一套把饱和度压下来，
   从正红改成砖红，白底上不刺眼；抖音自己的主色就是黑白，
   用小红书的色去标抖音的数据，一眼看过去分不出在哪个平台上。 */
:root { --xc-accent: #d94a3d; --xc-soft: #fcf0ee; }
.xhsc-root.dy { --xc-accent: #1a1d21; --xc-soft: #f0f0ee; }
@media (prefers-color-scheme: dark) {
  :root { --xc-accent: #e0685c; --xc-soft: #261815; }
  .xhsc-panel { background: #17181b; color: #ededea; }
  .xhsc-head, .xhsc-tabs, .xhsc-foot { border-color: #2a2a2f; }
  .xhsc-foot { background: #17171a; }
  .xhsc-site, .xhsc-x { background: #26262b; color: #ccc; }
  .xhsc-tab { color: #888; }
  .xhsc-row > label { color: #ccc; }
  .xhsc-root input[type=text], .xhsc-root input[type=number],
  .xhsc-root select, .xhsc-root textarea {
    background: #1f1f24; border-color: #33333a; color: #f2f2f4; }
  .xhsc-btn.ghost { background: #26262b; color: #eee; }
  .xhsc-chip { background: #26262b; color: #bbb; }
  .xhsc-num { background: #1f1f24; border-color: #2a2a2f; }
  .xhsc-num b { color: #f2f2f4; }
  .xhsc-bar { background: #2a2a2f; }
  .xhsc-log { background: #1c1c20; border-color: #2a2a2f; color: #999; }
  .xhsc-card { border-color: #2a2a2f; }
  .xhsc-name { color: #f2f2f4; }
  .xhsc-card p { color: #bbb; }
  .xhsc-talk { color: #f2f2f4; }
  .xhsc-tag { background: #26262b; color: #aaa; }
  .xhsc-tag.he { background: #1c2630; color: #7c9cb8; }
  .xhsc-tag.she { background: #261815; color: #e0685c; }
  .xhsc-mini button { background: #1f1f24; border-color: #33333a; color: #ddd; }
  .xhsc-root.dy { --xc-accent: #ededea; --xc-soft: #232529; }
}
`;

const UI = {
  root: null,
  panel: null,
  fab: null,
  open: false,
  tab: '采集',
  picked: new Set(),
  // 人页的筛选。默认只看评论区的人，要私信的就是他们。
  //
  // 帖主按时间排在最前面，一进来满屏都是帖主的帖子标题，
  // 真正应征的人被压在后面翻不到。
  kind: '评论者',
  search: '',
  page: 0,
  pageSize: 40,
  sentOnlyOk: false,
  // 帖子页正在看哪一篇。空的时候看的是列表。
  note: null,
  // 正文摊开了没有。有的帖子正文很长，全摊开要占三四屏，
  // 评论被顶到看不见的地方，而人进这一页是来看评论的。
  noteFull: false,
  // 只看在举手的那些人
  noteWorth: false,
  // 这条评论要回复谁。空着就是直接在帖子底下留言。
  replyTo: '',
  replyAt: null,
  // 换过几次。每换一次就往后取一句，不然点几下都是同一句。
  nonce: 0,
  // 输入框里的话。面板整块重画，不存着就打一半没了。
  draft: '',
};

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

// 头像。没有真头像可用，拿昵称第一个字加一个稳定的颜色顶上，
// 一列人扫过去至少能靠颜色分开。
function avatar(name) {
  const s = asText(name) || '匿';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
  const a = el('div', 'xhsc-ava', esc(s.slice(0, 1)));
  a.style.background = 'hsl(' + (h % 360) + ',52%,58%)';
  return a;
}

// 男女那个标签。判不出来的不给标签，宁可少一个也别标错。
function sexTag(sex) {
  return el('span', 'xhsc-tag ' + (sex === '男' ? 'he' : 'she'), esc(sex));
}

// 封面图。
//
// 面板跑在平台自己的页面上，图床要的来路正好就是这个域，所以直接贴地址
// 就能显示。拿到别处去看就不行了，图床会挡下来。
//
// 图床的地址是带签名的，过一阵子会失效。失效的图不留空框，
// 整个撤掉，那一行自动变回只有文字的样子。
function coverImg(url, size) {
  const u = asText(url);
  if (!u) return null;
  const im = document.createElement('img');
  im.className = 'xhsc-cover';
  im.loading = 'lazy';
  // 采回来那条地址是签过的，隔两天就 403，所以换成不过期的那一条
  im.src = stableUrl(u, size ? size * 2 : 200);
  // 换出来的地址万一认错了，还有原地址兜底
  let tried = false;
  im.addEventListener('error', () => {
    if (!tried && im.src !== u) {
      tried = true;
      im.src = u;
      return;
    }
    im.remove();
  });
  if (size) {
    im.style.width = size + 'px';
    im.style.height = size + 'px';
  }
  return im;
}

function mountPanel() {
  if (UI.root) return;
  const root = el('div', 'xhsc-root' + (onDouyin() ? ' dy' : ''));
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
    '<div class="xhsc-site"></div><button class="xhsc-x">×</button></div>' +
    '<div class="xhsc-tabs"></div><div class="xhsc-body"></div>';
  root.appendChild(panel);
  document.body.appendChild(root);

  UI.root = root;
  UI.panel = panel;
  UI.fab = fab;

  panel.querySelector('.xhsc-x').addEventListener('click', () => togglePanel(false));

  // 平台按域名定，点一下跳到另一个站。
  //
  // 不做成开关。两个站是两个域，浏览器的库是按域分的，
  // 在小红书页面上摆一个能切到抖音的开关，切完什么都看不见，那是骗人。
  const site = panel.querySelector('.xhsc-site');
  site.textContent = siteNow();
  site.title = '去' + (onDouyin() ? '小红书' : '抖音');
  site.addEventListener('click', () => {
    location.href = otherSiteUrl();
  });

  const tabs = panel.querySelector('.xhsc-tabs');
  for (const name of ['采集', '帖子', '人', '私信', '设置']) {
    const t = el('div', 'xhsc-tab' + (name === UI.tab ? ' on' : ''), name);
    t.addEventListener('click', () => {
      UI.tab = name;
      UI.page = 0;
      UI.note = null;
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

// 底下那条按钮栏。只有人页用得上，别的页面要把它撤掉。
function foot(make) {
  const old = UI.panel.querySelector('.xhsc-foot');
  if (old) old.remove();
  if (!make) return null;
  const f = el('div', 'xhsc-foot');
  UI.panel.appendChild(f);
  return f;
}

function renderBody() {
  const b = body();
  b.innerHTML = '';
  foot(false);
  if (UI.tab === '采集') renderCollect(b);
  else if (UI.tab === '帖子') renderNotes(b);
  else if (UI.tab === '人') renderPeople(b);
  else if (UI.tab === '私信') renderSent(b);
  else renderSettings(b);
}

function say(s) {
  const m = UI.panel.querySelector('.xhsc-toast') || el('div', 'xhsc-toast');
  m.textContent = s;
  m.style.cssText = 'position:absolute;left:16px;right:16px;bottom:78px;' +
    'background:rgba(0,0,0,.86);color:#fff;padding:11px 14px;border-radius:10px;' +
    'font-size:14px;z-index:5;line-height:1.6;';
  UI.panel.appendChild(m);
  clearTimeout(m._t);
  m._t = setTimeout(() => m.remove(), 2600);
}

// ---------- 采集页 ----------

function renderCollect(b) {
  const job = Runtime.job || {};

  if (!hookInstalled()) {
    b.appendChild(el('div', 'xhsc-warn',
      '钩子没装上，采不到数据。把脚本管理器里的注入方式改成页面环境，刷新重试。'));
  }
  if (job.running) {
    renderRunning(b, job);
    return;
  }

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
  const nMin = numRow('多少分钟采完', Limits.crawlMinutes,
    kCrawlMinutesMin, kCrawlMinutesMax);
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
      say('先选一个关键词');
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
  bar.firstChild.style.width =
    Math.round(progressRatio(stats.done, stats.total) * 100) + '%';
  b.appendChild(el('div', 'xhsc-msg',
    esc('第 ' + (job.wi + 1) + '/' + job.keywords.length + ' 个词 ' +
      currentWord(job) + '　' + (stats.done || 0) + '/' + (stats.total || 0) + ' 篇')));
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
  stop.addEventListener('click', () => stopCollect());
  btns.appendChild(pause);
  btns.appendChild(stop);
  b.appendChild(btns);

  if ((job.log || []).length) {
    b.appendChild(el('div', 'xhsc-log', esc(job.log.slice(-40).join('\n'))));
  }
}

// ---------- 帖子页 ----------

async function renderNotes(b) {
  // 点开某一篇就看那一篇底下的评论
  if (UI.note) {
    await renderNoteDetail(b, UI.note);
    return;
  }
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
    const row = el('div', 'xhsc-noterow');
    const im = coverImg(n.cover);
    if (im) row.appendChild(im);
    const right = el('div');
    right.appendChild(el('div', 'xhsc-name',
      esc(n.title || head(n.content, 24) || '无标题')));
    right.appendChild(noteMeta(n));
    if (n.content) right.appendChild(el('p', '', esc(head(n.content, 70))));
    row.appendChild(right);
    c.appendChild(row);
    c.style.cursor = 'pointer';
    c.addEventListener('click', () => {
      UI.note = n;
      renderBody();
    });
    b.appendChild(c);
  }
}

function noteMeta(n) {
  const owner = guessGender(n.author_name, (asText(n.title) + ' ' + asText(n.content)), '');
  const row = el('div', 'xhsc-who');
  row.appendChild(el('span', 'xhsc-tag', esc(n.author_name)));
  if (owner) row.appendChild(sexTag(owner));
  row.appendChild(el('span', 'xhsc-tag', '赞 ' + asInt(n.likes)));
  row.appendChild(el('span', 'xhsc-tag', '评论 ' + asInt(n.comment_cnt)));
  if (n.ip_location) row.appendChild(el('span', 'xhsc-tag', esc(n.ip_location)));
  if (n.keyword) row.appendChild(el('span', 'xhsc-tag hot', esc(n.keyword)));
  return row;
}

// 一篇帖子和它底下的评论，摆法跟手机版那一页一样。
//
// 帖子正文和评论在同一条滚动里，跟平台上看帖的顺序一致：先看这篇讲什么，
// 再往下翻评论。评论区里在举手的那些人会被标出来，一条条自己读几百条找人，
// 是这件事里最费时间的一步。
//
// 每条评论后面标了男女。红娘看一屏评论最先要分的就是男女，
// 不标的话得逐个点进主页看，一篇几十条评论根本看不过来。
async function renderNoteDetail(b, n) {
  // 顶上这一条做成细的。两个大按钮横在这儿，帖子和评论就被顶下去一屏，
  // 而人进这一页是来看评论的。
  const bar = el('div', 'xhsc-topbar');
  const bk = el('button', 'xhsc-more', '返回');
  bk.addEventListener('click', () => {
    UI.note = null;
    clearReply();
    renderBody();
  });
  const open = el('button', 'xhsc-more', '原帖');
  open.addEventListener('click', () => {
    const u = viewUrl(n);
    if (u) window.open(u, '_blank');
  });
  bar.appendChild(bk);
  bar.appendChild(open);
  b.appendChild(bar);
  b.appendChild(notePost(n));

  const all = (await getAll('comments')).filter((c) => c.note_id === n.note_id);
  const noteText = (asText(n.title) + ' ' + asText(n.content)).trim();
  const rows = orderComments(all).map((c) => ({
    row: c,
    sex: guessGender(c.nickname, c.content, noteText),
    intent: judgePerson(c.nickname, c.content),
  }));
  for (const one of rows) {
    one.worth = one.intent === INTENT_HIGH || one.intent === INTENT_MID;
  }
  const worth = rows.filter((one) => one.worth).length;

  // 数字条本身就是筛选，点哪个看哪些
  const nums = el('div', 'xhsc-nums');
  const mk = (on, label, count, fn) => {
    const one = el('div', 'xhsc-num' + (on ? ' on' : ''),
      '<b>' + count + '</b><span>' + label + '</span>');
    one.addEventListener('click', fn);
    return one;
  };
  nums.appendChild(mk(!UI.noteWorth, '全部', rows.length, () => {
    UI.noteWorth = false;
    renderBody();
  }));
  nums.appendChild(mk(UI.noteWorth, '在举手', worth, () => {
    UI.noteWorth = true;
    renderBody();
  }));
  b.appendChild(nums);

  const shown = UI.noteWorth ? rows.filter((one) => one.worth) : rows;
  if (!shown.length) {
    b.appendChild(el('div', 'xhsc-empty',
      rows.length ? '这篇底下没人在举手' : '这篇没有采到评论'));
  }
  for (const one of shown) b.appendChild(commentRow(one, n));

  replyBox(n);
}

// 帖子本身：标题、作者、图、正文。
function notePost(n) {
  const card = el('div', 'xhsc-card');
  card.appendChild(el('div', 'xhsc-name',
    esc(n.title || head(n.content, 24) || '无标题')));
  card.appendChild(noteMeta(n));

  // 采到的图全摆出来，一篇帖子的图往往比正文更能说明这个人什么样
  const pics = asText(n.images).split(' | ').filter(Boolean);
  const shots = pics.length ? pics : [asText(n.cover)].filter(Boolean);
  if (shots.length) {
    const grid = el('div', 'xhsc-grid');
    for (const u of shots.slice(0, 9)) {
      const im = coverImg(u, 88);
      if (im) grid.appendChild(im);
    }
    card.appendChild(grid);
  }

  const body = asText(n.content);
  if (body) {
    const p = el('p', '', esc(UI.noteFull ? body : head(body, 120)));
    card.appendChild(p);
    // 正文长的默认收着，人进这一页是来看评论的
    if (body.length > 120) {
      const more = el('button', 'xhsc-more', UI.noteFull ? '收起' : '看全文');
      more.addEventListener('click', () => {
        UI.noteFull = !UI.noteFull;
        renderBody();
      });
      card.appendChild(more);
    }
  }
  return card;
}

// 一级按点赞排，各自的回复紧跟在后面，跟平台上看到的顺序一致。
function orderComments(all) {
  const tops = all.filter((c) => !c.parent_id)
    .sort((a, b) => asInt(b.likes) - asInt(a.likes));
  const kids = {};
  for (const c of all) {
    if (!c.parent_id) continue;
    if (!kids[c.parent_id]) kids[c.parent_id] = [];
    kids[c.parent_id].push(c);
  }
  const out = [];
  const seen = new Set();
  for (const t of tops) {
    out.push(t);
    seen.add(t.comment_id);
    for (const s of kids[t.comment_id] || []) {
      out.push(s);
      seen.add(s.comment_id);
    }
  }
  // 父评论没采到的回复别丢，单独挂在后面，不然评论数对不上
  for (const c of all) {
    if (!seen.has(c.comment_id)) out.push(c);
  }
  return out;
}

function personOf(c, n, sex) {
  return {
    kind: '评论者',
    user_id: c.user_id,
    nickname: c.nickname,
    ip_location: c.ip_location,
    said: asText(c.content),
    note_id: c.note_id,
    xsec_token: n.xsec_token,
    note_url: n.note_url,
    site: asSite(c.site),
    trade: asTrade(c.trade),
    sex: sex,
  };
}

function commentRow(one, n) {
  const c = one.row;
  const on = UI.replyAt === c.comment_id;
  const card = el('div', 'xhsc-crow' + (one.worth ? ' worth' : '') +
    (on ? ' on' : ''));
  if (c.parent_id) card.style.marginLeft = '22px';

  const top = el('div', 'top');
  top.appendChild(avatar(c.nickname));
  top.appendChild(el('div', 'name', esc(c.nickname || '匿名')));
  if (one.sex) top.appendChild(sexTag(one.sex));
  if (c.ip_location) {
    top.appendChild(el('span', 'xhsc-time', esc(c.ip_location)));
  }
  card.appendChild(top);
  card.appendChild(el('p', '', esc(c.content)));

  // 点一条就是要回复这个人。这是整件事的落点：
  // 在举手的人底下接一句，比在帖子底下贴一条被看见的机会大得多。
  card.addEventListener('click', () => {
    if (on) {
      clearReply();
    } else {
      UI.replyAt = c.comment_id;
      UI.replyTo = asText(c.nickname);
      UI.nonce = 0;
      UI.draft = draftFor({
        said: c.content,
        who: asText(c.user_id) || asText(c.nickname),
        where: c.ip_location,
      });
      UI.person = personOf(c, n, one.sex);
    }
    renderBody();
  });
  return card;
}

function clearReply() {
  UI.replyAt = null;
  UI.replyTo = '';
  UI.person = null;
  UI.draft = '';
  UI.nonce = 0;
}

// 底部那块输入区。选中某条评论就是回复他，什么都不选就是在帖子底下留言。
function replyBox(n) {
  const f = foot(true);
  f.classList.add('col');

  const who = el('div', 'who');
  who.appendChild(el('b', '', UI.replyTo ? esc('回复 ' + UI.replyTo) : '在帖子底下留言'));
  if (UI.replyTo) who.firstChild.style.color = 'var(--xc-accent)';

  if (UI.replyAt) {
    const again = el('button', '', '换一句');
    again.addEventListener('click', () => {
      UI.nonce += 1;
      const p = UI.person || {};
      UI.draft = draftFor({
        said: p.said,
        who: asText(p.user_id) || asText(p.nickname),
        where: p.ip_location,
        nonce: UI.nonce,
      });
      renderBody();
    });
    who.appendChild(again);
  }
  const talks = el('button', '', '话术');
  talks.addEventListener('click', () => {
    const list = draftTalks();
    if (!list.length) {
      say('先去设置里写几条评论话术');
      return;
    }
    UI.nonce += 1;
    UI.draft = list[UI.nonce % list.length];
    renderBody();
  });
  who.appendChild(talks);
  if (UI.replyTo) {
    const x = el('button', '', '取消');
    x.addEventListener('click', () => {
      clearReply();
      renderBody();
    });
    who.appendChild(x);
  }
  f.appendChild(who);

  const line = el('div', 'xhsc-send');
  const ta = el('textarea');
  ta.value = UI.draft;
  ta.placeholder = UI.replyTo ? '回复 ' + UI.replyTo : '写一条评论';
  ta.style.height = '44px';
  ta.addEventListener('input', () => {
    UI.draft = ta.value;
  });
  const send = el('button', 'xhsc-btn', '发送');
  send.style.flex = 'none';
  send.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) {
      say('先写一句话');
      return;
    }
    const p = UI.person || {
      kind: '帖主',
      user_id: n.author_id,
      nickname: '',
      said: (asText(n.title) + ' ' + asText(n.content)).trim(),
      note_id: n.note_id,
      xsec_token: n.xsec_token,
      note_url: n.note_url,
      site: asSite(n.site),
      trade: asTrade(n.trade),
    };
    // 帖主那条不带昵称，脚本只找公共评论框；
    // 回复某个人要带昵称，脚本会去评论区找他那条评论点回复。
    launchSend([Object.assign({}, p, { text: text })], '评论');
  });
  line.appendChild(ta);
  line.appendChild(send);
  f.appendChild(line);
}

// ---------- 人页 ----------

// 这一页的数据只查一次，翻页和切筛选都在内存里做。
let _peopleCache = null;

async function loadPeople() {
  const all = await listPeople({ trade: Trade.now.key, order: 'likes' });
  const blocked = await blockedIds();
  const res = runFunnel(all, { blocked: blocked });
  _peopleCache = { all: all, keep: res.keep, stat: res.stat, blocked: blocked };
  return _peopleCache;
}

// 给名单上的一个人写一句话。走的是跟评论区回复同一个出话口子，
// 两处出的话必须一样，不然同一个人在两个页面上看到两句不同的话。
function talkFor(p) {
  return draftFor({
    said: p.said,
    who: asText(p.user_id) || asText(p.nickname),
    where: p.ip_location,
  });
}

// 从一批人里挑出真正发得出去的。
//
// 只取评论区的人，不给帖主发。评论区里说想找对象的那些人是自己开口的，
// 私信他顺理成章；帖主多半是做号的或者发攻略的，给他发转化低还容易被举报。
// 真要给某个帖主发，用他那一行上的按钮。
function sendableOf(cache) {
  return cache.keep.filter((p) => p.user_id && p.kind !== '帖主' &&
    canOpenProfile(p.user_id));
}

// 这一批要去哪几篇帖子底下评论。
//
// 按帖子去重。同一篇帖子底下有好几个人，评论是发给帖子的不是发给人的，
// 不去重的话同一篇会被评好几条，那是刷屏。
function postableOf(cache) {
  const seen = new Set();
  const out = [];
  for (const p of cache.keep) {
    if (!p.note_id || seen.has(p.note_id)) continue;
    seen.add(p.note_id);
    out.push(p);
  }
  return out;
}

async function renderPeople(b) {
  // 正在发的时候这一页就是发送进度，别的什么都别显示
  if (Sender.job && Sender.job.running) {
    renderSending(b, Sender.job);
    return;
  }

  b.appendChild(el('div', 'xhsc-empty', '读取中'));
  const cache = await loadPeople();
  b.innerHTML = '';

  const counts = { '': cache.keep.length, 帖主: 0, 评论者: 0 };
  for (const p of cache.keep) counts[p.kind] += 1;

  // 数字条本身就是筛选，点哪个看哪类
  const nums = el('div', 'xhsc-nums');
  for (const [value, label] of [['', '全部'], ['帖主', '帖主'], ['评论者', '评论区的人']]) {
    const one = el('div', 'xhsc-num' + (UI.kind === value ? ' on' : ''),
      '<b>' + counts[value] + '</b><span>' + label + '</span>');
    one.addEventListener('click', () => {
      UI.kind = value;
      UI.page = 0;
      renderBody();
    });
    nums.appendChild(one);
  }
  b.appendChild(nums);

  const rowS = el('div', 'xhsc-row');
  const box = el('input');
  box.type = 'text';
  box.placeholder = '搜昵称或者留言';
  box.value = UI.search;
  box.addEventListener('change', () => {
    UI.search = box.value.trim();
    UI.page = 0;
    renderBody();
  });
  rowS.appendChild(box);
  b.appendChild(rowS);

  let rows = cache.keep;
  if (UI.kind) rows = rows.filter((p) => p.kind === UI.kind);
  if (UI.search) {
    rows = rows.filter((p) => asText(p.said).includes(UI.search) ||
      asText(p.nickname).includes(UI.search));
  }
  if (!rows.length) {
    b.appendChild(el('div', 'xhsc-empty', '这里还没有人，先去采集'));
    return;
  }

  const pages = Math.ceil(rows.length / UI.pageSize);
  if (UI.page >= pages) UI.page = 0;
  for (const p of rows.slice(UI.page * UI.pageSize, (UI.page + 1) * UI.pageSize)) {
    b.appendChild(personCard(p));
  }
  if (pages > 1) b.appendChild(pager(pages));

  // 钉在底下那两个按钮。这一页真正要做的就这两件事。
  //
  // 原来它们夹在筛选和名单中间，往下翻一屏就看不见了。
  const f = foot(true);
  const dmList = sendableOf(cache);
  const noteList = postableOf(cache);
  const dm = el('button', 'xhsc-btn', '私信 ' + dmList.length + ' 个人');
  dm.disabled = !dmList.length;
  dm.addEventListener('click', () => launchSend(dmList, '私信'));
  const cm = el('button', 'xhsc-btn ghost', '评论 ' + noteList.length + ' 篇');
  cm.disabled = !noteList.length;
  cm.addEventListener('click', () => launchComment(noteList));
  f.appendChild(dm);
  f.appendChild(cm);
}

function pager(pages) {
  const p = el('div', 'xhsc-pager');
  const prev = el('button', '', '上一页');
  prev.disabled = UI.page === 0;
  prev.addEventListener('click', () => {
    UI.page -= 1;
    renderBody();
  });
  const next = el('button', '', '下一页');
  next.disabled = UI.page >= pages - 1;
  next.addEventListener('click', () => {
    UI.page += 1;
    renderBody();
  });
  p.appendChild(prev);
  p.appendChild(el('span', '', (UI.page + 1) + ' / ' + pages));
  p.appendChild(next);
  return p;
}

function personCard(p) {
  const isAuthor = p.kind === '帖主';
  const c = el('div', 'xhsc-card');
  const who = el('div', 'xhsc-who');
  who.appendChild(avatar(p.nickname));
  who.appendChild(el('div', 'xhsc-name', esc(p.nickname || '匿名')));
  who.appendChild(el('span', 'xhsc-tag' + (isAuthor ? ' hot' : ''), esc(p.kind)));
  if (p.sex) who.appendChild(sexTag(p.sex));
  if (p.intent === INTENT_HIGH) who.appendChild(el('span', 'xhsc-tag hot', '高意向'));
  if (p.ip_location) who.appendChild(el('span', 'xhsc-tag', esc(p.ip_location)));
  if (p.ts) who.appendChild(el('span', 'xhsc-time', esc(asText(p.ts).slice(0, 16))));
  c.appendChild(who);
  c.appendChild(el('p', '', esc(head(p.said, 150))));

  const talk = talkFor(p);
  c.appendChild(el('p', 'xhsc-talk', esc(talk)));

  const mini = el('div', 'xhsc-mini');
  // 帖主不给私信。帖主多半是做号的或者发攻略的，私信他转化低还容易被举报，
  // 要接触就在他帖子底下评论。
  if (!isAuthor && canOpenProfile(p.user_id)) {
    const dm = el('button', '', '私信');
    dm.addEventListener('click', (e) => {
      e.stopPropagation();
      launchSend([p], '私信');
    });
    mini.appendChild(dm);
  }
  const cm = el('button', '', isAuthor ? '评论' : '回复');
  cm.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!p.note_id) {
      say('这条没有原帖，评论不了');
      return;
    }
    // 帖主没有自己的评论可回，昵称留空，脚本就只找公共评论框；
    // 评论者带着昵称，脚本会去评论区找他那条评论点回复。
    launchSend([Object.assign({}, p, {
      text: talk,
      nickname: isAuthor ? '' : p.nickname,
    })], '评论');
  });
  mini.appendChild(cm);

  const copy = el('button', '', '复制话术');
  copy.addEventListener('click', async (e) => {
    e.stopPropagation();
    await copyText(talk);
    copy.textContent = '已复制';
  });
  mini.appendChild(copy);

  const ban = el('button', '', '拉黑');
  ban.addEventListener('click', async (e) => {
    e.stopPropagation();
    await blockUser(p.user_id, p.nickname, '手动拉黑');
    c.remove();
    say((p.nickname || '这个人') + ' 拉黑了');
  });
  mini.appendChild(ban);
  c.appendChild(mini);

  // 点卡片就是看原帖，那是顺手确认这个人说话场景的动作
  c.style.cursor = 'pointer';
  c.addEventListener('click', () => {
    const u = viewUrl({
      note_id: p.note_id,
      note_url: p.note_url,
      xsec_token: p.xsec_token,
      site: p.site,
    });
    if (u) window.open(u, '_blank');
  });
  return c;
}

// ---------- 发送 ----------

async function launchSend(people, kind) {
  const list = people.map((p) => Object.assign({}, p, { text: p.text || talkFor(p) }));
  // 单发之前看看是不是紧挨着上一条。
  //
  // 只拦一件事：两条贴在一起发。真人再快也要看一眼再点，
  // 秒级连发是程序才做得出来的动作。
  const gap = await secondsSinceLastTouch();
  if (gap < kMinGapSeconds) {
    say('离上一条太近了，等 ' + (kMinGapSeconds - gap) + ' 秒再发');
    return;
  }
  const r = await startSend(list, kind);
  if (!r.ok) say(r.why);
  else renderBody();
}

// 批量去帖子底下评论。
//
// 话术从设置里勾上的那几条里随机挑。同一批人不能都发一样的话，
// 一模一样的评论出现在几十篇帖子底下，一眼就是机器。
async function launchComment(notes) {
  const talks = Trade.pickedTalks();
  if (!talks.length) {
    say('先去设置里写几条评论话术');
    return;
  }
  // 话术轮着用，不是每篇现挑一句。
  //
  // 每篇现挑的话，连着几篇挑中同一句的概率不低，而一模一样的评论
  // 出现在几十篇帖子底下，一眼就是机器。轮着来保证相邻两篇一定不同。
  // 起点每批随机，不然每批都从同一句开始。
  const from = Math.floor(Math.random() * 97);
  const list = notes.map((p, i) => Object.assign({}, p, {
    text: talks[(from + i) % talks.length],
    // 只在帖子底下发新评论，不去回复某个人。
    // 回复某个人要在几百条评论里把他找出来，很容易找错。
    nickname: '',
  }));
  const r = await startSend(list, '评论');
  if (!r.ok) say(r.why);
  else renderBody();
}

function renderSending(b, job) {
  const stats = job.stats || {};
  const total = (job.targets || []).length;
  b.appendChild(el('div', 'xhsc-msg',
    esc('正在' + job.kind + '　' + (job.i + 1) + '/' + total)));
  const bar = el('div', 'xhsc-bar', '<i></i>');
  bar.firstChild.style.width = Math.round(progressRatio(job.i, total) * 100) + '%';
  b.appendChild(bar);

  // 等人动手的时候，把要做的事摆成一整块，别混在日志里
  if (job.waiting === 'dmkey') {
    b.appendChild(el('div', 'xhsc-big', esc(job.message || '点一下页面上标红那个私信键')));
  } else if (job.waiting === 'send') {
    b.appendChild(el('div', 'xhsc-big', '话已经填好了，按页面上的发送键，然后点下面的下一个'));
    const next = el('div', 'xhsc-btns');
    const btn = el('button', 'xhsc-btn', '我发过了，下一个');
    btn.addEventListener('click', () => humanDone());
    next.appendChild(btn);
    b.appendChild(next);
  } else {
    b.appendChild(el('div', 'xhsc-msg', esc(job.message || '')));
  }

  b.appendChild(el('div', 'xhsc-msg',
    esc('成功 ' + (stats.ok || 0) + '　失败 ' + (stats.fail || 0))));

  const btns = el('div', 'xhsc-btns');
  const pause = el('button', 'xhsc-btn ghost', job.paused ? '继续' : '暂停');
  pause.addEventListener('click', () => (job.paused ? resumeSend() : pauseSend()));
  const stop = el('button', 'xhsc-btn', '停止');
  stop.addEventListener('click', () => stopSend());
  btns.appendChild(pause);
  btns.appendChild(stop);
  b.appendChild(btns);

  if ((job.log || []).length) {
    b.appendChild(el('div', 'xhsc-log', esc(job.log.slice(-40).join('\n'))));
  }
}

// ---------- 私信记录 ----------

// 发过谁，他当初说了什么，我们回了什么。
//
// 这三样必须摆在一起看。只看我们发了什么，判断不了话说得对不对；
// 只看对方原话，又不知道我们回的是不是这个人的情况。
async function renderSent(b) {
  b.appendChild(el('div', 'xhsc-empty', '读取中'));
  const rows = await sentList(500, Trade.now.key);
  b.innerHTML = '';

  const ok = rows.filter((r) => r.status === '成功').length;
  const nums = el('div', 'xhsc-nums');
  const mk = (value, label, n, clickable) => {
    const one = el('div', 'xhsc-num' + (clickable && UI.sentOnlyOk === value ? ' on' : ''),
      '<b>' + n + '</b><span>' + label + '</span>');
    if (clickable) {
      one.addEventListener('click', () => {
        UI.sentOnlyOk = value;
        renderBody();
      });
    }
    return one;
  };
  nums.appendChild(mk(false, '全部', rows.length, true));
  nums.appendChild(mk(true, '成功', ok, true));
  // 失败那一格只报数，点不了。失败的记录混在全部里看更省事。
  nums.appendChild(mk(null, '失败', rows.length - ok, false));
  b.appendChild(nums);

  const list = UI.sentOnlyOk ? rows.filter((r) => r.status === '成功') : rows;
  if (!list.length) {
    b.appendChild(el('div', 'xhsc-empty', '还没发过私信'));
    return;
  }
  for (const s of list) {
    const good = s.status === '成功';
    const c = el('div', 'xhsc-card');
    const who = el('div', 'xhsc-who');
    who.appendChild(avatar(s.nickname));
    who.appendChild(el('div', 'xhsc-name', esc(s.nickname || '匿名')));
    who.appendChild(el('span', 'xhsc-tag' + (good ? ' hot' : ' bad'), esc(s.status)));
    c.appendChild(who);
    if (s.said) c.appendChild(el('p', '', esc(head(s.said, 120))));
    c.appendChild(el('p', 'xhsc-talk', esc(s.text)));
    const foot2 = el('div', 'xhsc-who');
    foot2.appendChild(el('span', 'xhsc-time', esc(asText(s.at).slice(0, 16))));
    // 失败的把原因带出来，光写个失败查不出卡在哪一步
    if (!good && s.detail) {
      foot2.appendChild(el('span', 'xhsc-time', esc(head(s.detail.split('|')[0], 40))));
    }
    c.appendChild(foot2);
    b.appendChild(c);
  }
}

// ---------- 设置页 ----------

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

async function renderSettings(b) {
  const c = await counts();
  b.appendChild(el('div', 'xhsc-who',
    '<span class="xhsc-tag">帖子 ' + c.notes + '</span>' +
    '<span class="xhsc-tag">评论 ' + c.comments + '</span>' +
    '<span class="xhsc-tag">' + (hookInstalled() ? '钩子已装' : '钩子没装上') + '</span>'));

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
    UI.note = null;
    _peopleCache = null;
    renderBody();
  });
  rowTrade.appendChild(sel);
  b.appendChild(rowTrade);

  // 发送节奏
  const nSize = el('input');
  nSize.type = 'number';
  nSize.value = Limits.batchSize;
  nSize.min = kBatchSizeMin;
  nSize.max = kBatchSizeMax;
  const rowSize = el('div', 'xhsc-row', '<label>一批发几个</label>');
  rowSize.appendChild(nSize);
  b.appendChild(rowSize);

  const nMin = el('input');
  nMin.type = 'number';
  nMin.value = Limits.batchMinutes;
  nMin.min = kBatchMinutesMin;
  nMin.max = kBatchMinutesMax;
  const rowMin = el('div', 'xhsc-row', '<label>多少分钟发完</label>');
  rowMin.appendChild(nMin);
  b.appendChild(rowMin);

  const saveRow = el('div', 'xhsc-btns');
  const saveBtn = el('button', 'xhsc-btn ghost', '记下这个节奏');
  saveBtn.addEventListener('click', async () => {
    await Limits.saveBatch(nSize.value, nMin.value);
    // 真快成这样也照发，只是把话说在前面
    say(Limits.tooFast()
      ? '记下了，平均 ' + Math.round(Limits.avgGapSeconds()) + ' 秒一条，比真人快'
      : '记下了');
  });
  saveRow.appendChild(saveBtn);
  b.appendChild(saveRow);

  // 评论话术
  b.appendChild(el('div', 'xhsc-msg', '评论话术'));
  for (let i = 0; i < Trade.talks.length; i++) {
    const t = Trade.talks[i];
    const card = el('div', 'xhsc-card');
    const ta = el('textarea');
    ta.value = t.text;
    ta.addEventListener('change', async () => {
      Trade.talks[i].text = ta.value.trim();
      await Trade.saveTalks();
    });
    card.appendChild(ta);
    const mini = el('div', 'xhsc-mini');
    const on = el('button', '', t.on ? '发这条' : '不发这条');
    on.addEventListener('click', async () => {
      Trade.talks[i].on = !Trade.talks[i].on;
      await Trade.saveTalks();
      renderBody();
    });
    const del = el('button', '', '删掉');
    del.addEventListener('click', async () => {
      Trade.talks.splice(i, 1);
      await Trade.saveTalks();
      renderBody();
    });
    mini.appendChild(on);
    mini.appendChild(del);
    card.appendChild(mini);
    b.appendChild(card);
  }
  const addRow = el('div', 'xhsc-btns');
  const addBtn = el('button', 'xhsc-btn ghost', '加一条话术');
  addBtn.addEventListener('click', async () => {
    Trade.talks.push({ text: '', on: true });
    await Trade.saveTalks();
    renderBody();
  });
  addRow.appendChild(addBtn);
  b.appendChild(addRow);

  // 数据
  const add = (text, fn, ghost) => {
    const row = el('div', 'xhsc-btns');
    const btn = el('button', 'xhsc-btn' + (ghost ? ' ghost' : ''), text);
    btn.addEventListener('click', fn);
    row.appendChild(btn);
    b.appendChild(row);
  };

  add('导出全部数据', async () => {
    const data = await exportAll();
    download('获客数据_' + siteNow() + '_' + todayCst() + '.json',
      JSON.stringify(data), 'application/json');
  }, true);

  add('导出人名单表格', async () => {
    const cache = await loadPeople();
    download('人_' + todayCst() + '.csv', peopleCsv(cache.keep), 'text/csv');
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
      say('导入了 ' + n + ' 条');
    } catch (e) {
      say('这个文件读不了');
    }
    _peopleCache = null;
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
    _peopleCache = null;
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
  // 采集和发送都是靠跳页面推进的，页面每跳一次这里就重来一次，
  // 所以这几步必须便宜且可以重复做。
  await Trade.load();
  await Limits.load();
  await Limits.loadBatch();
  Runtime.job = (await getJob()) || null;
  Sender.job = (await getSendJob()) || null;

  mountPanel();

  const busyNow = () =>
    !!(Runtime.job && Runtime.job.running) || !!(Sender.job && Sender.job.running);

  let wasBusy = null;
  const onAny = () => {
    if (!UI.open) {
      // 关着的时候只让按钮变个字，说明有活在跑
      UI.fab.textContent = busyNow() ? '跑着呢' : '获客';
      return;
    }
    const running = busyNow();
    // 跑起来的页面上没有输入框，随便重画；不跑的时候重画会把
    // 用户填了一半的参数抹掉，所以只在运行状态变了的时候重画
    if (running || wasBusy !== running) renderBody();
    wasBusy = running;
  };
  Runtime.onChange = onAny;
  Sender.onChange = onAny;

  wasBusy = busyNow();
  if (wasBusy) {
    UI.fab.textContent = '跑着呢';
    // 发送时默认停在人页，那一页就是发送进度
    if (Sender.job && Sender.job.running) UI.tab = '人';
    togglePanel(true);
    for (const o of UI.panel.querySelectorAll('.xhsc-tab')) {
      o.classList.toggle('on', o.textContent === UI.tab);
    }
  }

  startHeartbeat();

  // 有没有活要接着干，问状态机自己。
  //
  // 两台状态机都靠跳页面推进，同时跑会互相把页面抢走，所以一次只让一台动。
  // 发送优先：它是一条一条留痕的，被打断的代价比采集大得多。
  if (Sender.job && Sender.job.running) await driveSend();
  else await drive();
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
  Sender: Sender,
  drive: drive,
  driveSend: driveSend,
  startCollect: startCollect,
  stopCollect: stopCollect,
  startSend: startSend,
  stopSend: stopSend,
  humanDone: humanDone,
  parseCaptured: parseCaptured,
  parseDouyin: parseDouyin,
  parseHere: parseHere,
  Limits: Limits,
  Trade: Trade,
  hookInstalled: hookInstalled,
  exportAll: exportAll,
  importAll: importAll,
  listPeople: listPeople,
  sentList: sentList,
  makeReply: makeReply,
  renderBody: renderBody,
  siteNow: siteNow,
  UI: UI,
};


})();
