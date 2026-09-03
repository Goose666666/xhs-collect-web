// 纯函数的测试。跑法：node test/run.js
//
// 这些用例是从手机版 test/ 下的 Dart 测试搬过来的，断言的值一模一样。
// 两端的解析和话术必须给出同样的结果，不然手机采的和网页采的数据摞不到一起。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const files = ['10-util.js', '20-parse.js', '22-douyin.js',
  '40-industry.js', '45-limits.js', '50-funnel.js', '55-reply.js', '58-csv.js'];

// 这几块不碰浏览器，给个空壳就能跑
const shim = `
const localStore = {};
async function getSetting(k, d) { return k in localStore ? localStore[k] : d; }
async function setSetting(k, v) { localStore[k] = v; }
`;

const code = shim + files
  .map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8'))
  .join('\n');

const ctx = { console: console, module: {}, exports: {} };
vm.createContext(ctx);
vm.runInContext(code + '\nthis.API = { asInt, tsToStr, bucketOf, noteIdInUrl, ' +
  'parseCaptured, parseSearch, parseFeed, parseComments, parseSubComments, ' +
  'parseNoteState, buildNoteUrl, searchUrl, judge, judgePerson, saidStop, ' +
  'runFunnel, INTENT_HIGH, INTENT_MID, INTENT_LOW, INTENT_RISKY, parseWants, ' +
  'wantsWords, makeReply, theirGender, csvText, peopleCsv, Trade, Limits, ' +
  'douyinBucketOf, parseDouyin, videoUrl, douyinSearchUrl, douyinUserUrl, ' +
  'canOpenDouyinProfile, noteFromAweme, kMinGapSeconds, guessGender, stableUrl };', ctx);
const A = ctx.API;

let pass = 0;
let fail = 0;

function eq(got, want, name) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    pass += 1;
  } else {
    fail += 1;
    console.log('  不对 ' + name + '\n    要的是 ' + b + '\n    拿到的 ' + a);
  }
}

function ok(cond, name) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log('  不对 ' + name);
  }
}

function group(name, fn) {
  console.log(name);
  fn();
}

// ---------- 认接口 ----------

group('认接口', () => {
  eq(A.bucketOf('https://edith.xiaohongshu.com/api/sns/web/v1/search/notes'),
    'search', '搜索 v1');
  eq(A.bucketOf('https://edith.xiaohongshu.com/api/sns/web/v2/search/notes'),
    'search', '搜索 v2 也认，版本号不参与匹配');
  eq(A.bucketOf('https://edith.xiaohongshu.com/api/sns/web/v1/homefeed'),
    'homefeed', 'homefeed 要排在 feed 前面');
  eq(A.bucketOf('https://edith.xiaohongshu.com/api/sns/web/v1/feed'), 'feed', '详情');
  eq(A.bucketOf('https://edith.xiaohongshu.com/api/sns/web/v2/comment/page'),
    'comment', '评论');
  eq(A.bucketOf('https://edith.xiaohongshu.com/api/sns/web/v2/comment/sub/page'),
    'sub_comment', '二级评论要排在评论前面');
  eq(A.bucketOf('https://www.xiaohongshu.com/explore'), '', '页面地址不是接口');
  eq(A.bucketOf('https://sns-img.xhscdn.com/p1.webp'), '', '图片不是接口');

  eq(A.noteIdInUrl('https://x.com/api?note_id=abc123&cursor=1'), 'abc123', '取笔记 id');
  eq(A.noteIdInUrl('https://x.com/api?cursor=1'), '', '没有就是空');
});

// ---------- 数字 ----------

group('数字', () => {
  eq(A.asInt('1.2万'), 12000, '万');
  eq(A.asInt('10万+'), 100000, '十万加，不能读成 10');
  eq(A.asInt('1,234'), 1234, '千分位');
  eq(A.asInt('3.5亿'), 350000000, '亿');
  eq(A.asInt(''), 0, '空');
  eq(A.asInt('赞'), 0, '不是数字');
  eq(A.tsToStr(1700000000), '2023-11-15 06:13:20', '秒级时间戳按东八区');
  eq(A.tsToStr(1700000000000), '2023-11-15 06:13:20', '毫秒级一样');
  eq(A.tsToStr('昨天'), '昨天', '已经是文字的原样留着');
});

// ---------- 解析搜索 ----------

const searchBody = JSON.stringify({
  data: {
    has_more: true,
    items: [
      {
        id: 'item1',
        model_type: 'note',
        xsec_token: 'ABtoken1',
        note_card: {
          note_id: '6a8aa62500000000140293d7',
          display_title: '手绘练习第三十天',
          user: { user_id: '5f2c1a90000000000101e1cb', nickname: '画不来' },
          interact_info: { liked_count: '1.2万', comment_count: '246' },
          cover: { url_default: 'https://sns-img.xhscdn.com/cover1.webp' },
        },
      },
      { id: 'rec_1', model_type: 'rec_query', note_card: { note_id: 'x' } },
      {
        id: '6b1100000000000012345678',
        note_card: { interact_info: { liked_count: 300 } },
      },
    ],
  },
});

group('解析搜索', () => {
  const r = A.parseCaptured(
    'https://edith.xiaohongshu.com/api/sns/web/v1/search/notes', searchBody, '手绘');
  eq(r.kind, 'search', '桶名');
  eq(r.hasMore, true, '还有下一页');
  eq(r.notes.length, 2, '搜索建议那一条要剔掉');

  const n = r.notes[0];
  eq(n.note_id, '6a8aa62500000000140293d7', '笔记 id');
  eq(n.title, '手绘练习第三十天', '标题走 display_title');
  eq(n.author_name, '画不来', '作者');
  eq(n.likes, 12000, '1.2万 要读成 12000');
  eq(n.comment_cnt, 246, '评论数');
  eq(n.keyword, '手绘', '关键词跟着存下来');
  eq(n.xsec_token, 'ABtoken1', 'token 从外层取');
  ok(n.note_url.includes('xsec_token=ABtoken1'), '链接带 token');
  ok(!!n.fetched_at, '记了采集时间');

  const n2 = r.notes[1];
  eq(n2.note_id, '6b1100000000000012345678', '没有 note_id 时用外层 id');
  eq(n2.author_name, '', '缺作者留空，不整条丢掉');
  eq(n2.likes, 300, '数字型点赞');
  eq(n2.note_url, 'https://www.xiaohongshu.com/explore/6b1100000000000012345678',
    '没有 token 就只给裸链接');
});

// ---------- 解析详情 ----------

const feedBody = JSON.stringify({
  data: {
    items: [{
      note_card: {
        note_id: 'n1',
        title: '猫',
        desc: '今天画了只猫\n用的是老师推荐的纸 #手绘[话题]#',
        tag_list: [{ name: '手绘' }, { name: '日常练习' }],
        ip_location: '广东',
        time: 1700000000000,
        user: { userId: 'u1', nickName: '画不来' },
        image_list: [{
          url_default: 'https://sns-img.xhscdn.com/p1_small.webp',
          info_list: [
            { image_scene: 'CRD_PRV_WEBP', url: 'https://sns-img.xhscdn.com/p1_prv.webp' },
            { image_scene: 'WB_DFT', url: 'https://sns-img.xhscdn.com/p1_full.webp' },
          ],
        }],
      },
    }],
  },
});

group('解析详情', () => {
  const r = A.parseCaptured(
    'https://edith.xiaohongshu.com/api/sns/web/v1/feed?xsec_token=ABtoken2', feedBody, '');
  eq(r.kind, 'feed', '桶名');
  const n = r.notes[0];
  eq(n.content, '今天画了只猫\n用的是老师推荐的纸 #手绘', '话题的尾巴要去掉');
  eq(n.topics, '手绘 日常练习', '话题');
  eq(n.ip_location, '广东', '属地');
  eq(n.publish_time, '2023-11-15 06:13:20', '发布时间');
  eq(n.author_name, '画不来', '小驼峰的键名也认');
  eq(n.xsec_token, 'ABtoken2', '响应里没有 token 就从地址上取');
  ok(n.note_url.includes('xsec_token=ABtoken2'), '链接带上取到的 token');
  eq(n.cover, 'https://sns-img.xhscdn.com/p1_prv.webp', '图片优先取原图那一档');
});

// ---------- 解析评论 ----------

const commentBody = JSON.stringify({
  data: {
    has_more: false,
    comments: [{
      id: 'c1',
      content: '举手\n我可以',
      like_count: '2',
      sub_comment_count: 1,
      create_time: 1700000000000,
      ip_location: '重庆',
      user_info: { user_id: 'u9', nickname: '小明' },
      sub_comments: [{
        id: 'c2',
        content: '同求',
        user_info: { user_id: 'u10', nickname: '小红' },
      }],
    }],
  },
});

group('解析评论', () => {
  const r = A.parseCaptured(
    'https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=n1',
    commentBody, '');
  eq(r.comments.length, 2, '一级带出内嵌的二级，拍平成一层');
  const c = r.comments[0];
  eq(c.comment_id, 'c1', '评论 id');
  eq(c.note_id, 'n1', '笔记 id 从地址上取');
  eq(c.level, '一级', '层级');
  eq(c.content, '举手 我可以', '换行压成空格');
  eq(c.nickname, '小明', '昵称');
  eq(c.ip_location, '重庆', '属地');
  const s = r.comments[1];
  eq(s.level, '二级', '子评论层级');
  eq(s.parent_id, 'c1', '挂在父评论下');
});

// ---------- 判意向 ----------

group('判意向', () => {
  eq(A.judge('本人95年，身高175，想找个认真谈的对象'), A.INTENT_HIGH, '说要找又报了条件');
  eq(A.judge('想找个对象一起过日子，认真的可以聊'), A.INTENT_HIGH, '说得具体');
  eq(A.judge('想认识'), A.INTENT_MID, '只说想认识');
  eq(A.judge('举手'), A.INTENT_MID, '整条就是一句举手，算应征');
  eq(A.judge('举手了一下没人理我这个帖子好冷清啊'), A.INTENT_LOW,
    '举手放进长句里不算应征');
  eq(A.judge('加微信详聊，工作室接单'), A.INTENT_RISKY, '广告');
  eq(A.judge('可约'), A.INTENT_RISKY, '违规');
  eq(A.judge('劝你先考公，学历高工作稳定才有底气'), A.INTENT_LOW,
    '光有条件词不算，人家在说别的事');
  eq(A.judge('今天天气不错'), A.INTENT_LOW, '无关');
  ok(A.saidStop('别私信我'), '说了别联系');
  ok(!A.saidStop('可以私信我'), '这句不是');

  // 昵称和留言分开看，短应征不能因为昵称长就失效
  eq(A.judgePerson('一只很长很长的昵称写在这里', '举手'), A.INTENT_MID, '昵称不影响短应征');
  eq(A.judgePerson('我', '今天天气不错'), A.INTENT_LOW, '昵称里不认短应征');
  eq(A.judgePerson('干净昵称', '加微信'), A.INTENT_RISKY, '广告一票否决');
});

group('过漏斗', () => {
  const rows = [
    { user_id: 'a', nickname: '甲', said: '本人95年175想找个认真的对象' },
    { user_id: 'b', nickname: '乙', said: '举手' },
    { user_id: 'c', nickname: '丙', said: '加微信' },
    { user_id: 'd', nickname: '丁', said: '今天天气不错' },
    { user_id: 'e', nickname: '戊', said: '想认识' },
  ];
  const r = A.runFunnel(rows, { blocked: new Set(['e']) });
  eq(r.stat.all, 5, '总数');
  eq(r.stat.high, 1, '高意向');
  eq(r.stat.mid, 1, '中等意向');
  eq(r.stat.risky, 1, '广告');
  eq(r.stat.low, 1, '无意向');
  eq(r.stat.blocked, 1, '拉黑的不参与判定');
  eq(r.keep.map((x) => x.user_id), ['a', 'b'], '留下高和中');

  const only = A.runFunnel(rows, { highOnly: true });
  eq(only.keep.map((x) => x.user_id), ['a'], '只要高意向');
});

// ---------- 读懂要求 ----------

group('读懂对方的要求', () => {
  eq(A.parseWants('希望180以上').height, 180, '以上');
  eq(A.parseWants('身高175+').height, 175, '加号');
  eq(A.parseWants('178cm起步').height, 178, '起步');
  eq(A.parseWants('身高不限').height, null, '不限不是数');
  eq(A.parseWants('体重100斤').height, null, '体重不是身高');
  eq(A.parseWants('本人02年，身高小个子156。希望对方身高175以上').height, 175,
    '分得清自述和要求');

  eq(A.parseWants('本科以上').degree, '本科', '本科');
  eq(A.parseWants('硕士学历').degree, '研究生', '硕士算研究生');
  eq(A.parseWants('本科或研究生都行').degree, '研究生', '取最高一档');
  eq(A.parseWants('喜欢看书').degree, null, '没写学历');

  eq(A.parseWants('限重庆本地').city, '重庆', '限某地');
  eq(A.parseWants('坐标成都').city, '成都', '坐标');
  eq(A.parseWants('去过云南旅游').city, null, '路过的地名不是要求');
  eq(A.parseWants('想找同样在读的').city, null, '在读的读不是地名');

  const w = A.parseWants('希望对方待人真诚，无不良嗜好，有稳定工作');
  ok(w.musts.includes('真诚'), '软条件真诚');
  ok(w.musts.includes('稳定工作'), '软条件稳定工作');
});

// ---------- 出话术 ----------

group('出话术', () => {
  const s1 = A.makeReply('05年女生，在读学生，希望对方真诚', 'a');
  ok(s1.includes('05'), '带上对方的年份 ' + s1);
  ok(/考研|在读|读书/.test(s1), '对方在读就说个同样在读的 ' + s1);
  ok(s1.endsWith('吗'), '以问句收尾 ' + s1);

  const s2 = A.makeReply('找个175以上的本科，有稳定工作', 'b');
  ok(s2.includes('研究生'), '对方要本科就说研究生 ' + s2);
  ok(s2.includes('185'), '线在 185 以下就报 185 ' + s2);

  for (const t of ['想找个对象，认真的', '求脱单，坐标成都', '本人95年想找男朋友']) {
    ok(/1[5-9][0-9]/.test(A.makeReply(t, 'h')), '每一条都带身高 ' + t);
  }

  const s3 = A.makeReply('女生找对象，想找个高一点的', 'm');
  ok(!s3.includes('斤'), '对方是女生我们就按男生说，不报体重 ' + s3);

  const s4 = A.makeReply('随缘', 'z');
  ok(/1[5-9][0-9]/.test(s4), '什么都读不出来也要报身高 ' + s4);
  ok(s4.length < 20, '这种情况话要短 ' + s4);

  // 同一个人两次生成必须一样，不然复制两次得到两条不同的话
  eq(A.makeReply('想找个对象', 'user1'), A.makeReply('想找个对象', 'user1'), '同种子同结果');

  eq(A.theirGender('本人男，找女朋友'), '男', '自述男');
  eq(A.theirGender('想找男朋友'), '女', '找男的反推自己是女的');
});

// ---------- 导出 ----------

group('导出表格', () => {
  const text = A.csvText(['甲', '乙'], [['带,逗号', '带"引号']]);
  ok(text.charCodeAt(0) === 0xfeff, '开头有字节序标记，Excel 才不乱码');
  ok(text.includes('"带,逗号"'), '逗号要包起来');
  ok(text.includes('"带""引号"'), '引号要翻倍');
  ok(text.includes('\r\n'), '换行是 CRLF');

  const csv = A.peopleCsv([{
    nickname: '小明', kind: '评论者', ip_location: '重庆', said: '举手',
    ts: '2026-01-01 10:00:00', likes: 3, keyword: '脱单', note_title: '找对象',
  }]);
  ok(csv.includes('昵称,类型,属地,说的话,时间,点赞,关键词,笔记标题'), '表头跟手机版一致');
  ok(csv.includes('小明,评论者,重庆,举手'), '数据行');
});

// ---------- 判男女 ----------

group('判男女', () => {
  eq(A.guessGender('小明', '我是男生，想找女朋友', ''), '男', '自己说了是男的');
  eq(A.guessGender('小红', '想找男朋友', ''), '女', '找男朋友反推是女的');
  eq(A.guessGender('小仙女本仙', '举手', ''), '女', '昵称里的女性信号');
  eq(A.guessGender('隔壁帅哥', '举手', ''), '男', '昵称里的男性信号');
  eq(A.guessGender('无名氏', '今天天气不错', ''), '', '看不出来就不标');

  // 应征的人跟帖主是相反的性别，这是第三档依据
  eq(A.guessGender('无名氏', '举手', '本人98年女，想找个认真谈的对象'), '男',
    '女生的找对象帖底下举手的按男的算');
  eq(A.guessGender('无名氏', '举手', '本人男，想找个女朋友'), '女',
    '反过来一样');
  eq(A.guessGender('无名氏', '这帖子写得真好', '本人98年女，想找对象'), '',
    '路过灌水的不算应征，不能拿帖主去反推');
  eq(A.guessGender('无名氏', '举手', '今天去爬山了'), '',
    '帖主自己都看不出男女就别推了');

  // 昵称里带找求征的一概不认，想找个哥哥是女生说的话
  eq(A.guessGender('想找个哥哥', '在吗', ''), '', '昵称在说要找谁，不是在说自己');
  eq(A.guessGender('哥哥和姐姐', '在吗', ''), '', '两边都命中就不猜');

  // 帖主自己那条不能拿他自己的帖子当上下文，会正好推反
  eq(A.guessGender('小鱼', '本人98年女，想找个认真谈的对象', ''), '女',
    '帖主从自己写的话里判');
});

// ---------- 图片地址 ----------

group('图片地址', () => {
  const signed = 'http://sns-webpic-qc.xhscdn.com/202609031030/' +
    '3f2a1b4c5d6e7f8091a2b3c4d5e6f708/notes_pre_post/1040g0083!nd_dft_wlteh_webp_3';
  const fixed = A.stableUrl(signed);
  ok(fixed.includes('sns-img-qc.xhscdn.com'), '换成不过期那个域名 ' + fixed);
  ok(!fixed.includes('202609031030'), '时间那一段要去掉');
  ok(!fixed.includes('3f2a1b4c'), '哈希那一段要去掉');
  ok(fixed.includes('notes_pre_post/1040g0083'), '图片号留着');
  ok(!fixed.includes('!nd_dft'), '感叹号后面的处理参数去掉');
  ok(fixed.includes('w/540'), '默认要 540 宽的压缩版');
  ok(A.stableUrl(signed, 200).includes('w/200'), '宽度能指定');

  const dy = 'https://p3-pc-sign.douyinpic.com/abc~tplv-dy.jpeg';
  eq(A.stableUrl(dy), dy, '抖音的地址不是这个规则，原样返回');
  eq(A.stableUrl(''), '', '空的原样返回');
  eq(A.stableUrl('不是个地址'), '不是个地址', '认不出来就别瞎改');
});

// ---------- 抖音 ----------

group('认抖音的接口', () => {
  eq(A.douyinBucketOf('https://www.douyin.com/aweme/v1/web/general/search/single/?x=1'),
    'search', '综合搜索');
  eq(A.douyinBucketOf('https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=7'),
    'comment', '评论');
  eq(A.douyinBucketOf('https://www.douyin.com/aweme/v1/web/comment/list/reply/?x=1'),
    'sub_comment', '二级评论要排在评论前面');
  eq(A.douyinBucketOf('https://www.douyin.com/aweme/v1/web/aweme/detail/?x=1'),
    'feed', '详情');
  eq(A.douyinBucketOf('https://edith.xiaohongshu.com/api/sns/web/v1/feed'), '',
    '小红书的接口不归它管');
  eq(A.douyinBucketOf('https://www.douyin.com/video/123'), '', '页面地址不是接口');

  eq(A.videoUrl('7123'), 'https://www.douyin.com/video/7123', '作品地址');
  ok(A.douyinSearchUrl('找对象').includes('%'), '关键词要转义');
  eq(A.douyinUserUrl('MS4wLjABAAAA'), 'https://www.douyin.com/user/MS4wLjABAAAA', '主页');
  ok(A.canOpenDouyinProfile('MS4wLjABAAAA'), 'sec_uid 开得了');
  ok(!A.canOpenDouyinProfile('1234567890'), '纯数字的 uid 开不了，会被重定向');
});

const dySearch = JSON.stringify({
  has_more: 1,
  data: [
    {
      aweme_info: {
        aweme_id: '7311',
        desc: '本人98年，坐标重庆，想找个认真谈的对象 #脱单 #相亲',
        create_time: 1754006400,
        author: { sec_uid: 'MS4wAAA', nickname: '小鱼', ip_location: 'IP属地:重庆' },
        statistics: { digg_count: 12000, comment_count: 24 },
        text_extra: [{ hashtag_name: '脱单' }, { hashtag_name: '相亲' }],
        video: { origin_cover: { url_list: ['https://x/c.jpg'] } },
      },
    },
    { user_info: { uid: '1' } },
  ],
});

group('解析抖音搜索', () => {
  const r = A.parseDouyin(
    'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=x',
    dySearch, '脱单');
  eq(r.kind, 'search', '桶名');
  eq(r.hasMore, true, 'has_more 是 1 就是还有');
  eq(r.notes.length, 1, '用户卡要剔掉，只留作品');
  const n = r.notes[0];
  eq(n.note_id, '7311', '作品 id');
  // 抖音没有标题，取正文第一句。断句只认句号感叹号问号，逗号不算，
  // 所以这条没有句号的正文整条就是标题
  eq(n.title, '本人98年，坐标重庆，想找个认真谈的对象 #脱单 #相亲',
    '没有句号就整条当标题');
  eq(A.noteFromAweme({ aweme_id: '1', desc: '第一句。第二句也很长' }, '').title,
    '第一句', '有句号就只取第一句');
  eq(n.author_id, 'MS4wAAA', '作者用 sec_uid，不用数字 uid');
  eq(n.author_name, '小鱼', '作者昵称');
  eq(n.likes, 12000, '点赞');
  eq(n.ip_location, '重庆', 'IP属地那个前缀要去掉');
  eq(n.topics, '#脱单 #相亲', '话题');
  eq(n.publish_time, '2025-08-01 08:00:00', '秒级时间戳');
  eq(n.note_url, 'https://www.douyin.com/video/7311', '作品地址');
  eq(n.xsec_token, '', '抖音不用 token');
  eq(n.site, '抖音', '平台在解析这一步就定死');
});

const dyComments = JSON.stringify({
  has_more: 0,
  comments: [
    {
      cid: 'c1', text: '举手', digg_count: 3, create_time: 1754006400,
      ip_label: 'IP属地:成都', reply_id: '0',
      user: { sec_uid: 'MS4wBBB', nickname: '小明' },
    },
    {
      cid: 'c2', text: '同求', reply_id: 'c1', reply_to_reply_id: '0',
      user: { sec_uid: 'MS4wCCC', nickname: '小红' },
    },
  ],
});

group('解析抖音评论', () => {
  const r = A.parseDouyin(
    'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=7311', dyComments, '');
  eq(r.comments.length, 2, '两条');
  const c = r.comments[0];
  eq(c.comment_id, 'c1', '评论 id');
  eq(c.note_id, '7311', '作品 id 从地址上取');
  eq(c.level, '一级', 'reply_id 是 0 就是一级');
  eq(c.ip_location, '成都', '属地');
  eq(c.user_id, 'MS4wBBB', '只认 sec_uid');
  eq(r.comments[1].level, '二级', '挂在别人下面的是二级');
  eq(r.comments[1].parent_id, 'c1', '父评论');
});

// ---------- 发送节奏 ----------

group('这一批怎么排', () => {
  const gaps = A.Limits.plan(10, 20);
  eq(gaps.length, 9, '十个人排九个间隔');
  eq(gaps.reduce((a, b) => a + b, 0), 20 * 60, '加起来正好是设定的总时长');
  ok(gaps.every((g) => g >= A.kMinGapSeconds), '每段都不短于最小间隔');
  ok(new Set(gaps).size > 3, '长短要参差不齐，全一样就是机器 ' + gaps.join(','));

  eq(A.Limits.plan(1, 20), [], '只有一个人不用等');
  const tight = A.Limits.plan(60, 5);
  ok(tight.every((g) => g === A.kMinGapSeconds),
    '时间不够垫最小间隔就全按最小间隔，宁可超时也不连发');

  A.Limits.batchSize = 20;
  A.Limits.batchMinutes = 20;
  ok(!A.Limits.tooFast(), '二十分钟发二十个是正常节奏');
  A.Limits.batchMinutes = 5;
  ok(A.Limits.tooFast(), '五分钟发二十个太快了要提醒');
  A.Limits.batchMinutes = 20;
});

console.log('');
console.log(fail === 0 ? '全过了，' + pass + ' 项' : pass + ' 项过，' + fail + ' 项没过');
process.exit(fail === 0 ? 0 : 1);
