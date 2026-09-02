// 采多少篇，用多长时间采完。
//
// 不设每小时每天的上限，因为真人本来就不是均匀刷的。刷到一批感兴趣的帖子
// 连着翻二十分钟，然后放下手机，这才是正常节奏。全天每五分钟准时翻一篇，
// 反倒一眼就是机器。
//
// 所以只设两个数：这一轮采几篇，用多久采完。中间的间隔由程序随机切，
// 每段长短不一，采完就停。这跟手机版 lib/local/limits.dart 是同一套算法。

const kCrawlSizeDefault = 50;
const kCrawlSizeMin = 5;
const kCrawlSizeMax = 300;

const kCrawlMinutesDefault = 30;
const kCrawlMinutesMin = 5;
const kCrawlMinutesMax = 480;

// 两篇之间至少隔多少秒。
//
// 不是为了慢，是防止翻得比页面加载还快，那样评论根本来不及渲染，
// 抓回来全是空的。采集只是看，不留痕，所以可以比发东西快得多。
const kCrawlMinGapSeconds = 3;

const Limits = {
  crawlSize: kCrawlSizeDefault,
  crawlMinutes: kCrawlMinutesDefault,

  clampSize(v) {
    const n = asInt(v);
    return n < kCrawlSizeMin ? kCrawlSizeMin : (n > kCrawlSizeMax ? kCrawlSizeMax : n);
  },

  clampMinutes(v) {
    const n = asInt(v);
    return n < kCrawlMinutesMin ? kCrawlMinutesMin : (n > kCrawlMinutesMax ? kCrawlMinutesMax : n);
  },

  // 采集时两篇之间等多少秒。
  //
  // 按总时长摊到每篇上，不够最小间隔就按最小间隔来。
  // 每次在这个数上下浮动四成，固定节奏本身就是特征。
  gapSeconds() {
    const n = Limits.crawlSize <= 1 ? 1 : Limits.crawlSize - 1;
    const avg = Limits.crawlMinutes * 60 / n;
    const base = avg < kCrawlMinGapSeconds ? kCrawlMinGapSeconds : avg;
    const v = Math.round(base * (0.6 + Math.random() * 0.8));
    return v < kCrawlMinGapSeconds ? kCrawlMinGapSeconds : v;
  },

  async load() {
    Limits.crawlSize = Limits.clampSize(await getSetting('crawl_size', kCrawlSizeDefault));
    Limits.crawlMinutes = Limits.clampMinutes(
      await getSetting('crawl_minutes', kCrawlMinutesDefault));
  },

  async save(size, minutes) {
    Limits.crawlSize = Limits.clampSize(size);
    Limits.crawlMinutes = Limits.clampMinutes(minutes);
    await setSetting('crawl_size', Limits.crawlSize);
    await setSetting('crawl_minutes', Limits.crawlMinutes);
  },
};

// 页面打开之后先假装看一会儿，随手滚两到四下再动手。
// 一打开就翻到底，节奏上一眼假。
const readScrollMin = 2;
const readScrollMax = 4;
const readStepMin = 300;
const readStepMax = 900;
const readPauseMin = 700;
const readPauseMax = 1800;
const readTailMin = 1200;
const readTailMax = 3000;

// 接口等多久算没来。搜索第一屏慢一些，翻页的后续批次快。
const waitFirstMs = 20000;
const waitMoreMs = 6000;
const waitCommentMs = 10000;
const waitCommentMoreMs = 4000;

// 连着几批没有新数据就认为到底了。
const idleGiveUp = 4;

// 评论要多试几次才放弃。
//
// 评论是懒加载的，翻到底之后接口还在路上，两三次空转很常见。
// 按搜索那个次数放弃的话，每篇只能抓到最上面十几条，
// 底下真正在应征的人全漏掉了。
const commentGiveUp = 8;

// ---------- 发送的节奏 ----------
//
// 采集只是看，发东西是留痕的。一天几十条加上一分钟连发，
// 是被判成营销号最快的两条路，所以这几个数比一般人想的严得多。

// 一批发几个人。
const kBatchSizeDefault = 20;
const kBatchSizeMin = 1;
const kBatchSizeMax = 60;

// 这一批用多少分钟发完。
const kBatchMinutesDefault = 20;
const kBatchMinutesMin = 5;
const kBatchMinutesMax = 240;

// 两条之间至少隔多少秒。
//
// 不是为了慢，是防止程序卡住或者页面秒开时瞬间连发好几条。
// 真人再快也要看一眼再点。
const kMinGapSeconds = 20;

// 一天最多发几条评论。私信的上限按一批算，见 batchSize。
const kCommentPerDay = 10;

// 平均每条快到什么程度就该提醒一句。
//
// 比最小间隔宽一些。二十分钟发六十个平均二十秒，刚好压在最小间隔上，
// 按最小间隔判的话它算合格，可那个速度已经不是人能做到的了。
const kSaneGapSeconds = 30;

Limits.batchSize = kBatchSizeDefault;
Limits.batchMinutes = kBatchMinutesDefault;

Limits.clampBatchSize = function (v) {
  const n = asInt(v);
  return n < kBatchSizeMin ? kBatchSizeMin : (n > kBatchSizeMax ? kBatchSizeMax : n);
};

Limits.clampBatchMinutes = function (v) {
  const n = asInt(v);
  return n < kBatchMinutesMin
    ? kBatchMinutesMin
    : (n > kBatchMinutesMax ? kBatchMinutesMax : n);
};

// 平均每条隔多少秒。用来告诉人这个组合快到什么程度。
Limits.avgGapSeconds = function () {
  return Limits.batchSize <= 1
    ? 0
    : Limits.batchMinutes * 60 / (Limits.batchSize - 1);
};

// 这个组合快不快过真人。
//
// 真快成这样也照发，只是把话说在前面。二十分钟发二十个是正常的，
// 刷到一批合适的人集中发完就是这个节奏。
Limits.tooFast = function () {
  return Limits.batchSize > 1 && Limits.avgGapSeconds() < kSaneGapSeconds;
};

// 把这一批的时间随机切成若干段。
//
// 返回的是每条发送之前要等的秒数，第一条不等所以从第二条开始算，
// 一共 n-1 段，加起来正好是设定的总时长。
//
// 切法是先给每段一个随机权重再按比例分，这样长短参差不齐。
// 平均分再加个抖动的话，所有间隔都挤在平均值附近，
// 那个规律性本身就是特征。
Limits.plan = function (n, minutes) {
  if (n <= 1) return [];
  const total = (minutes === undefined ? Limits.batchMinutes : minutes) * 60;
  const gaps = n - 1;

  // 先垫上最小间隔，剩下的才拿去随机分
  const floor = kMinGapSeconds * gaps;
  const free = total - floor;
  if (free <= 0) {
    // 时间不够垫最小间隔，那就全按最小间隔来，宁可超时也不连发
    return new Array(gaps).fill(kMinGapSeconds);
  }

  const w = [];
  for (let i = 0; i < gaps; i++) w.push(Math.random() + 0.15);
  const sum = w.reduce((a, b) => a + b, 0);
  const out = [];
  let used = 0;
  for (let i = 0; i < gaps; i++) {
    // 最后一段拿走剩下全部，免得取整之后总时长对不上
    const extra = i === gaps - 1 ? free - used : Math.round(free * w[i] / sum);
    used += extra;
    out.push(kMinGapSeconds + extra);
  }
  return out;
};

Limits.loadBatch = async function () {
  Limits.batchSize = Limits.clampBatchSize(
    await getSetting('batch_size', kBatchSizeDefault));
  Limits.batchMinutes = Limits.clampBatchMinutes(
    await getSetting('batch_minutes', kBatchMinutesDefault));
};

Limits.saveBatch = async function (size, minutes) {
  Limits.batchSize = Limits.clampBatchSize(size);
  Limits.batchMinutes = Limits.clampBatchMinutes(minutes);
  await setSetting('batch_size', Limits.batchSize);
  await setSetting('batch_minutes', Limits.batchMinutes);
};
