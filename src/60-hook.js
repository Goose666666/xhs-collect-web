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
