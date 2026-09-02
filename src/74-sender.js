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
