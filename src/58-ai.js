// 让模型筛人和写话术。跟安卓版是同一套口径。
//
// 靠关键词的规则在抖音评论区里认不出人，会把看热闹的和聊剧情的
// 一律判成没意向，私信一个都挑不出来。模型按帖子的关键词去判，
// 跟主题不沾边的一律算低。
//
// 密钥在设置里填，没填或者请求失败就退回规则那套，界面上不用等。

const AI = {
  key: '',

  async load() {
    AI.key = asText(await getSetting('ai_key', ''));
  },

  async save(raw) {
    AI.key = AI.pick(raw);
    await setSetting('ai_key', AI.key);
  },

  // 从框里那串字里挑出密钥本身。
  //
  // 手机上粘贴和输入法都会带进多余的字：前面留着旧的一截，后面跟着回车。
  // 只认最后一段长得像密钥的，DeepSeek 是 sk- 加三十二位十六进制，
  // 智谱是两段字符中间一个点。
  pick(raw) {
    const s = asText(raw);
    const ds = s.match(/sk-[0-9a-fA-F]{32}/g);
    if (ds && ds.length) return ds[ds.length - 1];
    const glm = s.match(/[0-9a-fA-F]{32}\.[0-9A-Za-z]{16,}/g);
    if (glm && glm.length) return glm[glm.length - 1];
    return s.trim();
  },

  // 密钥长什么样就走哪家。DeepSeek 的以 sk- 开头，智谱的中间带一个点。
  endpoint() {
    if (AI.key.indexOf('.') >= 0 && AI.key.indexOf('sk-') !== 0) {
      return {
        url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        model: 'glm-4-flash',
      };
    }
    return {
      url: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
    };
  },

  // 问模型一句，拿回整段文字。出错、超时、没密钥都给空串。
  async ask(content, maxTokens, temp) {
    if (!AI.key) return '';
    const at = AI.endpoint();
    try {
      const r = await fetch(at.url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + AI.key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: at.model,
          temperature: temp === undefined ? 0.9 : temp,
          max_tokens: maxTokens || 120,
          messages: [{ role: 'user', content }],
        }),
      });
      if (!r.ok) return '';
      const j = await r.json();
      const list = j && j.choices;
      if (!list || !list.length) return '';
      return asText(list[0].message && list[0].message.content).trim();
    } catch (e) {
      return '';
    }
  },

  // 判一批人有没有找对象的意向。每一项回高、中、低，判不了的回空串。
  //
  // 一次送二十条，让模型按序号回，省请求也省钱。
  judgePrompt(lines, keyword) {
    const topic = keyword ? '「' + keyword + '」' : '找对象、相亲';
    const head = [
      '下面是按' + topic + '这个主题搜到的帖子评论区里的留言，一行一条，前面是序号。',
      '判断每一条留言的人本人是不是真的在' + topic + '这件事上有需求：',
      '高：明确在找对象、征婚、报了自己条件或择偶要求，跟' + topic + '直接相关；',
      '中：提到自己单身、想脱单、问怎么认识人这类，但没明说要什么；',
      '低：看热闹、评论别人、开玩笑、聊剧情、广告、跟' + topic + '无关。',
      '宁可判低，不确定的一律判低。',
      '只按序号逐行输出，格式是 序号:高 或 序号:中 或 序号:低，不要别的字。',
      '',
    ];
    const body = lines.map((s, i) =>
      (i + 1) + ':' + asText(s).replace(/\n/g, ' ').trim());
    return head.concat(body).join('\n');
  },

  async judgeMany(lines, keyword) {
    const out = lines.map(() => '');
    if (!AI.key || !lines.length) return out;
    for (let i = 0; i < lines.length; i += 20) {
      const part = lines.slice(i, i + 20);
      const text = await AI.ask(AI.judgePrompt(part, keyword), 400, 0.1);
      const re = /(\d+)\s*[:：]\s*(高|中|低)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const k = Number(m[1]) - 1;
        if (k >= 0 && k < part.length) out[i + k] = m[2];
      }
    }
    return out;
  },

  // 给模型的话。规则写死在这儿，跟 55-reply.js 那套口径一致。
  draftPrompt(said, theirSex, where) {
    const me = theirSex === '女' ? '男' : (theirSex === '男' ? '女' : '');
    const sexLine = me
      ? '对方是' + theirSex + '的，你写成一个' + me + '的。'
      : '先从这句话判断对方是男是女，你写成异性。';
    const place = where ? '（对方在' + where + '，就说自己也在那一带）' : '';
    return '你替一个单身的人在相亲帖子的评论区回话。' + sexLine +
      '用第一人称，像真人随手打的一两句话，不超过四十个字，' +
      '口语，标点少，不要排比，不要每样条件都报，报两三样就够。' +
      '直接接对方那句话里的意思往下说，不要用看你提到、看到你说这种套话开头。' +
      '条件里挑对方在意的报：年龄或出生年份、身高、做什么工作、在哪座城市' +
      place + '、有房有车。男的身高只能在180到188之间挑一个数，' +
      '女的在160到168之间；条件要合理，别夸张，别像在填表，也别像客服。' +
      '最后顺口问一句能不能认识。' +
      '不要出现微信、电话、联系方式、加我这些词，不要表情符号，不要引号，' +
      '只输出那句话本身。\n\n对方说：' + asText(said);
  },

  // 模型偶尔会带引号或者多说一句，只留第一段话。
  clean(s) {
    let t = asText(s).replace(/^["“「\s]+|["”」\s]+$/g, '');
    const nl = t.indexOf('\n');
    if (nl > 0) t = t.slice(0, nl).trim();
    return t.length > 80 ? t.slice(0, 80) : t;
  },

  // 采到一篇就判一篇：帖子本身加底下的评论，结果写回库里那几行。
  //
  // 判不出来的留空，人页照旧用规则那套兜底。判这一步失败不影响采集。
  async judgeAndStore(comments, note) {
    if (!AI.key) return;
    try {
      const lines = [asText(note.title) + ' ' + asText(note.content)]
        .concat(comments.map((c) => asText(c.content)));
      const got = await AI.judgeMany(lines, asText(note.keyword));
      const rows = [];
      for (let i = 0; i < comments.length; i++) {
        const level = got[i + 1];
        if (!level) continue;
        rows.push(Object.assign({}, comments[i], { intent_ai: level }));
      }
      if (rows.length) await putMany('comments', rows);
      if (got[0]) {
        const one = await getOne('notes', note.note_id);
        if (one) {
          await putMany('notes',
            [Object.assign({}, one, { intent_ai: got[0] })]);
        }
      }
    } catch (e) {
      // 判不了就算了，采集本身不受影响
    }
  },

  // 写一句。没密钥、超时、出错都返回空串，调用方自己退回规则。
  async write(said, theirSex, where) {
    if (!AI.key || !asText(said).trim()) return '';
    return AI.clean(await AI.ask(AI.draftPrompt(said, theirSex, where)));
  },
};
