# 整轮采集跑一遍。跑法：python test/flow.py
#
# 用 Playwright 把 www.xiaohongshu.com 整个接管，自己造搜索页和详情页，
# 页面加载时像真页面那样去请求接口。脚本那边完全不知道自己在假站上，
# 域名、地址、跳转都跟真的一样。
#
# 要验的是状态机：搜索页攒够篇数、逐篇跳过去、拿正文和评论、
# 一篇完了跳下一篇、跑完收尾。这一段跨了好几次页面刷新，
# 是整套东西里最容易出错的地方，纯函数测试覆盖不到。

import json
import re
import sys
import io
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = Path(__file__).resolve().parent.parent

NOTES = [
    {"id": "n0001", "title": "重庆女生找对象",
     "desc": "本人98年，坐标重庆，想找个认真谈的对象，希望对方175以上本科 #脱单[话题]#",
     "ip": "重庆"},
    {"id": "n0002", "title": "成都男生征友",
     "desc": "本人95年，坐标成都，有稳定工作，想找个踏实的女生 #脱单[话题]#",
     "ip": "成都"},
    {"id": "n0003", "title": "多出来的一篇", "desc": "这篇不该被采到", "ip": "北京"},
]


def search_json():
    return {"data": {"has_more": True, "items": [
        {"id": n["id"], "model_type": "note", "xsec_token": "TK" + n["id"],
         "note_card": {
             "note_id": n["id"], "display_title": n["title"],
             "user": {"user_id": "u" + n["id"], "nickname": "楼主" + n["id"][-1]},
             "interact_info": {"liked_count": "1.2万", "comment_count": "24"},
             "ip_location": n["ip"],
             "cover": {"url_default": "https://x/c.webp"}}}
        for n in NOTES]}}


def comment_json(note_id):
    return {"data": {"has_more": False, "comments": [
        {"id": note_id + "-c1", "content": "举手", "like_count": 3,
         "create_time": 1754006400000, "ip_location": "成都",
         "user_info": {"user_id": note_id + "-u1", "nickname": "举手的" + note_id[-1]}},
        {"id": note_id + "-c2", "content": "加微信详聊，工作室接单", "like_count": 0,
         "create_time": 1754006400000, "ip_location": "广东",
         "user_info": {"user_id": note_id + "-u2", "nickname": "广告号"}},
    ]}}


SEARCH_PAGE = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>搜索</title></head><body style="height:4000px">
<h1>搜索结果</h1>
<script>
// 真页面就是自己去请求接口的，这里照做
fetch('/api/sns/web/v1/search/notes?keyword=x').then(r => r.json());
</script>
</body></html>"""

NOTE_PAGE = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>笔记</title></head><body style="height:4000px">
<h1>笔记</h1>
<script>
window.__INITIAL_STATE__ = { note: { noteDetailMap: { "__ID__": { note: __NOTE__ } } } };
fetch('/api/sns/web/v2/comment/page?note_id=__ID__').then(r => r.json());
</script>
</body></html>"""


def note_state(n):
    return json.dumps({
        "noteId": n["id"], "title": n["title"], "desc": n["desc"],
        "ipLocation": n["ip"], "time": 1754006400000,
        "user": {"userId": "u" + n["id"], "nickName": "楼主" + n["id"][-1]},
        "interactInfo": {"likedCount": "1.2万", "commentCount": "24"},
        "tagList": [{"name": "脱单"}],
    }, ensure_ascii=False)


ok = 0
bad = 0


def check(cond, name):
    global ok, bad
    if cond:
        ok += 1
        print('  过 ' + name)
    else:
        bad += 1
        print('  不对 ' + name)


def main():
    from playwright.sync_api import sync_playwright

    script = (ROOT / 'docs' / 'xhs-collect.user.js').read_text(encoding='utf-8')
    hits = {'search': 0, 'comment': 0, 'explore': []}

    def handle(route):
        url = route.request.url
        if '/api/sns/' in url and '/search/notes' in url:
            hits['search'] += 1
            route.fulfill(status=200, content_type='application/json',
                          body=json.dumps(search_json(), ensure_ascii=False))
            return
        if '/api/sns/' in url and '/comment/page' in url:
            hits['comment'] += 1
            nid = re.search(r'note_id=([^&]+)', url)
            route.fulfill(status=200, content_type='application/json',
                          body=json.dumps(comment_json(nid.group(1) if nid else 'x'),
                                          ensure_ascii=False))
            return
        m = re.search(r'/explore/([a-zA-Z0-9]+)', url)
        if m:
            hits['explore'].append(m.group(1))
            n = next((x for x in NOTES if x['id'] == m.group(1)), NOTES[0])
            body = (NOTE_PAGE.replace('__NOTE__', note_state(n))
                    .replace('__ID__', n['id']))
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=body)
            return
        route.fulfill(status=200, content_type='text/html; charset=utf-8',
                      body=SEARCH_PAGE)

    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={'width': 390, 'height': 844})
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.route('https://www.xiaohongshu.com/**', handle)
        page.add_init_script(script)
        page.goto('https://www.xiaohongshu.com/explore_start')
        page.wait_for_selector('.xhsc-fab', timeout=8000)

        print('开一轮')
        # 间隔按设置摊出来。默认三十分钟五十篇是每篇隔五十秒，
        # 一个用例要跑好几分钟，所以这里调成最密，让它落到三秒的下限上
        page.evaluate("async () => await window.__xhs.Limits.save(300, 5)")
        page.evaluate("""async () => {
          await window.__xhs.startCollect({
            keywords: ['脱单'], maxNotes: 2, maxComments: 2,
            onlyOwner: false, trade: 'love',
          });
        }""")

        # 状态机跑完自己会把 running 置回 false
        done = False
        for _ in range(120):
            page.wait_for_timeout(1000)
            try:
                st = page.evaluate("""async () => {
                  const j = await window.__xhs.exportAll();
                  const r = window.__xhs.Runtime.job || {};
                  return { running: !!r.running, msg: r.message || '',
                           notes: j.tables.notes.length,
                           comments: j.tables.comments.length };
                }""")
            except Exception:
                # 正好赶上页面在跳转，等下一轮
                continue
            if st['running'] is False and st['notes'] > 0:
                done = True
                print('  收尾 ' + st['msg'])
                break

        check(done, '整轮跑完了')
        check(hits['search'] >= 1, '搜索接口被请求了')
        check(len(hits['explore']) >= 2, '两篇笔记都跳过去打开了，实际 %d 次'
              % len(hits['explore']))
        check(hits['explore'][:2] == ['n0001', 'n0002'], '按搜索结果的顺序逐篇打开')
        check('n0003' not in hits['explore'], '只采两篇，第三篇不该碰')
        check(hits['comment'] >= 2, '每篇都翻了评论')

        data = page.evaluate("async () => await window.__xhs.exportAll()")
        notes = data['tables']['notes']
        comments = data['tables']['comments']
        check(len(notes) == 2, '库里两篇笔记，实际 %d' % len(notes))
        check(len(comments) == 4, '库里四条评论，实际 %d' % len(comments))

        one = next((n for n in notes if n['note_id'] == 'n0001'), None)
        check(one is not None, '第一篇进库了')
        if one:
            check(one['title'] == '重庆女生找对象', '标题取自页面里那份数据')
            check('话题' not in one['content'], '话题的尾巴清掉了')
            check(one['ip_location'] == '重庆', '属地')
            check(one['likes'] == 12000, '1.2万 读成 12000')
            check(one['keyword'] == '脱单', '关键词记下来了')
            check(one['xsec_token'] == 'TKn0001', 'token 从搜索结果带过来')
            check(one['trade'] == 'love', '行业记下来了')
            check(one['publish_time'].startswith('2025-08-01'), '发布时间')

        c1 = next((c for c in comments if c['comment_id'] == 'n0001-c1'), None)
        check(c1 is not None and c1['note_id'] == 'n0001', '评论挂回了对应的笔记')

        print('人名单')
        people = page.evaluate("""async () => {
          const rows = await window.__xhs.listPeople({ trade: 'love' });
          return rows.map(r => ({ n: r.nickname, k: r.kind, s: r.said }));
        }""")
        check(len(people) == 6, '两个帖主加四个评论者，实际 %d' % len(people))

        # 采集在跑的时候面板是自动打开的，这时候再点悬浮按钮会被面板挡住
        if not page.is_visible('.xhsc-panel'):
            page.click('.xhsc-fab')
        page.click('.xhsc-tab >> nth=2')
        page.wait_for_timeout(800)
        text = page.inner_text('.xhsc-body')
        check('广告号' not in text, '广告号被漏斗剔掉')
        check('举手的1' in text, '举手的人留下了')
        check('楼主1' in text, '帖主也在名单里')

        print('中途刷新')
        # 状态机最要紧的一条承诺：页面没了进度也不丢。
        # 采集本来就是靠跳页面推进的，刷新跟跳页面走的是同一条路，
        # 但刷新会落在等待中间，得确认剩下的等待被接着走完了。
        before = len(hits['explore'])
        page.evaluate("""async () => {
          await window.__xhs.startCollect({
            keywords: ['脱单'], maxNotes: 1, maxComments: 2,
            onlyOwner: true, trade: 'love',
          });
        }""")
        page.wait_for_timeout(3000)
        page.reload()
        page.wait_for_selector('.xhsc-fab', timeout=8000)
        back = False
        for _ in range(90):
            page.wait_for_timeout(1000)
            try:
                r = page.evaluate("() => { const j = window.__xhs.Runtime.job || {}; "
                                  "return { run: !!j.running, msg: j.message || '' }; }")
            except Exception:
                continue
            if not r['run']:
                back = True
                print('  ' + r['msg'])
                break
        check(back, '刷新之后接着跑完了')
        check(len(hits['explore']) > before, '刷新之后还是把帖子打开了')

        print('中途停下')
        page.evaluate("""async () => {
          await window.__xhs.startCollect({
            keywords: ['脱单'], maxNotes: 2, maxComments: 2,
            onlyOwner: true, trade: 'love',
          });
        }""")
        page.wait_for_timeout(2500)
        page.evaluate("async () => await window.__xhs.stopCollect()")
        stopped = False
        for _ in range(30):
            page.wait_for_timeout(1000)
            try:
                r = page.evaluate("() => { const j = window.__xhs.Runtime.job || {}; "
                                  "return { run: !!j.running, msg: j.message || '' }; }")
            except Exception:
                continue
            if not r['run']:
                stopped = True
                print('  ' + r['msg'])
                break
        check(stopped, '按停止之后这一轮结束了')

        check(not errs, '页面上没有报错 ' + str(errs[:3]))
        b.close()

    print('')
    print(('全过了，%d 项' % ok) if bad == 0 else ('%d 项过，%d 项没过' % (ok, bad)))
    sys.exit(0 if bad == 0 else 1)


main()
