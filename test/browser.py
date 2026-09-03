# 在真浏览器里跑一遍。跑法：python test/browser.py
#
# 起一个本地服务器假装是小红书：页面本身是空的，但 /api/sns/ 下面会返回
# 一份真实形状的搜索结果，另外两个页面照着个人主页和笔记页的结构搭出来，
# 私信浮窗、输入框、发送键、消息气泡都有。用户脚本按扩展的方式在
# document-start 注入，跟装在 Safari 里是同一个时机。
#
# 要验的是这几件事：钩子钩不钩得到接口、面板画不画得出来、
# 导入的数据能不能变成人名单、发送那条路能不能真的把话填进去发出去。

import json
import http.server
import socketserver
import threading
import sys
import io
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8',
                              line_buffering=True)

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
            "cover": "http://127.0.0.1:%d/pic" % PORT, "images": "", "keyword": "脱单",
            "fetched_at": "2026-09-01 10:00:00",
            "site": "小红书", "trade": "love",
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

# 假的个人主页。照着真页面的结构搭：关注和私信并排，点私信右边挂出浮窗，
# 浮窗里是可编辑的输入框，回车即发，发出去的话变成一个气泡。
PROFILE = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>小明的主页</title></head><body>
<nav><span>私信</span></nav>
<main>
  <h2 id="nick">小明</h2>
  <p>这里是个人主页的简介，随便写点字把页面撑到六十个字以上，
  好让脚本认为页面已经渲染完了，不然它会一直等下去。</p>
  <div style="display:flex;align-items:center;gap:12px">
    <div id="follow" style="width:80px;height:32px;border:1px solid #ccc">关注</div>
    <div id="im" class="xhs-user-im-btn" style="width:40px;height:32px">私信</div>
  </div>
</main>
<script>
document.getElementById('im').addEventListener('click', function () {
  if (document.querySelector('.componentsRightPanelwrapper')) return;
  var p = document.createElement('div');
  p.className = 'componentsRightPanelwrapper';
  p.innerHTML = '<div class="RightPanelHeadertitle">小明</div>' +
    '<div class="messages"></div>' +
    '<div class="xhs-im-input-bar-editor" contenteditable="true"' +
    ' data-placeholder="发送消息" style="width:300px;height:40px"></div>';
  document.body.appendChild(p);
  var box = p.querySelector('.xhs-im-input-bar-editor');
  // 真的小红书私信框就是回车即发，没有独立的发送键
  box.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var text = box.textContent;
    if (!text) return;
    var b = document.createElement('div');
    b.className = 'xhs-im-bubble__text';
    b.textContent = text;
    p.querySelector('.messages').appendChild(b);
    box.textContent = '';
  });
});
</script>
</body></html>"""

# 假的笔记页。
#
# 有一个公共评论框，还有一条别人的评论，评论后面挂着回复。
# 回复某个人时脚本要先点那条评论的回复，输入框的占位文字才会变成
# 回复 @某某，这一步做不对，话就填进公共评论框变成公开留言了。
NOTE = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>重庆女生找对象</title></head><body>
<article>
  <h2>重庆女生找对象</h2>
  <p>""" + ("本人98年坐标重庆想找个认真谈的对象。" * 20) + """</p>
</article>
<div data-e2e="comment-list">
  <div data-e2e="comment-item">
    <span>小明</span><span>举手</span>
    <span class="reply-btn">回复</span>
  </div>
</div>
<div class="comment-wrap">
  <div id="cbox" contenteditable="true" data-placeholder="说点什么"
       style="width:300px;height:40px"></div>
</div>
<script>
document.querySelector('.reply-btn').addEventListener('click', function () {
  // 真页面点了回复之后，输入框会变成回复某个人的样子
  document.getElementById('cbox').setAttribute('data-placeholder', '回复 @小明');
  document.body.setAttribute('data-replying', '小明');
});
</script>
</body></html>"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype):
        b = body.encode()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith('/pic'):
            # 一张 1x1 的透明 png，用来验封面图真的画出来了
            png = bytes.fromhex(
                '89504e470d0a1a0a0000000d49484452000000010000000108060000001f'
                '15c4890000000a49444154789c6300010000050001'
                '0d0a2db40000000049454e44ae426082')
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(png)))
            self.end_headers()
            self.wfile.write(png)
            return
        if self.path.startswith('/api/sns/'):
            return self._send(json.dumps(SEARCH), 'application/json')
        if self.path.startswith('/profile'):
            return self._send(PROFILE, 'text/html; charset=utf-8')
        if self.path.startswith('/note'):
            return self._send(NOTE, 'text/html; charset=utf-8')
        if self.path.startswith('/fake'):
            return self._send(PAGE, 'text/html; charset=utf-8')
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
        page.add_init_script(script)
        page.goto(base + '/fake')
        page.wait_for_selector('.xhsc-fab', timeout=5000)

        print('钩子')
        check(page.evaluate('window.__xhs.hookInstalled()'), '钩子装上了')
        page.evaluate("fetch('/api/sns/web/v1/search/notes?keyword=x')")
        page.wait_for_timeout(500)
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
        check(page.evaluate("window.__xhs.siteNow()") == '小红书', '平台按域名认')

        print('面板')
        page.click('.xhsc-fab')
        check(page.is_visible('.xhsc-panel'), '面板打开了')
        check(page.locator('.xhsc-tab').count() == 5, '五个页签，跟手机版一样')
        tabs = page.locator('.xhsc-tab').all_text_contents()
        check(tabs == ['采集', '帖子', '人', '私信', '设置'], '页签的名字和顺序 ' + str(tabs))
        check(page.locator('.xhsc-chip').count() >= 8, '行业的预置关键词铺出来了')

        print('选词')
        page.locator('.xhsc-chip', has_text='脱单').first.click()
        page.wait_for_timeout(150)
        check(page.locator('.xhsc-chip.on').count() == 1, '点一下选中')
        page.fill('.xhsc-row input[type=text]', '自己加的词')
        page.click('text=加上')
        page.wait_for_timeout(150)
        check(page.locator('.xhsc-chip.on').count() == 2, '自己加的词也算选上')

        print('导入')
        page.click('.xhsc-tab >> nth=4')
        page.wait_for_timeout(400)
        page.set_input_files('.xhsc-body input[type=file]', str(tmp))
        page.wait_for_timeout(700)
        counts = page.evaluate("""async () => {
          const d = await window.__xhs.exportAll();
          return { notes: d.tables.notes.length, comments: d.tables.comments.length };
        }""")
        check(counts['notes'] == 1, '帖子进库了')
        check(counts['comments'] == 2, '评论进库了')

        print('话术能自己改')
        page.wait_for_timeout(300)
        page.click('.xhsc-tab >> nth=4')
        page.wait_for_timeout(400)
        n_talk = page.locator('.xhsc-body textarea').count()
        check(n_talk == 3, '找对象那三条预置话术铺出来了，实际 %d' % n_talk)
        page.locator('.xhsc-body textarea').first.fill('我这边有几个合适的，方便聊聊吗')
        page.locator('.xhsc-body textarea').first.dispatch_event('change')
        page.wait_for_timeout(300)
        page.click('text=加一条话术')
        page.wait_for_timeout(400)
        check(page.locator('.xhsc-body textarea').count() == 4, '加了一条')
        talks = page.evaluate("() => window.__xhs.Trade.talks")
        check(talks[0]['text'] == '我这边有几个合适的，方便聊聊吗', '改的话存下来了')
        page.locator('.xhsc-body button', has_text='删掉').last.click()
        page.wait_for_timeout(400)
        check(page.locator('.xhsc-body textarea').count() == 3, '删掉一条')
        picked = page.evaluate("() => window.__xhs.Trade.pickedTalks().length")
        check(picked == 3, '三条都勾着')
        page.locator('.xhsc-body button', has_text='发这条').first.click()
        page.wait_for_timeout(400)
        check(page.evaluate("() => window.__xhs.Trade.pickedTalks().length") == 2,
              '取消勾选之后就不发那条了')

        print('人名单')
        page.click('.xhsc-tab >> nth=2')
        page.wait_for_timeout(800)
        text = page.inner_text('.xhsc-body')
        check('小明' in text, '举手的评论者留下了')
        check('推广号' not in text, '广告号被漏斗剔掉了')
        check('小鱼' not in text, '默认只看评论区的人，帖主不显示')
        nums = page.locator('.xhsc-num').all_inner_texts()
        check(len(nums) == 3, '三格数字条')
        check(page.locator('.xhsc-num.on').inner_text().find('评论区的人') >= 0,
              '默认停在评论区的人那一格')
        page.locator('.xhsc-num', has_text='帖主').click()
        page.wait_for_timeout(600)
        check('小鱼' in page.inner_text('.xhsc-body'), '点帖主那格就看得到帖主')
        check('私信' not in page.inner_text('.xhsc-card'), '帖主那行不给私信按钮')
        page.locator('.xhsc-num', has_text='全部').click()
        page.wait_for_timeout(600)
        check(page.locator('.xhsc-card').count() == 2, '全部是两个人')

        foot = page.inner_text('.xhsc-foot')
        check('私信 1 个人' in foot, '底下的按钮只数评论区的人 ' + foot)
        check('评论 1 篇' in foot, '评论按帖子去重 ' + foot)

        check(page.locator('.xhsc-card', has_text='小明').first
              .locator('.xhsc-tag.he').count() == 1, '人名单上也标了男女')

        talk = page.evaluate("""() => {
          const c = document.querySelectorAll('.xhsc-card')[0];
          return c.querySelectorAll('p')[1].textContent;
        }""")
        check('185' in talk, '话术里带身高 ' + talk)
        check(talk.endswith('吗'), '话术以问句收尾 ' + talk)

        print('搜索和分页')
        page.fill('.xhsc-body input[type=text]', '举手')
        page.locator('.xhsc-body input[type=text]').dispatch_event('change')
        page.wait_for_timeout(600)
        check(page.locator('.xhsc-card').count() == 1, '搜得到')
        page.fill('.xhsc-body input[type=text]', '')
        page.locator('.xhsc-body input[type=text]').dispatch_event('change')
        page.wait_for_timeout(600)

        print('帖子页')
        page.click('.xhsc-tab >> nth=1')
        page.wait_for_timeout(600)
        notes_text = page.inner_text('.xhsc-body')
        check('重庆女生找对象' in notes_text, '帖子标题')
        check('12000' in notes_text, '点赞数')
        page.wait_for_timeout(400)
        check(page.locator('.xhsc-cover').count() == 1, '封面图画出来了')
        check(page.evaluate("""() => {
          const im = document.querySelector('.xhsc-cover');
          return !!im && im.complete && im.naturalWidth > 0;
        }"""), '封面图真的加载成功了，不是一个破图框')

        print('帖子点进去看评论')
        page.locator('.xhsc-card').first.click()
        page.wait_for_timeout(700)
        detail = page.inner_text('.xhsc-body')
        check('举手' in detail, '点进去看得到这篇底下的评论')
        check('加微信详聊' in detail, '广告号在评论列表里也留着，这一页不筛人')

        # 小明在一个女生的找对象帖底下举手，按相反的性别算
        ming = page.locator('.xhsc-crow', has_text='举手').first
        check('男' in ming.inner_text(), '举手的评论者标了男 ' + ming.inner_text())
        check(ming.locator('.xhsc-tag.he').count() == 1, '男标是那个固定的蓝')
        check(page.locator('.xhsc-tag.she').count() >= 1, '帖主是女的')

        # 在举手的换个底色，这是一屏几百条里找人的唯一抓手
        check('worth' in (ming.get_attribute('class') or ''), '举手的那条换了底色')
        ad = page.locator('.xhsc-crow', has_text='加微信详聊').first
        check('worth' not in (ad.get_attribute('class') or ''), '广告号不算在举手')

        nums = page.locator('.xhsc-num').all_inner_texts()
        check(len(nums) == 2, '两格数字条：全部和在举手')
        check('2' in nums[0] and '全部' in nums[0], '全部两条 ' + nums[0])
        check('1' in nums[1] and '在举手' in nums[1], '在举手一条 ' + nums[1])
        page.locator('.xhsc-num', has_text='在举手').click()
        page.wait_for_timeout(500)
        check(page.locator('.xhsc-crow').count() == 1, '只看在举手的')
        check('加微信详聊' not in page.inner_text('.xhsc-body'), '广告号被筛掉了')
        page.locator('.xhsc-num', has_text='全部').click()
        page.wait_for_timeout(500)

        print('点一条评论就是回复他')
        check('在帖子底下留言' in page.inner_text('.xhsc-foot'), '什么都不选就是留言')
        page.locator('.xhsc-crow', has_text='举手').first.click()
        page.wait_for_timeout(500)
        foot = page.inner_text('.xhsc-foot')
        check('回复 小明' in foot, '选中之后底下写着回复谁 ' + foot)
        first = page.input_value('.xhsc-foot textarea')
        check(len(first) > 6, '话已经预填好了 ' + first)
        check('185' in first, '预填的是照他那句话生成的 ' + first)
        check('on' in (page.locator('.xhsc-crow', has_text='举手')
                       .first.get_attribute('class') or ''), '选中的那条描了边')

        page.locator('.xhsc-foot button', has_text='换一句').click()
        page.wait_for_timeout(400)
        second = page.input_value('.xhsc-foot textarea')
        check(second != first, '换一句真换了 ' + second)
        page.locator('.xhsc-foot button', has_text='取消').click()
        page.wait_for_timeout(400)
        check('在帖子底下留言' in page.inner_text('.xhsc-foot'), '取消之后回到留言')
        check(page.locator('.xhsc-crow.on').count() == 0, '选中的边也撤了')

        page.locator('.xhsc-body button', has_text='返回').click()
        page.wait_for_timeout(500)
        check(page.locator('.xhsc-card').count() >= 1, '返回回得到列表')
        check(page.locator('.xhsc-foot').count() == 0, '返回之后输入区也收走')

        print('私信记录')
        page.click('.xhsc-tab >> nth=3')
        page.wait_for_timeout(600)
        check('还没发过私信' in page.inner_text('.xhsc-body'), '还没发过就明说')

        # ---------- 发私信 ----------
        #
        # 地址里带着那个人的 id，状态机就认为已经在该干活的页面上，
        # 不再跳转，直接开发。这样不用真去小红书就能把整条路走完。
        print('发私信')
        dm = b.new_page(viewport={'width': 390, 'height': 844})
        derrs = []
        dm.on('pageerror', lambda e: derrs.append(str(e)))
        dm.add_init_script(script)
        dm.goto(base + '/profile?u=u2')
        dm.wait_for_selector('.xhsc-fab', timeout=5000)
        dm.evaluate("""async () => {
          await window.__xhs.importAll(%s);
        }""" % json.dumps(EXPORT, ensure_ascii=False))
        started = dm.evaluate("""async () => {
          const people = await window.__xhs.listPeople({ trade: 'love' });
          const one = people.filter((p) => p.user_id === 'u2');
          return await window.__xhs.startSend(one, '私信');
        }""")
        check(started['ok'], '这一批挑得出人 ' + str(started))
        dm.wait_for_function(
            "() => !window.__xhs.Sender.job || !window.__xhs.Sender.job.running",
            timeout=60000)
        bubble = dm.inner_text('.xhs-im-bubble__text')
        check('185' in bubble or bubble.endswith('吗'), '话真发进气泡了 ' + bubble)
        rows = dm.evaluate("async () => await window.__xhs.sentList(50, 'love')")
        check(len(rows) == 1, '记了一条流水')
        check(rows[0]['status'] == '成功', '核对到气泡才算成功 ' + str(rows[0]))
        check(rows[0]['nickname'] == '小明', '发给谁')
        check(rows[0]['said'] == '举手', '他当初说的话也带出来了')
        check(rows[0]['text'] == bubble, '记下来的话和发出去的一致')

        print('同一个人不再发第二遍')
        again = dm.evaluate("""async () => {
          const people = await window.__xhs.listPeople({ trade: 'love' });
          const one = people.filter((p) => p.user_id === 'u2');
          return await window.__xhs.startSend(one, '私信');
        }""")
        check(not again['ok'], '试过的人挑不出来了')
        check('试过' in again['why'], '还要说清为什么 ' + str(again['why']))

        print('私信记录页')
        dm.click('.xhsc-fab')
        dm.click('.xhsc-tab >> nth=3')
        dm.wait_for_timeout(600)
        sent_text = dm.inner_text('.xhsc-body')
        check('小明' in sent_text, '记录里有这个人')
        check('举手' in sent_text, '他当初说的话')
        check('成功' in sent_text, '状态')
        check(not derrs, '发私信这一路没有报错 ' + str(derrs))

        # ---------- 发评论 ----------
        print('发评论')
        cm = b.new_page(viewport={'width': 390, 'height': 844})
        cerrs = []
        cm.on('pageerror', lambda e: cerrs.append(str(e)))
        cm.add_init_script(script)
        cm.goto(base + '/note?id=n0001')
        cm.wait_for_selector('.xhsc-fab', timeout=5000)
        cm.evaluate("""async () => {
          await window.__xhs.importAll(%s);
        }""" % json.dumps(EXPORT, ensure_ascii=False))
        # 帖主那条：昵称留空，只找公共评论框
        cm.evaluate("""async () => {
          const people = await window.__xhs.listPeople({ trade: 'love' });
          const one = people.filter((p) => p.kind === '帖主').slice(0, 1)
            .map((p) => Object.assign({}, p,
              { text: '同城的可以聊聊', nickname: '' }));
          return await window.__xhs.startSend(one, '评论');
        }""")
        cm.wait_for_function(
            "() => window.__xhs.Sender.job && window.__xhs.Sender.job.waiting === 'send'",
            timeout=60000)
        check(cm.inner_text('#cbox') == '同城的可以聊聊', '话填进评论框了')
        check(cm.get_attribute('body', 'data-replying') is None,
              '帖主那条不去点别人的回复')
        # 面板要自己打开翻到人页，那一页在发送时就是进度页
        cm.click('.xhsc-fab')
        cm.click('.xhsc-tab >> nth=2')
        cm.wait_for_timeout(500)
        big = cm.inner_text('.xhsc-big')
        check('发送' in big, '界面上说清了最后那一下要人自己按 ' + big)
        check(cm.locator('.xhsc-body button', has_text='我发过了').count() == 1,
              '有个按钮让人说自己发完了')
        cm.locator('.xhsc-body button', has_text='我发过了').click()
        cm.wait_for_function(
            "() => !window.__xhs.Sender.job || !window.__xhs.Sender.job.running",
            timeout=30000)
        cmrows = cm.evaluate("async () => await window.__xhs.sentList(50, 'love')")
        check(len(cmrows) == 0,
              '人自己按的那一下程序看不见，所以不记流水，实际 %d 条' % len(cmrows))

        print('回复评论区的人')
        cm.evaluate("""() => { document.getElementById('cbox').textContent = ''; }""")
        cm.evaluate("""async () => {
          const people = await window.__xhs.listPeople({ trade: 'love' });
          const one = people.filter((p) => p.nickname === '小明').slice(0, 1)
            .map((p) => Object.assign({}, p, { text: '我这边有合适的人选' }));
          return await window.__xhs.startSend(one, '评论');
        }""")
        cm.wait_for_function(
            "() => window.__xhs.Sender.job && window.__xhs.Sender.job.waiting === 'send'",
            timeout=60000)
        check(cm.get_attribute('body', 'data-replying') == '小明',
              '先去评论区点了那个人的回复，没有直接填公共评论框')
        check(cm.inner_text('#cbox') == '我这边有合适的人选', '话填进回复框了')
        cm.evaluate("() => window.__xhs.humanDone()")
        cm.wait_for_function(
            "() => !window.__xhs.Sender.job || !window.__xhs.Sender.job.running",
            timeout=30000)
        check(not cerrs, '发评论这一路没有报错 ' + str(cerrs))

        # ---------- 抖音 ----------
        print('抖音')
        check(page.evaluate("""() => {
          const u = window.__xhs.parseDouyin(
            'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=7',
            JSON.stringify({comments:[{cid:'x',text:'蹲一个',
              user:{sec_uid:'MS4wZZZ',nickname:'小美'},reply_id:'0'}]}), '');
          return u.comments.length === 1 && u.comments[0].user_id === 'MS4wZZZ';
        }"""), '抖音的解析也在这一份脚本里')

        print('看板网页')
        v = b.new_page(viewport={'width': 1280, 'height': 900})
        verrs = []
        v.on('pageerror', lambda e: verrs.append(str(e)))
        v.goto(base + '/docs/viewer.html')
        v.set_input_files('#file', str(tmp))
        v.wait_for_timeout(700)
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
