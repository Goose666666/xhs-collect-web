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
