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
