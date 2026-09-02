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
