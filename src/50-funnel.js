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
