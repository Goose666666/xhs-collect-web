(function () {
'use strict';

// 看板没有本地库，行业设置存在 localStorage 里。
async function getSetting(k, d) {
  try {
    const v = localStorage.getItem('xhs_' + k);
    return v === null ? d : JSON.parse(v);
  } catch (e) { return d; }
}
async function setSetting(k, v) {
  try { localStorage.setItem('xhs_' + k, JSON.stringify(v)); } catch (e) {}
}

// ===== 10-util.js =====
// 取值和转换的小工具。
//
// 采回来的字段经常缺，或者该是数字的地方给了字符串，所以一律走这几个函数。
// 坏数据只会变成空串和 0，不会让整批数据存不进去。

function asText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

// 小红书把点赞数写成 1.2万 这种，直接 parseInt 会读成 1。
function asInt(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  if (!s) return 0;
  // 千分位逗号要先去掉，不然正则匹到逗号就停，1,234 会读成 1
  const lower = s.toLowerCase().replace(/[,，\s]/g, '');
  const mult = lower.includes('亿')
    ? 100000000
    : (lower.includes('万') || lower.includes('w') ? 10000 : 1);
  const m = lower.match(/[0-9]+(\.[0-9]+)?/);
  if (!m) return 0;
  return Math.round(parseFloat(m[0]) * mult);
}

// 平台缺省算小红书。留空的话按哪个平台筛都筛不出来，等于凭空消失。
function asSite(v) {
  const s = asText(v);
  return s || '小红书';
}

// 行业缺省算找对象。加这一列之前采的数据没记行业。
function asTrade(v) {
  const s = asText(v);
  return s || 'love';
}

function p2(v) {
  return String(v).padStart(2, '0');
}

// 时间统一按东八区写，跟手机版和电脑版一个格式。
//
// 不跟着设备时区走，是因为出国或者改了系统时区之后，存进去的时间会跟
// 另外两端对不上，按天分组的统计就全乱了。
function nowCst() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + p2(t.getUTCMonth() + 1) + '-' +
    p2(t.getUTCDate()) + ' ' + p2(t.getUTCHours()) + ':' +
    p2(t.getUTCMinutes()) + ':' + p2(t.getUTCSeconds());
}

function todayCst() {
  return nowCst().slice(0, 10);
}

// 时间戳转北京时间字符串。
//
// 接口给的可能是毫秒、秒，也可能已经是排好版的文字，最后那种原样留着。
function tsToStr(v) {
  const s = asText(v).trim();
  if (!s) return '';
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  let ms = Math.trunc(n);
  if (ms <= 0) return '';
  if (ms <= 10000000000) ms *= 1000;
  const t = new Date(ms + 8 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + p2(t.getUTCMonth() + 1) + '-' +
    p2(t.getUTCDate()) + ' ' + p2(t.getUTCHours()) + ':' +
    p2(t.getUTCMinutes()) + ':' + p2(t.getUTCSeconds());
}

function isMap(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mapOf(v) {
  return isMap(v) ? v : {};
}

function listOf(v) {
  return Array.isArray(v) ? v : [];
}

// 按给定顺序挨个试键名，返回第一个非空值。
function firstOf(m, keys) {
  for (const k of keys) {
    const s = asText(m[k]).trim();
    if (s) return s;
  }
  return '';
}

function truthy(v) {
  if (typeof v === 'boolean') return v;
  const s = asText(v).toLowerCase();
  return s === 'true' || s === '1';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(a, b) {
  return b <= a ? a : a + Math.floor(Math.random() * (b - a + 1));
}

// 一段文字裁到多少个字，超出的补省略号。
function head(s, n) {
  const t = asText(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

function esc(s) {
  return asText(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}


// ===== 57-draft.js =====
// 照着一条评论写一句回复。
//
// 评论区里的人说什么，回什么。群发同一句话谁都看得出来，也最容易被举报，
// 而看得出你读了他那句话的回复，才会有人来问。
//
// 找对象行业有一整套读条件的规则，直接用那份。别的行业没有那么细的判据，
// 就从这个行业自己的话术里挑一条，能接上对方原话的排前面。
//
// 逐行照着手机版 lib/local/draft.dart 写，两端出的话必须一样。

// 给这条评论写一句回复。
//
// said 是对方说的话，who 是他的昵称或者 id，where 是属地。
// nonce 换一个数就换一句，用来实现换一句。
function draftFor(opt) {
  const o = opt || {};
  const said = asText(o.said);
  const who = asText(o.who);
  const where = asText(o.where);
  const nonce = asInt(o.nonce);

  if (Trade.now.key === 'love') {
    return makeReply(said, who + nonce, where);
  }
  const talks = draftTalks();
  if (!talks.length) return '';
  const ranked = rankTalks(talks, said);
  const one = ranked[Math.abs(nonce) % ranked.length];
  // 接上对方那半句原话，这条回复才像是读过他说的话写的。
  // 接不上就只发话术本身，硬拼一句反而更假。
  const echo = echoOf(said);
  return echo ? '看你说' + echo + '，' + one : one;
}

// 可用的话术。勾上的优先，一条都没勾就用这个行业预置的那几条。
function draftTalks() {
  const picked = Trade.pickedTalks();
  if (picked.length) return picked;
  const all = Trade.talks.map((t) => t.text).filter(Boolean);
  return all.length ? all : Trade.now.talks;
}

// 能接上对方原话的排前面。
//
// 判据只有一条：这句话术里出现了对方也提到的那个词。相亲帖里有人说想脱单，
// 底下回一句带脱单的话，比回一句通用寒暄贴切得多。
function rankTalks(talks, said) {
  const s = asText(said).replace(/\s+/g, '');
  if (!s) return talks;
  const words = Trade.now.wantWords || [];
  const hit = [];
  const rest = [];
  for (const t of talks) {
    const touched = words.some((w) => s.includes(w) && t.includes(w));
    (touched ? hit : rest).push(t);
  }
  return hit.concat(rest);
}


// ===== 40-industry.js =====
// 做哪个行业。
//
// 这套东西本来是照找对象写死的：搜什么词、话术怎么生成、什么样的人算有意向，
// 全都埋在代码里。但同一套流程换个行业照样成立，美容搜手拍水光、
// 情感搜挽回前任，做的事情是一样的：找到聊这个话题的帖子，
// 在评论区留话，等人来私信。
//
// 所以把行业相关的东西抽成一份配置。换行业就是换一份配置，不用改代码。
// 内容跟手机版 lib/local/industry.dart 逐条对齐。

const allIndustries = [
  {
    key: 'love',
    name: '找对象',
    about: '在相亲和脱单话题下找想找对象的人',
    keywords: [
      '脱单', '找对象', '相亲', '恋爱', '异地恋', '单身',
      '情感咨询', '挽回', '找男朋友', '女生找对象',
    ],
    talks: [
      '同城的可以聊聊，我这边认识不少靠谱的',
      '看你条件挺好的，我这边有合适的人选',
      '有想认识的可以私信我，帮你介绍',
    ],
    wantWords: [],
  },
  {
    key: 'beauty',
    name: '医美',
    about: '在医美和护肤话题下找想做项目的人',
    keywords: [
      '#手拍水光', '#水光针', '#热玛吉', '#超声炮', '#光子嫩肤',
      '医美避坑', '皮肤管理', '抗衰', '祛痘',
    ],
    talks: [
      '这个项目我做过，有问题可以私信问我',
      '同城的话我可以推荐个靠谱的地方',
      '想了解价格和恢复期的可以找我聊',
    ],
    wantWords: [
      '想做', '求推荐', '哪家', '多少钱', '价格', '效果怎么样',
      '有没有做过', '踩坑', '避雷',
    ],
  },
  {
    key: 'emotion',
    name: '情感咨询',
    about: '在挽回和情感困惑话题下找需要咨询的人',
    keywords: [
      '#挽回前任', '#情感挽回', '分手复合', '冷暴力', '异地恋',
      '婚姻问题', '情感困惑', '前任',
    ],
    talks: [
      '这种情况我遇到过，可以私信聊聊',
      '想聊的可以找我，帮你分析一下',
      '有类似经历，需要的话私信我',
    ],
    wantWords: [
      '怎么办', '求助', '有没有办法', '想挽回', '还有机会吗',
      '求分析', '好难受', '不知道该',
    ],
  },
  {
    key: 'friend',
    name: '交友',
    about: '在同城和兴趣话题下找想认识人的人',
    keywords: [
      '#同城交友', '#找搭子', '找饭搭子', '找旅游搭子', '找运动搭子',
      '扩列', '交个朋友',
    ],
    talks: [
      '同城的可以加个好友，一起玩',
      '我也在找搭子，私信聊聊',
      '有兴趣的私信我，拉你进群',
    ],
    wantWords: [
      '求搭子', '找搭子', '一起', '有没有人', '加我', '扩列',
      '想认识', '同城',
    ],
  },
];

function industryOf(key) {
  return allIndustries.find((i) => i.key === key) || allIndustries[0];
}

// 当前在做哪个行业。判意向和出话术都要看它。
const Trade = {
  now: allIndustries[0],

  async load() {
    Trade.now = industryOf(asText(await getSetting('industry', 'love')));
    await Trade.loadTalks();
    return Trade.now;
  },

  async switchTo(key) {
    Trade.now = industryOf(key);
    await setSetting('industry', Trade.now.key);
    // 话术是按行业各存各的，换过去要重读，不然还用着上一个行业那几条
    await Trade.loadTalks();
    return Trade.now;
  },
};

// ---------- 评论话术 ----------
//
// 话术必须能自己改。同一句话在找对象行业说得通，换到医美就不知所云，
// 而对接人手上有美容、情感、恋爱、交友好几摊生意。
//
// 每条记着勾没勾，发评论时只从勾上的里面随机挑。
// 不想删又不想发的就取消勾选。

function talksKey(industryKey) {
  return 'talks_' + industryKey;
}

Trade.talks = [];

Trade.pickedTalks = function () {
  return Trade.talks.filter((t) => t.on).map((t) => t.text);
};

Trade.loadTalks = async function () {
  const raw = await getSetting(talksKey(Trade.now.key), null);
  if (Array.isArray(raw) && raw.length) {
    Trade.talks = raw.map((e) => ({
      text: asText(isMap(e) ? e.text : e),
      on: isMap(e) ? e.on !== false : true,
    }));
  } else {
    // 第一次进这个行业，把预置的几条铺进去，都默认勾上
    Trade.talks = Trade.now.talks.map((t) => ({ text: t, on: true }));
  }
  return Trade.talks;
};

Trade.saveTalks = async function () {
  await setSetting(talksKey(Trade.now.key), Trade.talks);
};


// ===== 50-funnel.js =====
// 风控漏斗和意向分层。采回来的人不是都该联系的。
//
// 规则跟手机版 lib/local/funnel.dart 逐条对齐：先用黑名单和敏感词剔掉
// 不能碰的，再按意向分高中低三层，低意向直接丢掉不打扰。
// 说过别联系的人永久拉黑，一条都不再发。

// 广告号和同行的特征。这类人不但没价值，回复他们还容易被互相举报。
const kAdWords = [
  '加微信', '加V', '加v', '威信', '薇信', '➕', '私我', '扣我',
  '工作室', '团队', '接单', '代运营', '涨粉', '引流', '推广',
  '业务', '合作', '广告', '刷单', '兼职', '日入', '躺赚', '副业',
  '红娘', '婚介', '介绍所', '相亲平台', '收费', '付费', '会员费',
];

// 敏感和违规的内容。碰到这类一律跳过，连看都不看。
const kBadWords = [
  // 约这个字单独用不能拉黑，约会是正常说法；带这几个尾巴的才是
  '约炮', '约的', '约吗', '约不约', '可约',
  '包养', '援交', '一夜', '开房', '上门', '服务',
  '裸', '色情', '赌', '博彩', '贷款', '网贷', '代还',
  '刷单', '洗钱', '发票', '办证', '枪', '毒',
];

// 明确说了别联系的话。见到就永久拉黑，再也不发。
const kStopWords = [
  '别加我', '别私信', '不要联系', '别联系', '勿扰', '别打扰',
  '举报你', '滚', '骗子', '拉黑你', '别发了',
];

// 在找对象的信号。写得越具体，意向越高。
const kWantWords = [
  '找对象', '脱单', '相亲', '处对象', '找男朋友', '找女朋友',
  '奔着结婚', '认真谈', '想认识', '交往', '恋爱', '单身',
  '想找', '求推荐', '有没有合适',
  '找个伴', '想谈恋爱', '求脱单', '认识一下', '互相了解',
  '处处看', '奔现', '另一半', '征友', '征婚', '诚心找',
  '认真找', '看对眼', '合适的人', '有意向的',
];

// 在找对象的帖子底下应征的短话。
//
// 这些话单看没有找对象三个字，但发在这种帖子底下就是在举手。
// 它们必须整条匹配，不能用包含：可以两个字放进长句里到处都是。
const kShortWants = [
  '举手', '举手🙋', '我', '我可以', '可以', '可以吗', '想认识',
  '有意向', '有兴趣', '合适吗', '看看', '瞅瞅', '康康',
  '加一', '同求', '蹲一个', '蹲', '报名', '来了', '在吗',
  '还在找吗', '还找吗', '联系我', '扣我', '滴我', '冒泡',
];

// 把自己的条件写出来了，说明是认真的。
const kSelfWords = [
  '本人', '身高', '体重', '年薪', '在读', '学历',
  '坐标', '斤', 'cm', '公分',
  // 属这个单字太宽，属于两个字也会命中，换成属相
  '属相', '未婚', '离异', '有房', '有车',
  '公务员', '事业编', '国企', '年生',
  // 工作单用会命中工作不好这种跟相亲无关的话，
  // 所以只认写在自我介绍里的那几种写法
  '有稳定工作', '工作稳定', '刚工作',
];

const INTENT_HIGH = '高意向';
const INTENT_MID = '中等意向';
const INTENT_LOW = '无意向';
const INTENT_RISKY = '广告或同行';

function hasAny(s, words) {
  return words.some((w) => s.includes(w));
}

// 判断一条线索该怎么对待。text 是这个人自己写的话，帖子正文或者评论原文。
function judge(text, allowShort) {
  const s = asText(text).replace(/\s+/g, '');
  if (!s) return INTENT_LOW;

  // 先剔掉碰不得的。这一步在最前面，宁可错杀不可放过。
  if (hasAny(s, kBadWords)) return INTENT_RISKY;
  if (hasAny(s, kAdWords)) return INTENT_RISKY;

  // 短应征只在整条话就是那么一句时才算。
  //
  // 评论区里一个字的我、两个字的举手，发在找对象的帖子底下就是在应征。
  // 但这些词放进长句里到处都是，所以必须整条匹配，
  // 而且限定十个字以内，长了就不是应征而是在讲别的事。
  const bare = s.replace(/[。！!~？?、，,\s]/g, '');
  const short = allowShort !== false && s.length <= 10 &&
    kShortWants.some((w) => s === w || s === w + '。' || s === w + '！' ||
      s === w + '~' || bare === w);

  // 行业自己的应征词也算。找对象那套判据对别的行业太窄：
  // 医美底下的人问的是多少钱、哪家好，情感底下的人问的是怎么办，
  // 拿找对象的词去判，这些人一个都留不下。
  const tradeWords = (Trade.now && Trade.now.wantWords) || [];
  const wants = hasAny(s, kWantWords) || short ||
    (tradeWords.length > 0 && hasAny(s, tradeWords));
  const self = hasAny(s, kSelfWords);

  // 既说了要找对象，又把自己的条件摆出来了，这种人最值得联系
  if (wants && self) return INTENT_HIGH;
  if (wants && s.length >= 15) return INTENT_HIGH;
  if (wants) return INTENT_MID;
  // 光有自我介绍不算。判据只认一条：这个人自己说了要找对象。
  return INTENT_LOW;
}

// 判一个人该不该联系。昵称和留言分开看，取更强的那个。
//
// 不能把昵称和留言拼成一条去判：短应征只在整条话就是那么一句时才算，
// 昵称一拼上去就超过十个字，举手我可以这类应征全部失效。
// 反过来昵称里也不能认短应征，不然叫我的人人人都算在应征。
function judgePerson(nickname, said) {
  const a = judge(said, true);
  // 广告和违规一票否决，昵称干净也救不回来
  if (a === INTENT_RISKY) return a;
  if (a !== INTENT_LOW) return a;
  const b = judge(nickname, false);
  return b === INTENT_LOW ? a : b;
}

// 这个人是不是明确表示过别再联系。
function saidStop(text) {
  return hasAny(asText(text).replace(/\s+/g, ''), kStopWords);
}

// 一批人过一遍漏斗，返回能联系的那些和一份统计。
function runFunnel(all, opt) {
  const o = opt || {};
  const blocked = o.blocked || new Set();
  const keep = [];
  const stat = { all: all.length, risky: 0, low: 0, mid: 0, high: 0, blocked: 0 };

  for (const it of all) {
    if (blocked.has(it.user_id)) {
      stat.blocked += 1;
      continue;
    }
    const r = judgePerson(it.nickname, it.said);
    it.intent = r;
    if (r === INTENT_RISKY) stat.risky += 1;
    else if (r === INTENT_LOW) stat.low += 1;
    else if (r === INTENT_MID) {
      stat.mid += 1;
      if (!o.highOnly) keep.push(it);
    } else {
      stat.high += 1;
      keep.push(it);
    }
  }
  stat.left = stat.high + stat.mid;
  return { keep: keep, stat: stat };
}


// ===== 55-reply.js =====
// 看懂对方想找什么样的人，用红娘的口吻写一句私信。
//
// 这个号是替公司找人的，不是本人相亲，所以话术里不出现自己的条件，
// 只复述对方写明的要求，再说这边有对得上的人。复述得越具体，
// 对方越看得出你真读了帖子，而不是群发。
//
// 逐行照搬手机版 lib/local/reply.dart，两端生成的话一模一样。

// 认得出来的地名。够用就行，认不出来就不写地方，不硬猜。
//
// 排在前面的先匹配，所以省份放在后面，免得四川盖住成都。
const kCities = [
  '北京', '上海', '广州', '深圳', '重庆', '成都', '杭州', '武汉', '西安',
  '南京', '天津', '苏州', '长沙', '郑州', '青岛', '合肥', '福州', '厦门',
  '昆明', '济南', '宁波', '无锡', '大连', '沈阳', '哈尔滨', '长春', '贵阳',
  '南宁', '南昌', '太原', '石家庄', '兰州', '海口', '珠海', '东莞', '佛山',
  '温州', '常州', '徐州', '烟台', '潍坊', '洛阳', '襄阳', '绵阳', '柳州',
  '桂林', '中山', '惠州', '嘉兴', '金华', '台州', '泉州', '保定', '唐山',
  '乌鲁木齐', '呼和浩特', '银川', '西宁', '拉萨',
  '广东', '江苏', '浙江', '山东', '河南', '四川', '湖北', '湖南', '福建',
  '安徽', '河北', '陕西', '江西', '辽宁', '云南', '广西', '山西', '贵州',
  '黑龙江', '吉林', '甘肃', '新疆', '内蒙古', '宁夏', '青海', '西藏', '海南',
];

// 学历从低到高。
function degreeRank(s) {
  if (!s) return -1;
  if (s.includes('博士')) return 3;
  if (s.includes('研究生') || s.includes('硕士')) return 2;
  if (s.includes('本科') || s.includes('学士')) return 1;
  if (s.includes('大专') || s.includes('专科')) return 0;
  return -1;
}

// 从对方写的那段话里读出择偶要求。
function parseWants(text) {
  const empty = {
    height: null, degree: null, bornFrom: null, bornTo: null,
    city: null, noSmoke: false, noDrink: false, musts: [],
  };
  if (!asText(text).trim()) return empty;
  const s = asText(text).replace(/\s+/g, '');

  // 身高。180 加、180 以上、身高 180、178cm 都认，取下限。
  //
  // 帖子里往往有两个身高：自己的和要求对方的。只认带门槛词的写法，
  // 那才是对别人的要求。光写个数字或者身高多少，多半是在说自己，
  // 报回去反而露怯。
  let height = null;
  const heightRes = [
    /(1[5-9][0-9])\s*(?:cm|CM|厘米)?\s*(?:\+|以上|往上|起步|打底)/g,
    /(?:对方|男方|女方)[^。；;]{0,6}?身高[^0-9]{0,4}(1[5-9][0-9])/g,
  ];
  for (const re of heightRes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const v = parseInt(m[1], 10);
      if (!v || v < 150 || v > 199) continue;
      // 前面挨着本人、我这类词的是自述身高，跳过
      const from = Math.max(0, m.index - 8);
      const before = s.slice(from, m.index);
      if (/本人|我[身是的]|自己|小个子|身高小/.test(before)) continue;
      height = v;
      break;
    }
    if (height !== null) break;
  }

  // 学历。写了几档取最高那档当门槛。
  let degree = null;
  for (const d of ['大专', '本科', '研究生', '博士']) {
    if (s.includes(d)) {
      if (degree === null || degreeRank(d) > degreeRank(degree)) degree = d;
    }
  }
  if (s.includes('硕士') && degreeRank(degree || '') < 2) degree = '研究生';

  // 年龄。95 后、00 后这类写法。
  let bornFrom = null;
  let bornTo = null;
  const hou = s.match(/([0-9]{2})后/);
  if (hou) {
    const n = parseInt(hou[1], 10);
    bornFrom = n >= 50 ? 1900 + n : 2000 + n;
    bornTo = bornFrom + 9;
  }

  // 城市。对着地名表认，认不出来就当没写，宁可少说一句也别说错。
  // 光有地名还不够，去过云南旅游里的云南不是要求。
  // 前面得挨着限、坐标、在这类词，才算他划了地方。
  let city = null;
  for (const c of kCities) {
    const i = s.indexOf(c);
    if (i < 0) continue;
    const before = s.slice(Math.max(0, i - 3), i);
    if (/限|仅|只|坐标|常驻|在|求|找/.test(before)) {
      city = c;
      break;
    }
  }

  const musts = [];
  for (const k of ['稳定工作', '体制内', '有房', '有车', '不啃老', '身体健康',
    '上进', '真诚', '无不良嗜好', '顾家', '孝顺', '有责任心', '会做饭']) {
    if (s.includes(k)) musts.push(k);
  }

  return {
    height: height,
    degree: degree,
    bornFrom: bornFrom,
    bornTo: bornTo,
    city: city,
    noSmoke: s.includes('不抽烟') || s.includes('无烟') || s.includes('不吸烟'),
    noDrink: s.includes('不喝酒') || s.includes('不酗酒'),
    musts: musts,
  };
}

function wantsEmpty(w) {
  return w.height === null && w.degree === null && w.bornFrom === null &&
    w.city === null && !w.noSmoke && !w.noDrink && !w.musts.length;
}

// 把读到的要求写成人话，用来放进回复里复述给对方听。
// 最多取三条。全列出来像在念清单，反而不像人说话。
function wantsWords(w) {
  const parts = [];
  if (w.height !== null) parts.push(w.height + '以上');
  if (w.degree !== null) parts.push(w.degree);
  if (w.bornFrom !== null) parts.push(p2(w.bornFrom % 100) + '后');
  if (w.city !== null) parts.push(w.city);
  if (w.noSmoke) parts.push('不抽烟');
  if (w.noDrink) parts.push('不喝酒');
  for (const m of w.musts) parts.push(m);
  return parts.slice(0, 3).join('、');
}

// 对方自己是哪一年的。用来给人选定一个年龄相当的说法。
function theirYear(s) {
  const y = s.match(/(?:^|[^0-9])([0-9]{2})年/);
  if (y) {
    const n = parseInt(y[1], 10);
    return n >= 50 ? 1900 + n : 2000 + n;
  }
  const hou = s.match(/([0-9]{2})后/);
  if (hou) {
    const n = parseInt(hou[1], 10);
    return n >= 50 ? 1900 + n : 2000 + n;
  }
  const age = s.match(/([12][0-9])岁/);
  if (age) return new Date().getFullYear() - parseInt(age[1], 10);
  return null;
}

// 身高往上取一档整数。对方写 175，说 180 比说 176 自然。
function roundUp5(h) {
  return (Math.floor(h / 5) + 1) * 5;
}

// 对方是男是女。红娘要的是男女配对，推荐的人性别得跟对方相反，
// 给一个找女孩的男生推荐男生，是这套东西最丢人的错法。
function theirGender(text) {
  const s = asText(text).replace(/\s+/g, '');
  // 先看本人后面那句，那是最明确的自述
  const self = s.match(/本人[：:]?\s*([男女])/);
  if (self) return self[1];
  if (/我是[男]|男生找|男找女|本人男|00后男|哥哥我/.test(s)) return '男';
  if (/我是[女]|女生找|女找男|本人女|[0-9]{2}年?女|女大学生|微胖女生/.test(s)) return '女';
  // 找什么反推自己是什么
  if (/找男朋友|找个男|想找男|寻男友|要男的|找男孩|男朋友|npy?$/.test(s)) return '女';
  if (/找女朋友|找个女|想找女|寻女友|要女的|找女孩|的女孩|女朋友/.test(s)) return '男';
  return '';
}

// 该按男生还是女生来自我介绍。对方是女的就当男的说，反过来一样。
function meGender(theirs) {
  return theirs === '女' ? '男' : (theirs === '男' ? '女' : '');
}

// 身材那句。男生只报身高，女生报身高加体重。
//
// 这一条一定要有。相亲帖里对方最先看的就是身高，一句话里没有它，
// 剩下的学历工作说得再好也没人接。
//
// 对方划了身高线就压着线往上报一档，没划线报 185。
// 读不出对方性别时按男生走，只报身高，那样两边都不算说错。
function figure(me, want) {
  if (me === '女') return '160，85斤';
  // 封在 190。对方写 195 以上就顺着报 200 的话，一眼就知道是机器。
  const h = want !== null && want >= 185 ? roundUp5(want) : 185;
  return String(h > 190 ? 190 : h);
}

// 从对方那段话里挑一句能接的。有这一句，回复才像看过帖子的人写的。
function hookLine(text) {
  const s = asText(text).replace(/[#＃][^#＃\s]{0,20}/g, ' ');
  for (const line of s.split(/[\n。！!？?，,；;｜|]/)) {
    const t = line.trim();
    if (t.length < 5 || t.length > 16) continue;
    // 对方提要求那半句不能接。接出来是看你说希望对方180以上，
    // 等于把人家的条件复述一遍，像在应聘。只接讲自己想法的那半句。
    if (/对方|男方|女方|要求|以上|起步|不低于|身高|学历|年薪/.test(t)) continue;
    if (/圈子|认识不到|想找|希望|奔着|认真|真诚|试一试|踏实|简单/.test(t)) return t;
  }
  return '';
}

// 能接上对方原话的那半句。回复里带上它，才像读过他说的话写的。
function echoOf(text) {
  return hookLine(text);
}

const kStateWords = ['在实习', '刚工作', '工作稳定', '在上班', '刚毕业'];
const kStudyWords = ['在读考研', '大四准备考研', '研一在读', '还在读书'];
const kAskWords = ['可以联系下吗', '方便联系下吗', '可以认识下吗', '能加个联系方式吗'];

// 从种子里挑一个。
//
// 每处用不同的盐，不然相邻的用户 id 会一起落进同一档，
// 表现就是连着几条话术的措辞一模一样。
function pickBySeed(list, seed, salt) {
  let h = 2166136261;
  const s = salt + '|' + seed;
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ s.charCodeAt(i)) * 16777619) & 0x7fffffff;
  }
  return list[h % list.length];
}

// 按对方的帖子写一句自我介绍，然后问能不能联系。
//
// 第一人称，说的是这个号背后那个人的条件。里面的数字是照对方的
// 要求套出来的，发之前要改成真人的条件。软件只把句子摆得像人话。
function makeReply(theirText, seed, city) {
  const w = parseWants(theirText);
  const s = asText(theirText).replace(/\s+/g, '');
  const year = theirYear(s);
  // 属地要认得出是个中国地名才敢往话里放。
  // 采回来的属地有未知、日本、中国香港这些值，直接拼进去
  // 就成了我未知95年研究生、我日本95年研究生，当场出丑。
  const raw = w.city || asText(city);
  const place = kCities.includes(raw) ? raw : '';
  const student = /在读|大学生|研究生在读|考研/.test(s);
  const ask = pickBySeed(kAskWords, seed || '', '结尾');

  // 身材那一条永远要有。相亲帖里对方最先看的就是身高，没有它，
  // 这条私信跟骚扰没区别。
  const fig = figure(meGender(theirGender(theirText)), w.height);

  // 别的都读不出来，就只报身材加一句问话
  if (wantsEmpty(w) && year === null && !place) return '我' + fig + '，' + ask;

  // 攒自我介绍。有什么说什么，缺的不提，全说满就成参数表了。
  const bits = [];
  let head = '';
  if (place) head += place;
  if (year !== null) head += p2(year % 100) + '年';
  if (student) {
    head += pickBySeed(kStudyWords, seed || '', '在读');
  } else if (w.degree !== null) {
    head += w.degree === '博士' ? '博士' : '研究生';
  }
  if (head) bits.push(head);

  // 不在读的话补一句工作状态
  if (!student && bits.length) bits.push(pickBySeed(kStateWords, seed || '', '状态'));
  bits.push(fig);

  const self = bits.join('，');
  const hook = hookLine(theirText);

  // 句式换着搭。同一个模子套几十条，比说错话还显眼。
  // 每一句都要有主语，不然出来的是 05年还在读书，185，像在说对方。
  const shapes = ['我' + self + '，' + ask];
  if (hook) shapes.push('看你说' + hook + '，我' + self + '，' + ask);
  // 我也某某年的这个开头，后面就不能再带年份，
  // 不然出来的是我也95年的，95年还在读书
  if (year !== null && bits.length > 1) {
    shapes.push('我也' + p2(year % 100) + '年的，' + bits.slice(1).join('，') + '，' + ask);
  }
  shapes.push('我这边' + self + '，' + ask);
  shapes.push('我' + self + '，' + ask);
  return pickBySeed(shapes, seed || '', '句式');
}

// ---------- 判男女 ----------
//
// 红娘要的是男女配对，一屏评论里看不出谁是男谁是女，就得逐条点进主页看。
// 平台的接口不给性别这一项，只能从这个人自己写的话、昵称、
// 以及他在什么帖子底下说话推出来。
//
// 判不出来就不标。标错比不标贵得多：给一个找女孩的男生推荐男生，
// 是这套东西最丢人的错法。

// 猜这个人是男是女。返回男、女，或者空串表示看不出来。
//
// 逐行照着手机版 lib/local/reply.dart 的同名函数写，判据和顺序完全一样，
// 两端对同一个人必须给出同一个结论，不然导出的表摞到一起会自相矛盾。
//
// 宁可不标，不可标错。判据都是明写出来的说法，含糊的一律不认。
//
// [noteText] 是他评论的那篇帖子的正文。帖主自己不要传，
// 传了会拿他自己的帖子去反推，正好推反。
function guessGender(nickname, said, noteText) {
  const byWords = theirGender(said);
  if (byWords) return byWords;

  const s = asText(said).replace(/\s+/g, '');
  // 评论区里常见的短自述。这些说法单独成句时意思很明确。
  if (/^(我)?(是)?男(的|生|滴)?[。！!~]?$/.test(s)) return '男';
  if (/^(我)?(是)?女(的|生|滴)?[。！!~]?$/.test(s)) return '女';
  if (/男嘉宾|男同胞|作为男生|我们男生|哥哥来了/.test(s)) return '男';
  if (/女嘉宾|姐妹们|作为女生|我们女生|妹妹来了|姐妹/.test(s)) return '女';

  const n = asText(nickname).replace(/\s+/g, '');
  // 昵称里的称呼。放在后面，因为它最弱：叫小哥哥的不一定是男的。
  //
  // 昵称在说要找谁的一概不认。想找个哥哥是女生说的话，
  // 按哥字判就判反了，而这种昵称在相亲帖底下并不少见。
  if (n && !/找|求|征|想要/.test(n)) {
    if (/哥$|弟$|先生$|少年|男孩|大叔|老王|小伙/.test(n)) return '男';
    if (/姐$|妹$|女士$|小姐姐|女孩|姑娘|美女|宝妈|仙女/.test(n)) return '女';
  }

  // 最后看他在谁的帖子底下说话。
  //
  // 应征的人跟发帖的人正是要凑成一对的两方，所以帖主是女的，
  // 底下举手的多半是男的。只在这个人确实在应征时才这么推，
  // 路过灌水的不算，那种人性别跟帖主没有关系。
  const post = asText(noteText);
  if (!post) return '';
  const owner = theirGender(post);
  if (!owner) return '';
  const v = judge(said, true);
  if (v !== INTENT_HIGH && v !== INTENT_MID) return '';
  return owner === '女' ? '男' : '女';
}


// ===== 58-csv.js =====
// 导出成 CSV，拿到电脑上用表格软件打开。
//
// 表头和列序跟手机版 lib/local/export.dart 完全一致，三端导出的表能直接摞在一起。

// Excel 认这个字节序标记才不会把中文显示成乱码。
const csvBom = '﻿';

// 换行用 \r\n。Excel 在 Windows 上认这个，只给 \n 会把一行拆成两行。
const csvEol = '\r\n';

function csvCell(v) {
  const s = asText(v);
  // 逗号、引号、换行都要包起来，引号本身再翻一倍
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

function csvText(header, rows) {
  let buf = csvBom + csvRow(header) + csvEol;
  for (const r of rows) buf += csvRow(r) + csvEol;
  return buf;
}

// 表头一律用界面上的说法，导出来的表和面板里看到的能对上号。
// 性别接在最后一列。
//
// 手机版那张表没有这一列，摆在中间会让两边的表摞不齐；
// 挂在末尾的话，前八列还是一一对上的，手机版导出的行只是最后一格空着。
const peopleHeader = ['昵称', '类型', '属地', '说的话', '时间', '点赞', '关键词',
  '笔记标题', '性别'];
const notesHeader = ['标题', '作者', '属地', '正文', '话题标签', '发布时间', '点赞', '评论', '关键词', '笔记链接'];
const commentsHeader = ['昵称', '属地', '说的话', '时间', '点赞', '关键词', '笔记标题'];

function peopleCsv(rows) {
  return csvText(peopleHeader, rows.map((r) => [
    r.nickname, r.kind, r.ip_location, r.said, r.ts, r.likes, r.keyword,
    r.note_title, r.sex,
  ]));
}

function notesCsv(rows) {
  return csvText(notesHeader, rows.map((r) => [
    r.title, r.author_name, r.ip_location, r.content, r.topics,
    r.publish_time, r.likes, r.comment_cnt, r.keyword, r.note_url,
  ]));
}

// 把一段文字存成文件让用户下载。
//
// iPhone 上点了会弹出存到文件或者用别的 app 打开，跟手机版的分享是一个意思。
function download(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}


window.XHS = {
  asText, asInt, asSite, asTrade, head, esc, nowCst, todayCst, tsToStr,
  allIndustries, industryOf, Trade,
  judge, judgePerson, saidStop, runFunnel,
  INTENT_HIGH, INTENT_MID, INTENT_LOW, INTENT_RISKY,
  parseWants, wantsWords, makeReply, theirGender, guessGender, draftFor, echoOf,
  peopleCsv, notesCsv, csvText, download,
};

})();
