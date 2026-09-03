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
