// 跟控制台网页对话。
//
// 控制台是站点上的一个页面，打开它就能登录、采集、私信，跟手机版 app
// 的界面一样。但浏览器不允许一个域的网页去读另一个域的登录态和数据，
// 所以控制台自己什么都干不了。
//
// 它做的是另一件事：开一个小红书的标签页，那边装着这个脚本，真正的活
// 全在那边干。两边用 postMessage 说话，控制台发指令、要数据，
// 这边执行、回状态。结构跟 app 里控制台加 WebView 是一样的，
// 只是中间那层从进程内调用换成了跨标签页的消息。
//
// 采集本身是靠跳页面推进的，每跳一次这个脚本就重新加载一次，
// 监听也跟着重装。所以控制台不能只握一次手就完事，它是隔一会儿问一次，
// 谁在就谁答。

// 只认这一个来路。
//
// 不校验的话，任何一个网页都能开一个小红书标签页，然后指挥它拿数据、
// 发私信。那等于把账号交出去了。
const CONSOLE_ORIGINS = [
  'https://goose666666.github.io',
  // 本地调试用。真站点在上面那一个，这个只在 127.0.0.1 上成立。
  'http://127.0.0.1',
  'http://localhost',
];

function allowedConsole(origin) {
  const o = asText(origin);
  return CONSOLE_ORIGINS.some((x) => o === x || o.indexOf(x + ':') === 0);
}

// 把当前状态收成一份给控制台看的东西。
async function bridgeStatus() {
  const job = Runtime.job || {};
  const send = Sender.job || {};
  const c = await counts();
  return {
    site: siteNow(),
    // 页面在要登录的话，采集跑起来也是白跑，控制台要先把这个摆出来
    loggedIn: !isLoginWall(riskWord()),
    hook: hookInstalled(),
    trade: Trade.now.key,
    tradeName: Trade.now.name,
    keywords: Trade.now.keywords,
    talks: Trade.talks,
    counts: c,
    crawlSize: Limits.crawlSize,
    crawlMinutes: Limits.crawlMinutes,
    batchSize: Limits.batchSize,
    batchMinutes: Limits.batchMinutes,
    collect: {
      running: !!job.running,
      paused: !!job.paused,
      word: currentWord(job),
      wi: job.wi || 0,
      words: (job.keywords || []).length,
      message: asText(job.message),
      stats: job.stats || {},
      log: (job.log || []).slice(-30),
    },
    send: {
      running: !!send.running,
      paused: !!send.paused,
      kind: asText(send.kind),
      i: send.i || 0,
      total: (send.targets || []).length,
      waiting: asText(send.waiting),
      message: asText(send.message),
      stats: send.stats || {},
      log: (send.log || []).slice(-30),
    },
  };
}

// 控制台要什么就给什么。
async function bridgeHandle(msg) {
  const what = asText(msg.what);
  switch (what) {
    case 'status':
      return await bridgeStatus();

    case 'export':
      return await exportAll();

    case 'people': {
      const all = await listPeople({ trade: Trade.now.key, order: 'likes' });
      const blocked = await blockedIds();
      const res = runFunnel(all, { blocked: blocked });
      return {
        stat: res.stat,
        rows: res.keep.slice(0, 300).map((p) => Object.assign({}, p, {
          talk: talkFor(p),
        })),
      };
    }

    case 'notes': {
      const rows = (await getAll('notes'))
        .filter((n) => asTrade(n.trade) === Trade.now.key)
        .sort((a, b) => asInt(b.likes) - asInt(a.likes));
      return { rows: rows.slice(0, 300) };
    }

    case 'comments': {
      const noteId = asText(msg.noteId);
      const notes = await getAll('notes');
      const n = notes.find((x) => x.note_id === noteId) || {};
      const noteText = (asText(n.title) + ' ' + asText(n.content)).trim();
      const all = (await getAll('comments')).filter((c) => c.note_id === noteId);
      return {
        note: n,
        rows: orderComments(all).map((c) => ({
          row: c,
          sex: guessGender(c.nickname, c.content, noteText),
          intent: judgePerson(c.nickname, c.content),
        })),
      };
    }

    case 'sent':
      return { rows: await sentList(300, Trade.now.key) };

    case 'startCollect':
      await startCollect({
        keywords: listOf(msg.keywords).map(asText).filter(Boolean),
        maxNotes: Limits.clampSize(msg.maxNotes),
        maxComments: asInt(msg.maxComments),
        onlyOwner: !!msg.onlyOwner,
        trade: Trade.now.key,
      });
      return { ok: true };

    case 'pauseCollect':
      await pauseCollect();
      return { ok: true };

    case 'resumeCollect':
      await resumeCollect();
      return { ok: true };

    case 'stopCollect':
      await stopCollect();
      return { ok: true };

    case 'startSend': {
      const all = await listPeople({ trade: Trade.now.key, order: 'likes' });
      const blocked = await blockedIds();
      const keep = runFunnel(all, { blocked: blocked }).keep;
      const kind = asText(msg.kind) === '评论' ? '评论' : '私信';
      // 挑人的规矩跟面板上那两个按钮一样：私信只发评论区的人，
      // 评论按帖子去重。控制台不能比面板宽松，不然从这儿发反倒更容易出事。
      const list = kind === '私信'
        ? keep.filter((p) => p.user_id && p.kind !== '帖主' && canOpenProfile(p.user_id))
        : dedupeByNote(keep);
      if (kind === '评论') {
        const talks = draftTalks();
        if (!talks.length) return { ok: false, why: '先去设置里写几条评论话术' };
        const from = Math.floor(Math.random() * 97);
        return await startSend(list.map((p, i) => Object.assign({}, p, {
          text: talks[(from + i) % talks.length],
          nickname: '',
        })), kind);
      }
      return await startSend(list, kind);
    }

    case 'pauseSend':
      await pauseSend();
      return { ok: true };

    case 'resumeSend':
      await resumeSend();
      return { ok: true };

    case 'stopSend':
      await stopSend();
      return { ok: true };

    case 'humanDone':
      await humanDone();
      return { ok: true };

    case 'block':
      await blockUser(asText(msg.userId), asText(msg.nickname), '控制台拉黑');
      return { ok: true };

    case 'trade':
      await Trade.switchTo(asText(msg.trade));
      return { ok: true };

    case 'limits':
      await Limits.save(msg.crawlSize, msg.crawlMinutes);
      await Limits.saveBatch(msg.batchSize, msg.batchMinutes);
      return { ok: true };

    case 'talks':
      Trade.talks = listOf(msg.talks).map((t) => ({
        text: asText(mapOf(t).text),
        on: mapOf(t).on !== false,
      }));
      await Trade.saveTalks();
      return { ok: true };

    default:
      return { ok: false, why: '不认识这个指令 ' + what };
  }
}

// 按帖子去重。同一篇底下有好几个人，评论是发给帖子的不是发给人的。
function dedupeByNote(rows) {
  const seen = new Set();
  const out = [];
  for (const p of rows) {
    if (!p.note_id || seen.has(p.note_id)) continue;
    seen.add(p.note_id);
    out.push(p);
  }
  return out;
}

function installBridge() {
  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.__xhsc !== 'ask') return;
    if (!allowedConsole(ev.origin)) return;
    let out;
    try {
      out = await bridgeHandle(d);
    } catch (e) {
      out = { ok: false, why: asText(e && e.message ? e.message : e) };
    }
    try {
      ev.source.postMessage(
        { __xhsc: 'answer', id: d.id, what: d.what, data: out }, ev.origin);
    } catch (e) {}
  });
}
