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

// 昵称里的女性信号。长的排在前面，先匹配到哪个算哪个。
const kSheWords = [
  '小姐姐', '小仙女', '仙女', '美女', '姑娘', '女孩', '女生', '女神',
  '宝妈', '辣妈', '公主', '丫头', '妹子', 'girl',
  '姐', '妹', '妞', '媛', '婷', '娜', '娟', '妍', '婉', '琳',
];

const kHeWords = [
  '小哥哥', '帅哥', '汉子', '男孩', '男生', '少年', '兄弟', '大叔', '先生',
  'boy', '哥', '弟', '爷', '叔',
];

// 从昵称里认。
//
// 昵称里带找求征这类字的一概不认。想找个哥哥是个女生说的话，
// 按哥字判就判反了，而这种昵称在相亲帖底下并不少见。
function fromName(nickname) {
  const s = asText(nickname).replace(/\s+/g, '');
  if (!s) return '';
  if (/找|求|征|想要/.test(s)) return '';
  const she = kSheWords.find((w) => s.includes(w));
  const he = kHeWords.find((w) => s.includes(w));
  // 两边都命中就不猜了，比如带姐又带哥的昵称
  if (she && he) return '';
  if (she) return '女';
  if (he) return '男';
  return '';
}

// 从他在谁的帖子底下说话推。
//
// 应征的人跟发帖的人正是要凑成一对的两方，所以帖主是女的，
// 底下举手的多半是男的。只在这个人确实在应征时才这么推，
// 路过灌水的不算，那种人性别跟帖主没有关系。
function fromNote(noteText, said) {
  const owner = theirGender(noteText);
  if (!owner) return '';
  const v = judge(said, true);
  if (v !== INTENT_HIGH && v !== INTENT_MID) return '';
  return owner === '女' ? '男' : '女';
}

// 猜这个人是男是女。返回男、女，或者空串表示看不出来。
//
// [noteText] 是他评论的那篇帖子的正文。帖主自己不要传，
// 传了会拿他自己的帖子去反推，正好推反。
function guessGender(nickname, said, noteText) {
  // 自己说的话最可靠，包括我是男这种自述和找男朋友这种反推
  const a = theirGender(said);
  if (a) return a;
  const b = theirGender(nickname);
  if (b) return b;
  const c = fromName(nickname);
  if (c) return c;
  return fromNote(asText(noteText), said);
}
