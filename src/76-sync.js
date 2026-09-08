// 把平台上的消息同步过来。
//
// 谁私信了我、谁回复了我、谁给我的评论点了赞，这三样都在平台自己的
// 消息中心和通知页里。这一趟挨个页面读一遍，存进本地。
//
// 跟采集和发送一样是一台状态机：换一次页面脚本就被重新加载一次，
// 进度只能存在库里，新页面起来读回去接着跑。
//
// 这批人是最该接着聊的：他们对我发的东西有反应，比评论区里的路人近得多。

const SYNC_KEY = 'sync';

// 一趟按顺序走这几站。
//
// tab 是通知页上要点的那一栏，赞和评论各在一栏，不点一下就看不到
// 谁点了赞，而点赞的人恰恰是最该私信的。
// assume 是这一栏里判不出类型时按哪一类算。
const SYNC_STOPS = [
  { at: 'chat', kind: '私信', tab: '', assume: '', rounds: 5 },
  { at: 'notice', kind: '回复', tab: '评论和@', assume: '回复', rounds: 3 },
  { at: 'notice', kind: '点赞', tab: '赞和收藏', assume: '点赞', rounds: 3 },
];

const Sync = {
  job: null,
  stopFlag: false,
  busy: false,
  onChange: null,
};

function emitSync() {
  if (Sync.onChange) {
    try { Sync.onChange(Sync.job); } catch (e) {}
  }
}

async function getSyncJob() {
  return await getOne('job', SYNC_KEY);
}

async function saveSyncJob(patch) {
  const job = Object.assign({}, Sync.job || {}, patch || {});
  job.id = SYNC_KEY;
  job.tab_id = TAB_ID;
  job.beat = Date.now();
  Sync.job = job;
  await putOne('job', job);
  emitSync();
  return job;
}

async function saySync(line) {
  const job = Sync.job || {};
  await saveSyncJob({ message: line, log: logLine(job, line) });
}

// ---------- 该待在哪个页面 ----------

function syncStop(job) {
  return SYNC_STOPS[asInt(job.step)] || null;
}

// 小红书网页版的私信页是 /chat，不是 /im 也不是 /messages，
// 那两个都直接跳 404。抖音的是 /chat。
//
// 抖音没有单独的通知页，赞和评论在首页右上角那个铃铛里，那个面板只认
// 真的鼠标悬停，用户脚本派不出来，所以抖音只同步私信。
function syncWantUrl(stop) {
  if (onDouyin()) {
    return stop.at === 'chat' ? 'https://www.douyin.com/chat' : '';
  }
  return stop.at === 'chat'
    ? 'https://www.xiaohongshu.com/chat'
    : 'https://www.xiaohongshu.com/notification';
}

function onSyncPage(stop) {
  const path = location.pathname;
  if (stop.at === 'chat') {
    return path.indexOf('/chat') === 0 || path.indexOf('/im') === 0 ||
      path.indexOf('/message') === 0;
  }
  return path.indexOf('/notification') === 0;
}

// ---------- 读一站 ----------

// 列表是懒加载的，读几轮，中间往下翻。
async function readOneStop(job, stop) {
  if (stop.tab) {
    const r = pickNoticeTab(stop.tab);
    // 这一栏点不着就跳过，各版本的叫法不一样
    if (r === 'none') {
      await saySync('页面上没有「' + stop.tab + '」这一栏，跳过');
      return 0;
    }
    // 这一栏刚点开，等它把列表铺出来再读
    await syncNap(2000);
  }
  let got = 0;
  const mine = await sentByName();
  for (let i = 0; i < stop.rounds; i++) {
    if (syncStopped()) break;
    const rows = stop.at === 'chat'
      ? readInboxRows()
      : readNoticeRows(stop.assume);
    got += await keepRows(rows, stop, mine);
    await saySync('读' + stop.kind + '，收到 ' + (asInt(job.got) + got) + ' 条');
    scrollInbox();
    await syncNap(1500);
  }
  return got;
}

// 发过的那些人，按昵称索引。读之前查一次就够。
//
// 一条一条重查的话，读五轮就是五次全表，中间界面全卡着。
async function sentByName() {
  const rows = await sentList(500, '');
  const by = new Map();
  for (const r of rows) {
    if (r.nickname && !by.has(r.nickname)) by.set(r.nickname, r);
  }
  return by;
}

// 读到的这一批存下来。
//
// 会话列表里这些人有的是我们发过的，有的是他自己找上门的。不管哪种都收，
// 名单要全。发过的那些顺带对一遍，最后一句换了就是他回了。
async function keepRows(rows, stop, mine) {
  if (!rows || !rows.length) return 0;
  const site = siteNow();
  const trade = Trade.now.key;
  const out = [];
  for (const r of rows) {
    if (stop.at === 'chat') {
      const one = mine.get(r.who);
      if (one && looksLikeReply(r.text, one.text)) {
        await markReplied(r.who, r.text);
      }
    }
    out.push(Object.assign({}, r, {
      kind: r.kind || stop.kind,
      site: site,
      trade: trade,
    }));
  }
  return await addInboxAll(out);
}

// ---------- 等待 ----------

function syncStopped() {
  return Sync.stopFlag || !Sync.job || !Sync.job.running;
}

async function syncNap(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (syncStopped()) return;
    await sleep(Math.min(300, end - Date.now()));
  }
}

// 页面真的有东西了没有。
//
// 消息列表本来就只有昵称和几个字，一屏加起来常常不到四十，
// 卡在四十字上会白等到超时。
async function waitPage() {
  for (let i = 0; i < 40; i++) {
    if (syncStopped()) return false;
    const t = document.body ? (document.body.innerText || '') : '';
    if (t.trim().length > 5) return true;
    await syncNap(500);
  }
  return false;
}

// ---------- 对外 ----------

async function startSync() {
  if (Runtime.job && Runtime.job.running) {
    return { ok: false, why: '采集还在跑，先停下来再同步' };
  }
  if (Sender.job && Sender.job.running) {
    return { ok: false, why: '正在发东西，先停下来再同步' };
  }
  Sync.stopFlag = false;
  await saveSyncJob({
    running: true,
    step: 0,
    got: 0,
    log: [],
    message: '正在打开消息页',
    startedAt: Date.now(),
  });
  await driveSync();
  return { ok: true };
}

async function stopSync() {
  Sync.stopFlag = true;
  await finishSync('已停止');
}

async function finishSync(status) {
  const job = Sync.job || {};
  const n = asInt(job.got);
  await saveSyncJob({
    running: false,
    message: status === '已停止'
      ? '停了，收到 ' + n + ' 条'
      : (n > 0 ? '收到 ' + n + ' 条' : '没有新消息'),
  });
  Sync.stopFlag = false;
}

async function nextStop(job, got) {
  const step = asInt(job.step) + 1;
  const total = asInt(job.got) + got;
  if (step >= SYNC_STOPS.length) {
    await saveSyncJob({ got: total });
    await finishSync('完成');
    return;
  }
  await saveSyncJob({ step: step, got: total });
}

async function driveSync() {
  if (Sync.busy) return;
  const job = Sync.job;
  if (!job || !job.running) return;
  // 另一个标签页正在跑，本页只看不动
  if (job.tab_id && job.tab_id !== TAB_ID &&
    Date.now() - (job.beat || 0) < TAKEOVER_MS) {
    return;
  }

  Sync.busy = true;
  try {
    const stop = syncStop(job);
    if (!stop) {
      await finishSync('完成');
      return;
    }
    const url = syncWantUrl(stop);
    if (!url) {
      // 抖音没有通知页，剩下的站直接跳过
      await nextStop(job, 0);
      return;
    }
    if (!onSyncPage(stop)) {
      await saySync('正在打开' + (stop.at === 'chat' ? '私信页' : '通知页'));
      location.href = url;
      return;
    }
    if (!await waitPage()) {
      await saySync('页面没打开，看看是不是没登录');
      await finishSync('已停止');
      return;
    }
    const got = await readOneStop(job, stop);
    if (syncStopped()) {
      await finishSync('已停止');
      return;
    }
    await nextStop(Sync.job, got);
    // 下一站多半在另一个页面。这里只管把车开过去，到了之后新的一轮
    // 加载会自己接上。放进定时器是为了等上面这一轮先把 busy 放掉，
    // 直接递归的话新的一轮进来看到 busy 还在，扭头就走，整趟停在这儿。
    setTimeout(() => { driveSync(); }, 300);
  } catch (e) {
    await saySync('出错了 ' + (e && e.message ? e.message : e));
    await finishSync('已停止');
  } finally {
    Sync.busy = false;
  }
}
