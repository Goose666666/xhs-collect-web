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
.xhsc-time { font-size: 12px; color: #aaa; }
.xhsc-mini { display: flex; gap: 8px; }
.xhsc-mini button { flex: 1; height: 36px; border-radius: 9px; border: 1px solid #eee;
  background: #fff; color: #333; cursor: pointer; font-size: 13.5px; }
.xhsc-empty { text-align: center; color: #aaa; font-size: 14px; padding: 40px 0; }
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
    const who = el('div', 'xhsc-who');
    who.appendChild(el('div', 'xhsc-name',
      esc(n.title || head(n.content, 24) || '无标题')));
    c.appendChild(who);
    c.appendChild(el('div', 'xhsc-who',
      '<span class="xhsc-tag">' + esc(n.author_name) + '</span>' +
      '<span class="xhsc-tag">赞 ' + asInt(n.likes) + '</span>' +
      '<span class="xhsc-tag">评论 ' + asInt(n.comment_cnt) + '</span>' +
      (n.ip_location ? '<span class="xhsc-tag">' + esc(n.ip_location) + '</span>' : '') +
      (n.keyword ? '<span class="xhsc-tag hot">' + esc(n.keyword) + '</span>' : '')));
    if (n.content) c.appendChild(el('p', '', esc(head(n.content, 90))));
    c.style.cursor = 'pointer';
    c.addEventListener('click', () => {
      if (n.note_url) window.open(n.note_url, '_blank');
    });
    b.appendChild(c);
  }
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

function draftFor(p) {
  return makeReply(p.said, p.user_id, p.ip_location);
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
  if (p.intent === INTENT_HIGH) who.appendChild(el('span', 'xhsc-tag hot', '高意向'));
  if (p.ip_location) who.appendChild(el('span', 'xhsc-tag', esc(p.ip_location)));
  if (p.ts) who.appendChild(el('span', 'xhsc-time', esc(asText(p.ts).slice(0, 16))));
  c.appendChild(who);
  c.appendChild(el('p', '', esc(head(p.said, 150))));

  const talk = draftFor(p);
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
    const u = p.note_url || noteUrlHere(p.note_id, p.xsec_token);
    if (u) window.open(u, '_blank');
  });
  return c;
}

// ---------- 发送 ----------

async function launchSend(people, kind) {
  const list = people.map((p) => Object.assign({}, p, { text: p.text || draftFor(p) }));
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
  const list = notes.map((p) => Object.assign({}, p, {
    text: talks[Math.floor(Math.random() * talks.length)],
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
