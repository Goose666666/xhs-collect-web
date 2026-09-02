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
