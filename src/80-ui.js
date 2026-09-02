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
