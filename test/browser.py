# 在真浏览器里跑一遍。跑法：python test/browser.py
#
# 起一个本地服务器假装是小红书：页面本身是空的，但 /api/sns/ 下面
# 会返回一份真实形状的搜索结果。用户脚本按扩展的方式在 document-start 注入，
# 跟装在 Safari 里是同一个时机。
#
# 要验的是四件事：钩子有没有钩到接口、面板画不画得出来、
# 导入的数据能不能变成人名单、话术是不是跟着人走。

import json
import http.server
import socketserver
import threading
import sys
import io
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = Path(__file__).resolve().parent.parent
PORT = 8791

SEARCH = {
    "data": {
        "has_more": True,
        "items": [{
            "id": "item1",
            "model_type": "note",
            "xsec_token": "ABtoken1",
            "note_card": {
                "note_id": "n0001",
                "display_title": "重庆女生找对象",
                "user": {"user_id": "u1", "nickname": "小鱼"},
                "interact_info": {"liked_count": "1.2万", "comment_count": "246"},
                "cover": {"url_default": "https://x/cover.webp"},
                "ip_location": "重庆",
            },
        }],
    }
}

EXPORT = {
    "version": 1,
    "exported_at": "2026-09-02 12:00:00",
    "tables": {
        "notes": [{
            "note_id": "n0001",
            "title": "重庆女生找对象",
            "content": "本人98年，坐标重庆，想找个认真谈的对象，希望对方175以上本科",
            "topics": "脱单",
            "author_id": "u1",
            "author_name": "小鱼",
            "likes": 12000,
            "comment_cnt": 246,
            "ip_location": "重庆",
            "publish_time": "2026-08-01 10:00:00",
            "note_url": "https://www.xiaohongshu.com/explore/n0001?xsec_token=T",
            "xsec_token": "T",
            "cover": "",
            "images": "",
            "keyword": "脱单",
            "fetched_at": "2026-09-01 10:00:00",
            "site": "小红书",
            "trade": "love",
        }],
        "comments": [
            {
                "comment_id": "c1", "note_id": "n0001", "parent_id": "", "level": "一级",
                "content": "举手", "nickname": "小明", "user_id": "u2", "likes": 3,
                "sub_count": 0, "comment_time": "2026-08-01 11:00:00",
                "ip_location": "成都", "fetched_at": "2026-09-01 10:00:00",
                "site": "小红书", "trade": "love",
            },
            {
                "comment_id": "c2", "note_id": "n0001", "parent_id": "", "level": "一级",
                "content": "加微信详聊，工作室接单", "nickname": "推广号", "user_id": "u3",
                "likes": 0, "sub_count": 0, "comment_time": "2026-08-01 11:05:00",
                "ip_location": "广东", "fetched_at": "2026-09-01 10:00:00",
                "site": "小红书", "trade": "love",
            },
        ],
        "keywords": [], "settings": [], "tasks": [], "touches": [],
    },
}

PAGE = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>假的小红书</title></head><body>
<h1>假的小红书</h1>
<div id="feed" style="height:3000px"></div>
<script>
window.__INITIAL_STATE__ = { note: { noteDetailMap: { n0001: { note: {
  noteId: 'n0001', title: '重庆女生找对象',
  desc: '本人98年，坐标重庆，想找个认真谈的对象 #脱单[话题]#',
  ipLocation: '重庆', time: 1754006400000,
  user: { userId: 'u1', nickName: '小鱼' },
  interactInfo: { likedCount: '1.2万', commentCount: '246' }
} } } } };
</script>
</body></html>"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith('/api/sns/'):
            body = json.dumps(SEARCH).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith('/fake'):
            body = PAGE.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def translate_path(self, path):
        return str(ROOT / path.lstrip('/').split('?')[0])


def serve():
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


ok = 0
bad = 0


def check(cond, name):
    global ok, bad
    if cond:
        ok += 1
    else:
        bad += 1
        print('  不对 ' + name)


def main():
    from playwright.sync_api import sync_playwright

    srv = serve()
    script = (ROOT / 'docs' / 'xhs-collect.user.js').read_text(encoding='utf-8')
    base = 'http://127.0.0.1:%d' % PORT
    tmp = ROOT / 'test' / '_export.json'
    tmp.write_text(json.dumps(EXPORT, ensure_ascii=False), encoding='utf-8')

    with sync_playwright() as p:
        b = p.chromium.launch()
        # 按手机的尺寸来。面板在窄屏上是从底下升起的一张卡，
        # 电脑上是右边一条竖栏，两种布局都要能用
        page = b.new_page(viewport={'width': 390, 'height': 844})
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        # 扩展就是这个时机注入的
        page.add_init_script(script)
        page.goto(base + '/fake')
        page.wait_for_selector('.xhsc-fab', timeout=5000)

        print('钩子')
        check(page.evaluate('window.__xhs.hookInstalled()'), '钩子装上了')
        page.evaluate("fetch('/api/sns/web/v1/search/notes?keyword=%E8%84%B1%E5%8D%95')")
        page.wait_for_timeout(400)
        check(page.evaluate("window.__xhs.Buckets.count('search')") >= 1,
              '页面自己发的请求被钩下来了')
        got = page.evaluate("""() => {
          const packs = window.__xhs.Buckets.take('search');
          const r = window.__xhs.parseCaptured(packs[0].url, packs[0].body, '脱单');
          return { n: r.notes.length, title: r.notes[0].title, likes: r.notes[0].likes };
        }""")
        check(got['n'] == 1, '解析出一篇')
        check(got['title'] == '重庆女生找对象', '标题对')
        check(got['likes'] == 12000, '1.2万 读成 12000')

        print('面板')
        page.click('.xhsc-fab')
        check(page.is_visible('.xhsc-panel'), '面板打开了')
        check(page.locator('.xhsc-tab').count() == 4, '四个页签')
        check(page.locator('.xhsc-chip').count() >= 8, '行业的预置关键词铺出来了')
        page.select_option('.xhsc-body select', 'beauty')
        page.wait_for_timeout(200)
        check('水光' in page.inner_text('.xhsc-chips'), '换行业换一批词')
        page.select_option('.xhsc-body select', 'love')
        page.wait_for_timeout(200)

        print('选词')
        page.locator('.xhsc-chip', has_text='脱单').first.click()
        page.wait_for_timeout(150)
        check(page.locator('.xhsc-chip.on').count() == 1, '点一下选中')
        page.fill('.xhsc-row input[type=text]', '自己加的词')
        page.click('text=加上')
        page.wait_for_timeout(150)
        check(page.locator('.xhsc-chip.on').count() == 2, '自己加的词也算选上')

        print('导入和人名单')
        page.click('.xhsc-tab >> nth=3')
        page.wait_for_timeout(300)
        page.set_input_files('.xhsc-body input[type=file]', str(tmp))
        page.wait_for_timeout(600)
        counts = page.evaluate("""async () => {
          const d = await window.__xhs.exportAll();
          return { notes: d.tables.notes.length, comments: d.tables.comments.length };
        }""")
        check(counts['notes'] == 1, '帖子进库了')
        check(counts['comments'] == 2, '评论进库了')

        page.click('.xhsc-tab >> nth=2')
        page.wait_for_timeout(600)
        text = page.inner_text('.xhsc-body')
        check('小鱼' in text, '帖主在名单里')
        check('小明' in text, '举手的评论者留下了')
        check('推广号' not in text, '广告号被漏斗剔掉了')
        check('高意向' in text, '标了意向')
        check(page.locator('.xhsc-card').count() == 2, '正好两个人')

        talk = page.evaluate("""() => {
          const c = document.querySelectorAll('.xhsc-card')[0];
          return c.querySelectorAll('p')[1].textContent;
        }""")
        check('185' in talk, '话术里带身高 ' + talk)
        check(talk.endswith('吗'), '话术以问句收尾 ' + talk)

        print('帖子页')
        page.click('.xhsc-tab >> nth=1')
        page.wait_for_timeout(500)
        notes_text = page.inner_text('.xhsc-body')
        check('重庆女生找对象' in notes_text, '帖子标题')
        check('12000' in notes_text or '赞 12000' in notes_text, '点赞数')

        print('看板网页')
        v = b.new_page(viewport={'width': 1280, 'height': 900})
        verrs = []
        v.on('pageerror', lambda e: verrs.append(str(e)))
        v.goto(base + '/docs/viewer.html')
        v.set_input_files('#file', str(tmp))
        v.wait_for_timeout(600)
        vtext = v.inner_text('#main')
        check('高意向 1' in vtext, '看板统计出高意向 1 个')
        check('广告或同行 1' in vtext, '看板统计出广告 1 个')
        check('小明' in vtext, '看板列出评论者')
        check('推广号' not in vtext, '看板也把广告剔掉')
        v.click('.tabs button >> nth=1')
        v.wait_for_timeout(300)
        check('重庆女生找对象' in v.inner_text('#list'), '看板的帖子页')
        check(not verrs, '看板没有报错 ' + str(verrs))

        print('安装页')
        i = b.new_page()
        ierrs = []
        i.on('pageerror', lambda e: ierrs.append(str(e)))
        i.goto(base + '/docs/index.html')
        check('获客助手' in i.inner_text('h1'), '标题')
        check(i.locator('a.btn').count() >= 1, '有安装按钮')
        check(not ierrs, '安装页没有报错')

        check(not errs, '小红书页面上没有报错 ' + str(errs))
        b.close()

    srv.shutdown()
    tmp.unlink(missing_ok=True)
    print('')
    print(('全过了，%d 项' % ok) if bad == 0 else ('%d 项过，%d 项没过' % (ok, bad)))
    sys.exit(0 if bad == 0 else 1)


main()
