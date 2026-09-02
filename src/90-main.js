// 入口。
//
// 钩子要在页面自己的脚本跑起来之前装好，所以这一段在 document-start 就执行。
// 界面得等 body 出来才能挂，所以分两步。

installHooks();

async function boot() {
  // 采集和发送都是靠跳页面推进的，页面每跳一次这里就重来一次，
  // 所以这几步必须便宜且可以重复做。
  await Trade.load();
  await Limits.load();
  await Limits.loadBatch();
  Runtime.job = (await getJob()) || null;
  Sender.job = (await getSendJob()) || null;

  mountPanel();

  const busyNow = () =>
    !!(Runtime.job && Runtime.job.running) || !!(Sender.job && Sender.job.running);

  let wasBusy = null;
  const onAny = () => {
    if (!UI.open) {
      // 关着的时候只让按钮变个字，说明有活在跑
      UI.fab.textContent = busyNow() ? '跑着呢' : '获客';
      return;
    }
    const running = busyNow();
    // 跑起来的页面上没有输入框，随便重画；不跑的时候重画会把
    // 用户填了一半的参数抹掉，所以只在运行状态变了的时候重画
    if (running || wasBusy !== running) renderBody();
    wasBusy = running;
  };
  Runtime.onChange = onAny;
  Sender.onChange = onAny;

  wasBusy = busyNow();
  if (wasBusy) {
    UI.fab.textContent = '跑着呢';
    // 发送时默认停在人页，那一页就是发送进度
    if (Sender.job && Sender.job.running) UI.tab = '人';
    togglePanel(true);
    for (const o of UI.panel.querySelectorAll('.xhsc-tab')) {
      o.classList.toggle('on', o.textContent === UI.tab);
    }
  }

  startHeartbeat();

  // 有没有活要接着干，问状态机自己。
  //
  // 两台状态机都靠跳页面推进，同时跑会互相把页面抢走，所以一次只让一台动。
  // 发送优先：它是一条一条留痕的，被打断的代价比采集大得多。
  if (Sender.job && Sender.job.running) await driveSend();
  else await drive();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    boot();
  });
} else {
  boot();
}

// 出问题时能从控制台看一眼内部状态。
//
// 这套东西跑在别人的手机上，看不到日志，出了问题只能让人打开控制台
// 敲一句 __xhs.Buckets 看看钩子有没有收到东西。留这个口子比猜便宜得多。
window.__xhs = {
  Buckets: Buckets,
  Runtime: Runtime,
  Sender: Sender,
  drive: drive,
  driveSend: driveSend,
  startCollect: startCollect,
  stopCollect: stopCollect,
  startSend: startSend,
  stopSend: stopSend,
  humanDone: humanDone,
  parseCaptured: parseCaptured,
  parseDouyin: parseDouyin,
  parseHere: parseHere,
  Limits: Limits,
  Trade: Trade,
  hookInstalled: hookInstalled,
  exportAll: exportAll,
  importAll: importAll,
  listPeople: listPeople,
  sentList: sentList,
  makeReply: makeReply,
  renderBody: renderBody,
  siteNow: siteNow,
  UI: UI,
};
