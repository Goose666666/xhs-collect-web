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
