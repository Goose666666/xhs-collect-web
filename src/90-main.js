// 入口。
//
// 钩子要在页面自己的脚本跑起来之前装好，所以这一段在 document-start 就执行。
// 界面得等 body 出来才能挂，所以分两步。

installHooks();

async function boot() {
  // 采集在跑的时候，页面每跳一次这里就重来一次，
  // 所以这几步必须便宜且可以重复做。
  await Trade.load();
  await Limits.load();
  Runtime.job = (await getJob()) || null;

  mountPanel();

  let wasRunning = null;
  Runtime.onChange = (job) => {
    if (!UI.open) {
      // 关着的时候只让按钮变个色，说明有活在跑
      UI.fab.textContent = job && job.running ? '采集中' : '获客';
      return;
    }
    if (UI.tab !== '采集') return;
    // 采集页在跑的时候没有输入框，随便重画；不跑的时候重画会把
    // 用户填了一半的参数抹掉，所以只在运行状态变了的时候重画
    const running = !!(job && job.running);
    if (running || wasRunning !== running) renderBody();
    wasRunning = running;
  };
  wasRunning = !!(Runtime.job && Runtime.job.running);
  if (wasRunning) {
    UI.fab.textContent = '采集中';
    togglePanel(true);
  }

  startHeartbeat();
  // 有没有活要接着干，问状态机自己
  await drive();
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
  drive: drive,
  startCollect: startCollect,
  stopCollect: stopCollect,
  parseCaptured: parseCaptured,
  Limits: Limits,
  Trade: Trade,
  hookInstalled: hookInstalled,
  exportAll: exportAll,
  importAll: importAll,
  listPeople: listPeople,
  makeReply: makeReply,
  renderBody: renderBody,
  UI: UI,
};
