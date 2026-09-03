// 本地库。存在浏览器的 IndexedDB 里，不上传任何地方。
//
// 表名和列名照抄手机版 lib/local/db.dart，所以导出来的文件跟手机版、
// 电脑版是同一套字段，三边的数据能直接合并。
//
// 数据量就是几千条，读全表再在内存里筛完全够用，不做索引查询，
// 省下一大堆游标代码，出错的地方也少。

const DB_NAME = 'xhs_leads';
const DB_VERSION = 1;

// 一行数据存在哪张表，以及主键是哪一列。
const STORES = {
  notes: 'note_id',
  comments: 'comment_id',
  keywords: 'id',
  settings: 'k',
  tasks: 'id',
  touches: 'id',
  job: 'id',
};

let _db = null;

// 拿连接。多处同时调用只会真正打开一次。
function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const [name, key] of Object.entries(STORES)) {
        if (d.objectStoreNames.contains(name)) continue;
        // 任务和触达没有天然主键，让库自己发号
        if (name === 'tasks' || name === 'touches') {
          d.createObjectStore(name, { keyPath: key, autoIncrement: true });
        } else {
          d.createObjectStore(name, { keyPath: key });
        }
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return openDb().then((d) => d.transaction(store, mode).objectStore(store));
}

function req2promise(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function getAll(store) {
  const s = await tx(store, 'readonly');
  return (await req2promise(s.getAll())) || [];
}

async function getOne(store, key) {
  const s = await tx(store, 'readonly');
  return await req2promise(s.get(key));
}

async function putOne(store, row) {
  const s = await tx(store, 'readwrite');
  return await req2promise(s.put(row));
}

// 一批一起写。一条一条提交，几百条评论在手机上慢到肉眼可见。
async function putMany(store, rows) {
  if (!rows.length) return 0;
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const r of rows) s.put(r);
    t.oncomplete = () => resolve(rows.length);
    t.onerror = () => reject(t.error);
  });
}

async function clearStore(store) {
  const s = await tx(store, 'readwrite');
  return await req2promise(s.clear());
}

// ---------- 设置 ----------

async function getSetting(k, dflt) {
  const row = await getOne('settings', k);
  if (!row || row.v === undefined || row.v === null) return dflt;
  return row.v;
}

async function setSetting(k, v) {
  return putOne('settings', { k: k, v: v });
}

// ---------- 笔记和评论 ----------

// 存笔记，返回真正新增的条数。
//
// 已经有的会被覆盖，因为详情比搜索摘要字段全，重采一次是在补全，不是在重复。
// 但计数只算新的，不然界面上的笔记数会随着重采一直涨。
async function saveNotes(rows, keyword, site, trade) {
  if (!rows.length) return 0;
  const s = await tx('notes', 'readonly');
  const have = new Set((await req2promise(s.getAllKeys())) || []);
  const out = [];
  let fresh = 0;
  for (const r of rows) {
    if (!r || !r.note_id) continue;
    const row = Object.assign({}, r);
    if (keyword) row.keyword = keyword;
    row.site = asSite(site || row.site);
    row.trade = asTrade(trade || row.trade);
    if (!have.has(row.note_id)) fresh += 1;
    out.push(row);
  }
  await putMany('notes', out);
  return fresh;
}

// 存评论，返回真正新增的条数。界面上说的新评论就是这个数。
async function saveComments(rows, site, trade) {
  if (!rows.length) return 0;
  const s = await tx('comments', 'readonly');
  const have = new Set((await req2promise(s.getAllKeys())) || []);
  const out = [];
  let fresh = 0;
  for (const r of rows) {
    if (!r || !r.comment_id) continue;
    const row = Object.assign({}, r);
    row.site = asSite(site || row.site);
    row.trade = asTrade(trade || row.trade);
    if (!have.has(row.comment_id)) fresh += 1;
    out.push(row);
  }
  await putMany('comments', out);
  return fresh;
}

// ---------- 关键词 ----------

function keywordId(word, trade) {
  return asText(word) + '|' + asTrade(trade);
}

async function listKeywords(trade) {
  const all = await getAll('keywords');
  const t = asTrade(trade);
  return all.filter((r) => asTrade(r.trade) === t);
}

async function saveKeyword(word, trade, enabled) {
  const w = asText(word).trim();
  if (!w) return;
  const id = keywordId(w, trade);
  const old = await getOne('keywords', id);
  await putOne('keywords', {
    id: id,
    word: w,
    trade: asTrade(trade),
    enabled: enabled === false ? 0 : 1,
    last_run: old ? old.last_run || '' : '',
  });
}

async function removeKeyword(word, trade) {
  const s = await tx('keywords', 'readwrite');
  return await req2promise(s.delete(keywordId(word, trade)));
}

async function markKeywordRun(word, trade) {
  const id = keywordId(word, trade);
  const old = await getOne('keywords', id);
  if (!old) return;
  old.last_run = nowCst();
  await putOne('keywords', old);
}

// ---------- 人 ----------

// 帖主和评论者拼成一张名单，用 kind 区分两类。
//
// 自述各取各的：帖主是标题加正文，评论者是留言原文。
// 属地也各取各的，帖主用笔记的属地，评论者用自己那条评论的属地。
async function listPeople(filter) {
  const f = filter || {};
  const notes = await getAll('notes');
  const comments = await getAll('comments');
  const byId = {};
  for (const n of notes) byId[n.note_id] = n;

  const out = [];
  for (const n of notes) {
    if (!n.author_id) continue;
    const title = asText(n.title);
    const content = asText(n.content);
    // 抖音的标题就是正文第一行，直接拼会把开头念两遍。
    // 正文已经以标题打头的话，只留正文。
    const said = content && title && content.indexOf(title) === 0
      ? content
      : (title + ' ' + content).trim();
    out.push({
      kind: '帖主',
      user_id: n.author_id,
      nickname: n.author_name,
      ip_location: n.ip_location,
      said: said,
      // 帖主不传帖子正文当上下文。那正是他自己写的话，
      // 拿它去反推等于拿自己推自己，推出来的性别正好是反的。
      sex: guessGender(n.author_name, said, ''),
      ts: n.publish_time,
      likes: asInt(n.likes),
      note_id: n.note_id,
      xsec_token: n.xsec_token,
      note_title: title,
      note_url: n.note_url,
      keyword: n.keyword,
      comment_id: '',
      site: asSite(n.site),
      trade: asTrade(n.trade),
    });
  }
  for (const c of comments) {
    if (!c.user_id) continue;
    const n = byId[c.note_id] || {};
    // 他在谁的帖子底下说话，这是判男女的第三档依据
    const noteText = (asText(n.title) + ' ' + asText(n.content)).trim();
    out.push({
      kind: '评论者',
      user_id: c.user_id,
      nickname: c.nickname,
      ip_location: c.ip_location,
      said: asText(c.content),
      sex: guessGender(c.nickname, c.content, noteText),
      ts: c.comment_time,
      likes: asInt(c.likes),
      note_id: c.note_id,
      xsec_token: n.xsec_token || '',
      note_title: asText(n.title),
      note_url: n.note_url || '',
      keyword: asText(n.keyword),
      comment_id: c.comment_id,
      site: asSite(c.site),
      trade: asTrade(c.trade),
    });
  }
  return filterPeople(out, f);
}

function filterPeople(rows, f) {
  let out = rows;
  if (f.kind) out = out.filter((r) => r.kind === f.kind);
  if (f.site) out = out.filter((r) => r.site === f.site);
  if (f.trade) out = out.filter((r) => r.trade === f.trade);
  if (f.city) out = out.filter((r) => r.ip_location === f.city);
  if (f.keyword) out = out.filter((r) => r.keyword === f.keyword);
  if (f.search) {
    const q = f.search;
    out = out.filter((r) => r.said.includes(q) || asText(r.nickname).includes(q));
  }
  const order = f.order || 'likes';
  const cmp = {
    likes: (a, b) => b.likes - a.likes,
    time: (a, b) => asText(b.ts).localeCompare(asText(a.ts)),
    long: (a, b) => b.said.length - a.said.length,
  }[order] || ((a, b) => b.likes - a.likes);
  return out.slice().sort(cmp);
}

// ---------- 发过谁 ----------

async function addTouch(row) {
  const r = Object.assign({ created_at: nowCst() }, row);
  delete r.id;
  return putOne('touches', r);
}

async function listTouches() {
  const all = await getAll('touches');
  return all.sort((a, b) => asText(b.created_at).localeCompare(asText(a.created_at)));
}

// 拉黑过的人。发私信前要跳过他们。
async function blockedIds() {
  const all = await getAll('touches');
  const out = new Set();
  for (const t of all) {
    if (t.kind === '拉黑' && t.user_id) out.add(t.user_id);
  }
  return out;
}

// ---------- 任务 ----------

async function newTask(kind, keyword, params) {
  const s = await tx('tasks', 'readwrite');
  return await req2promise(s.add({
    kind: kind,
    keyword: keyword,
    params: JSON.stringify(params || {}),
    status: '运行中',
    note_cnt: 0,
    comment_cnt: 0,
    log: '',
    created_at: nowCst(),
    finished_at: '',
  }));
}

async function finishTask(id, status, noteCnt, commentCnt) {
  if (!id) return;
  const row = await getOne('tasks', id);
  if (!row) return;
  row.status = status;
  if (noteCnt !== undefined && noteCnt !== null) row.note_cnt = noteCnt;
  if (commentCnt !== undefined && commentCnt !== null) row.comment_cnt = commentCnt;
  if (status !== '运行中') row.finished_at = nowCst();
  await putOne('tasks', row);
}

// ---------- 采集状态 ----------
//
// 网页版跟手机版最大的不同在这儿。手机版的采集跑在一个不会消失的对象里，
// 网页版每打开一篇笔记就是一次真正的页面跳转，脚本会被整个重新加载，
// 内存里的东西全没。所以每走一步都要把进度写回库里，
// 下一个页面起来之后再读回去接着跑。

const JOB_KEY = 'job';

async function getJob() {
  return await getOne('job', JOB_KEY);
}

async function setJob(job) {
  const row = Object.assign({}, job, { id: JOB_KEY });
  await putOne('job', row);
  return row;
}

async function clearJob() {
  const s = await tx('job', 'readwrite');
  return await req2promise(s.delete(JOB_KEY));
}

// ---------- 导出和清空 ----------

// 整库导出成一份 JSON。拿去电脑上看，或者换台设备接着用。
async function exportAll() {
  const out = { version: 1, exported_at: nowCst(), tables: {} };
  for (const name of ['notes', 'comments', 'keywords', 'settings', 'tasks', 'touches']) {
    out.tables[name] = await getAll(name);
  }
  return out;
}

// 导入一份 JSON。同主键的覆盖，别的留着，所以两台设备的数据能合到一起。
async function importAll(data) {
  const tables = mapOf(mapOf(data).tables);
  let n = 0;
  for (const name of ['notes', 'comments', 'keywords', 'settings', 'tasks', 'touches']) {
    const rows = listOf(tables[name]);
    if (!rows.length) continue;
    // 自增主键的表，导进来的 id 可能跟本地撞车，去掉让库重新发号
    const clean = (name === 'tasks' || name === 'touches')
      ? rows.map((r) => {
        const c = Object.assign({}, r);
        delete c.id;
        return c;
      })
      : rows;
    if (name === 'tasks' || name === 'touches') {
      const d = await openDb();
      await new Promise((resolve, reject) => {
        const t = d.transaction(name, 'readwrite');
        const s = t.objectStore(name);
        for (const r of clean) s.add(r);
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    } else {
      await putMany(name, clean);
    }
    n += clean.length;
  }
  return n;
}

// 清数据。只清采到的东西，设置和关键词留着。
async function clearData() {
  await clearStore('notes');
  await clearStore('comments');
  await clearStore('tasks');
}

async function counts() {
  const notes = await getAll('notes');
  const comments = await getAll('comments');
  return { notes: notes.length, comments: comments.length };
}

// ---------- 触达流水 ----------
//
// 发出去的每一条都要留痕：发给谁、发的什么、成没成、当时页面回了什么。
// 不记的话一天几条额度烧完了都不知道烧在哪。

async function touches(limit) {
  const all = await getAll('touches');
  all.sort((a, b) => asInt(b.id) - asInt(a.id));
  return limit ? all.slice(0, limit) : all;
}

// 拉黑一个人，以后一条都不再发给他。
async function blockUser(userId, nickname, why) {
  if (!userId) return;
  await addTouch({
    kind: '拉黑',
    user_id: userId,
    nickname: nickname || '',
    text: why || '手动拉黑',
    status: '成功',
  });
}

// 上一条是什么时候发的。用来拦住两条贴在一起发。
async function lastTouchAt() {
  const all = await getAll('touches');
  let best = '';
  for (const t of all) {
    if (t.kind === '拉黑') continue;
    const at = asText(t.created_at);
    if (at > best) best = at;
  }
  return best;
}

// 离上一条过去了多少秒。没发过就是很大的数。
async function secondsSinceLastTouch() {
  const at = await lastTouchAt();
  if (!at) return 1e9;
  // 存的是东八区的字符串，拿同一套换算比，不碰设备时区
  const now = nowCst();
  return Math.round((Date.parse(now.replace(' ', 'T') + 'Z') -
    Date.parse(at.replace(' ', 'T') + 'Z')) / 1000);
}

// 今天这类互动成功了多少次。用来卡每天的上限，别把号做没了。
async function touchCountToday(kind) {
  const all = await getAll('touches');
  const day = todayCst();
  return all.filter((t) => t.kind === kind && t.status === '成功' &&
    asText(t.created_at).slice(0, 10) === day).length;
}

// 试过的人，不管成没成都不再试。
//
// 只跳过成功的话，失败的下一轮又排进来。同一个人被连着试好几次，
// 而且有一种失败叫查不到发出去的消息，那种情况话可能已经发出去了
// 只是没读到证据，再发一遍就是给人连发两条。
async function triedIds(kind) {
  const all = await touches(2000);
  const out = new Set();
  for (const t of all) {
    if (t.kind === kind && t.user_id) out.add(t.user_id);
  }
  return out;
}

// 发过谁，他当初说了什么，我们回了什么。
//
// 流水表里只有我们发的话，对方原话在评论表里，按 user_id 关联。
// 一个人可能在好几条帖子底下都留过言，取最近那条，
// 因为话术就是照着最近那条生成的。
async function sentList(limit, trade) {
  const all = await touches(limit || 500);
  const comments = await getAll('comments');
  const byUser = {};
  for (const c of comments) {
    if (!c.user_id) continue;
    const old = byUser[c.user_id];
    if (!old || asText(c.comment_time) > asText(old.comment_time)) {
      byUser[c.user_id] = c;
    }
  }
  const out = [];
  for (const t of all) {
    if (t.kind !== '私信') continue;
    const c = byUser[t.user_id] || {};
    const tr = asTrade(c.trade || t.trade);
    if (trade && tr !== trade) continue;
    out.push({
      nickname: asText(t.nickname),
      user_id: asText(t.user_id),
      text: asText(t.text),
      status: asText(t.status),
      detail: asText(t.detail),
      at: asText(t.created_at),
      said: asText(c.content),
      site: asSite(c.site || t.site),
      trade: tr,
    });
  }
  return out;
}
