// 从平台自己的消息页上读别人找过来的那些。
//
// 谁私信了我、谁回复了我、谁给我点了赞，这三样只在平台的消息中心和
// 通知页里，接口那条路读不到。这一段就是照着页面读。
//
// 逐条照手机版 lib/local/poster.dart 里那几段脚本写。手机版是把脚本
// 塞进网页控件里跑，网页版本来就跑在页面里，直接读就行。

// 一条会话或者一条通知上的时间长什么样。
//
// 时间不单独占一行。实测一条是这样两行：
//   富贵迷人眼
//   赞了你的笔记昨天 18:48
// 说明和时间粘在一起，按整行比时间的话一条都认不出来，
// 所以只要行里带时间就算。
const STAMP = /(刚刚|昨天|前天|今天|星期.|周.|[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}:[0-9]{2}|[0-9]{1,2}[-月/][0-9]{1,2}日?|[0-9]+ ?(分钟|小时|天|周|月|个月|年)前)/;

// 这一行不是他说的话，是页面自己的标注。
//
// 抖音的会话行里混着在线状态和占位符，照收的话名单上一串「昨天在线」
// 「暂不支持该消息类型」，看不出谁说了什么。
const NOT_SAID = /^((刚刚|昨天|前天|[0-9]+ ?(分钟|小时|天))?内?在线|暂不支持该消息类型|\[.{0,8}\]|草稿|.{0,4}已撤回.{0,6})$/;

// 这一行是不是只有时间，没有内容。
//
// 不能拿整行去比时间。抖音一条会话的时间是「昨天 00:42」，日期是 09/01
// 这种斜杠写法，按整行比一条都对不上，会话列表明明摆在那儿也读不出来。
// 把行里的时间片段全抠掉，剩不下字就是纯时间那一行。
function onlyTime(s) {
  const left = asText(s)
    .replace(new RegExp(STAMP.source, 'g'), '')
    .replace(/\s+/g, '');
  return left === '';
}

// 通知里那句说明。赞和回复的写法各家不同，都认一遍。
const NOTICE_KEY = /赞了你|点赞了你|赞了我|收藏了你|收藏了|回复了|回复你|评论了你|@了你|给你发消息|发来消息/;

function inboxLines(e) {
  const t = (e.innerText || '').trim();
  if (!t || t.length > 200) return null;
  return t.split('\n').map((x) => x.trim()).filter((x) => x);
}

// 把私信会话列表读出来，一条是一个 {who, text}。
//
// 先按类名找，命中的话最准。类名认不出来就按长相找：手机版和电脑版
// 是两套完全不同的页面，类名对不上，写死类名的话页面上明明列着几十条，
// 这边一条都读不出来。
//
// 一条会话长这样：昵称一行、最后一句一行、时间一行。按这个形状找，
// 两版都认得出。
function readInboxRows() {
  let items = [...document.querySelectorAll(
    '[class*="conversationConversationItem"],[class*="ConversationItem"],' +
    '[class*="sessionItem"],[class*="chatListItem"]')];

  if (items.length < 2) {
    const boxes = [];
    for (const e of document.querySelectorAll('div,li,a,section')) {
      const ls = inboxLines(e);
      if (!ls) continue;
      if (ls.length < 2 || ls.length > 5) continue;
      if (!ls.some(onlyTime)) continue;
      // 父块和子块常常长得一模一样，谁都不排除，最后靠去重收尾。
      //
      // 原来是发现里面还有同样长相的子块就跳过这一层，结果每条会话
      // 外面都套着一层同样长相的壳，一层层全被跳掉，一条都不剩。
      boxes.push(e);
    }
    if (boxes.length) items = boxes;
  }

  const out = [];
  const seen = new Set();
  for (const it of items) {
    const lines = inboxLines(it);
    if (!lines || lines.length < 2) continue;
    // 第一行是昵称，中间是最后一句，末尾常是时间和未读数
    const who = lines[0].slice(0, 30);
    const last = lines.slice(1)
      .filter((x) => !/^\d+$/.test(x))
      .filter((x) => !onlyTime(x))
      .filter((x) => !NOT_SAID.test(x))
      .join(' ')
      .slice(0, 80);
    if (!last) continue;
    // 一个人只留一条。
    //
    // 会话列表里一个人本来就只有一行，读出好几行是因为把日期分隔和
    // 在线状态那些小块也当成了会话。名单上同一个人连着出现三次，
    // 内容是昨天在线、2025/10/03 这种，看不出谁说了什么。
    if (seen.has(who)) continue;
    seen.add(who);
    out.push({ who: who, text: last });
    if (out.length >= 60) break;
  }
  return out;
}

// 一块看着像不像一条通知：两到六行，其中一行带时间。
//
// 光靠类名对上不够。实测选出来的常常是通知里的一小片，整块只有一行时间，
// 拿它当一条通知，昵称那一格里读出来的就是昨天、一天前这种。
function looksLikeNotice(e) {
  const ls = inboxLines(e);
  if (!ls) return false;
  if (ls.length < 2 || ls.length > 6) return false;
  return ls.some((x) => STAMP.test(x));
}

// 从一条通知的几行字里挑出昵称。
//
// 各家排法不一样，有的把时间放在最前面。照搬头一行的话，界面上一屏
// 人名全是昨天、一天前，一个真名都没有。
function noticeWho(lines) {
  for (const x of lines) {
    if (STAMP.test(x)) continue;
    if (NOTICE_KEY.test(x)) continue;
    if (/^(回复|删除|查看|关注|回关)$/.test(x)) continue;
    if (/^[0-9]+$/.test(x)) continue;
    if (x.length > 30) continue;
    return x;
  }
  return '';
}

// 这条通知底下的两个地址：他的主页和那篇帖子。
//
// 一条通知里常有好几个链接：头像和昵称指向主页，右边的缩略图指向帖子。
// 只取第一个的话，两样里总有一样拿不到，主页拿不到就点不开他，
// 帖子拿不到就回不去当时那条评论。两样不在同一层，往上走两层去够，
// 走太远会串到隔壁那条。
function noticeLinks(it) {
  let link = '';
  let home = '';
  let scope = it;
  for (let up = 0; up < 3 && scope; up++) {
    for (const a of scope.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      if (!link && (h.indexOf('/explore/') >= 0 || h.indexOf('/discovery/') >= 0 ||
        h.indexOf('/video/') >= 0 || h.indexOf('/note/') >= 0)) {
        link = h.slice(0, 200);
      }
      if (!home && (h.indexOf('/user/profile/') >= 0 || h.indexOf('/user/') >= 0)) {
        home = h.slice(0, 200);
      }
      if (link && home) break;
    }
    if (link && home) break;
    scope = scope.parentElement;
  }
  const m = home.match(/\/user(?:\/profile)?\/([A-Za-z0-9_-]+)/);
  return { link: link, user_id: m ? m[1] : '' };
}

// 把通知页读出来，一条是一个 {kind, who, text, mine, link, user_id, about}。
//
// assumeKind 是判不出类型时按哪一类算。有的版本点赞那一条只有一个爱心
// 图标，文字上看不出是赞还是回复，但我们是在赞那一栏里读的，
// 那一栏里的条目本来就都是赞。
function readNoticeRows(assumeKind) {
  let items = [...document.querySelectorAll(
    '[class*="notice"],[class*="Notice"],[class*="message-item"],' +
    '[class*="messageItem"],[class*="interaction"],li')].filter(looksLikeNotice);

  // 类名这条路走不通就按长相找。两家改版都换类名，写死类名的话，
  // 页面上明明看得见谁点了赞，这边一条都读不出来。
  if (items.length < 2) {
    const boxes = [];
    for (const e of document.querySelectorAll('div,li,section,article')) {
      // 先用 textContent 粗筛。取 innerText 会逼浏览器重新排版，
      // 页面上几千个元素挨个来一遍要好几秒。
      const raw = (e.textContent || '').trim();
      if (raw.length < 6 || raw.length > 200) continue;
      if (!looksLikeNotice(e)) continue;
      boxes.push(e);
      if (boxes.length >= 120) break;
    }
    if (boxes.length) items = boxes;
  }

  const out = [];
  const seen = new Set();
  for (const it of items) {
    const lines = inboxLines(it);
    if (!lines || !lines.length) continue;
    const t = lines.join('\n');

    let kind = '';
    // 收藏跟赞算一类：都是对帖子有反应但没开口
    if (/赞了你|点赞了你|赞了我|收藏了你|收藏了/.test(t)) kind = '点赞';
    else if (/回复了|回复你|评论了你|@了你/.test(t)) kind = '回复';
    else if (/给你发消息|发来消息/.test(t)) kind = '私信';
    else kind = asText(assumeKind);
    if (!kind) continue;

    const who = noticeWho(lines);
    if (!who) continue;

    // 昵称那一行去掉，时间和操作词也去掉，剩下的才是内容。
    // 昵称不一定在第一行，所以按内容剔，不能按位置切。
    const rest = lines
      .filter((x) => x !== who)
      .filter((x) => !NOTICE_KEY.test(x))
      .filter((x) => !onlyTime(x))
      .filter((x) => !/^(回复|删除|查看|关注|回关)$/.test(x));

    // 剩下的行里，最后一行往往是被他针对的那一条，也就是我自己发的。
    // 点赞那种本来就没有他说的话，剩下的唯一一行就是我那条评论；
    // 回复那种前面是他说的话，末尾才是引用的我那条。
    let body = '';
    let mine = '';
    if (!rest.length) {
      body = '';
    } else if (kind === '点赞') {
      mine = rest.join(' ').slice(0, 80);
    } else if (rest.length === 1) {
      body = rest[0].slice(0, 80);
    } else {
      body = rest.slice(0, rest.length - 1).join(' ').slice(0, 80);
      mine = rest[rest.length - 1].slice(0, 80);
    }

    // 他干了什么，照页面上那句原话记下来。各家写法不一样：赞了你的笔记、
    // 评论了你的笔记、赞了你的评论都有。自己按类型编一句的话，赞的明明是
    // 笔记，界面上却写着赞了你的评论，人照着去找那条评论根本找不着。
    let about = '';
    for (const x of lines) {
      if (!NOTICE_KEY.test(x)) continue;
      const at = x.search(STAMP);
      about = (at > 0 ? x.slice(0, at) : x).trim().slice(0, 20);
      break;
    }

    const mark = kind + who + body + mine;
    if (seen.has(mark)) continue;
    seen.add(mark);
    const at = noticeLinks(it);
    out.push({
      kind: kind,
      who: who,
      text: body,
      mine: mine,
      link: at.link,
      user_id: at.user_id,
      about: about,
    });
    if (out.length >= 80) break;
  }
  return out;
}

// 在通知页上点某一栏。
//
// 通知分栏：赞和评论各在一栏，默认停在评论那栏，不点一下就永远看不到
// 谁给我点了赞。而点赞的人恰恰是最该私信的。
//
// 已经在这一栏就什么都不做，有的版本点第二下会退回上一栏。
function pickNoticeTab(name) {
  const want = asText(name);
  if (!want) return 'none';
  const hit = [...document.querySelectorAll(
    'div,span,button,li,a,[role=tab],[role=button]')]
    .filter((e) => (e.textContent || '').trim() === want)
    .filter((e) => {
      const r = e.getBoundingClientRect();
      // 标签本身不大，套着它的大块和看不见的都排掉
      return r.width > 20 && r.width < 260 && r.height > 12 && r.height < 90 &&
        r.top >= 0 && r.top < window.innerHeight;
    })[0];
  if (!hit) return 'none';
  const on = (hit.className || '') + ' ' +
    ((hit.parentElement && hit.parentElement.className) || '');
  if (/active|selected|checked|cur/i.test(on)) return 'already';
  hit.click();
  return 'ok';
}

// 列表往下翻一屏。会话和通知都是懒加载的，不翻只读得到最上面那几条。
//
// 页面本身常常不滚，真正在滚的是列表里面那个能滚的块，两个都推一把。
function scrollInbox() {
  let best = null;
  for (const e of document.querySelectorAll('div,section,ul,main')) {
    if (e.scrollHeight - e.clientHeight < 200) continue;
    if (e.clientHeight < 200) continue;
    if (!best || e.clientHeight > best.clientHeight) best = e;
  }
  if (best) best.scrollTop = best.scrollTop + best.clientHeight;
  window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
  return best ? 'box' : 'window';
}

// 这句话是对方回的，不是我们发的那句。
//
// 会话列表上的最后一句常被截断，末尾还带个省略号，所以一头包含另一头
// 也算同一句，不然每条都会被当成回复。
function looksLikeReply(last, mine) {
  const bare = (s) => asText(s).replace(/\s+/g, '').replace(/[….]+$/, '');
  const a = bare(last);
  const b = bare(mine);
  if (!a) return false;
  if (!b) return true;
  if (a === b) return false;
  return a.indexOf(b) < 0 && b.indexOf(a) < 0;
}
