// 把 src 下的几个文件拼成两份成品：
//
//   docs/xhs-collect.user.js  装进浏览器的用户脚本，采集就靠它
//   docs/assets/lib.js        看板网页用的那一份，只要判意向和出话术那几块
//
// 拼接而不是打包，是因为这套东西要能被人直接读懂。用户脚本装在别人的
// 浏览器里，跑在他自己的账号上，看不懂的代码不该让人装。
//
// 跑法：node build.js

const fs = require('fs');
const path = require('path');

const root = __dirname;
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');

const VERSION = '1.3.0';

// 用户脚本的说明块。脚本管理器认的就是这一段。
//
// grant none 和 inject-into page 是同一件事的两种写法，不同的脚本管理器
// 各认各的。两条都写上，脚本才能跑在页面自己的环境里，
// 也才改得动页面的 fetch。少了这一条，一条数据都钩不到。
const META = `// ==UserScript==
// @name         获客助手
// @namespace    https://github.com/Goose666666/xhs-collect-web
// @version      ${VERSION}
// @description  在小红书和抖音页面里采集帖子和评论，挑出想找对象的人，发私信和评论
// @author       xhs-collect-web
// @match        https://www.xiaohongshu.com/*
// @match        https://xiaohongshu.com/*
// @match        https://www.douyin.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// @downloadURL  https://goose666666.github.io/xhs-collect-web/xhs-collect.user.js
// @updateURL    https://goose666666.github.io/xhs-collect-web/xhs-collect.user.js
// ==/UserScript==
`;

const USER_FILES = [
  '10-util.js',
  '20-parse.js',
  '22-douyin.js',
  '30-store.js',
  '40-industry.js',
  '45-limits.js',
  '50-funnel.js',
  '55-reply.js',
  '56-poster.js',
  '57-draft.js',
  '58-csv.js',
  '60-hook.js',
  '70-engine.js',
  '74-sender.js',
  '80-ui.js',
  '90-main.js',
];

// 看板网页只做看和导出，不采集，所以不要库、钩子、状态机那几块。
const LIB_FILES = [
  '10-util.js',
  '57-draft.js',
  '40-industry.js',
  '50-funnel.js',
  '55-reply.js',
  '58-csv.js',
];

function join(files) {
  return files.map((f) => '// ===== ' + f + ' =====\n' + src(f)).join('\n\n');
}

function write(rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  console.log(rel + '  ' + (text.length / 1024).toFixed(1) + ' KB');
}

// ---- 用户脚本 ----
write('docs/xhs-collect.user.js',
  META + "\n(function () {\n'use strict';\n\n" + join(USER_FILES) + '\n\n})();\n');

// ---- 看板用的那一份 ----
//
// industry.js 里的 Trade 要读设置，看板没有库，给它两个空壳顶上。
const LIB_SHIM = `// 看板没有本地库，行业设置存在 localStorage 里。
async function getSetting(k, d) {
  try {
    const v = localStorage.getItem('xhs_' + k);
    return v === null ? d : JSON.parse(v);
  } catch (e) { return d; }
}
async function setSetting(k, v) {
  try { localStorage.setItem('xhs_' + k, JSON.stringify(v)); } catch (e) {}
}
`;

const LIB_EXPORT = `
window.XHS = {
  asText, asInt, asSite, asTrade, head, esc, nowCst, todayCst, tsToStr,
  allIndustries, industryOf, Trade,
  judge, judgePerson, saidStop, runFunnel,
  INTENT_HIGH, INTENT_MID, INTENT_LOW, INTENT_RISKY,
  parseWants, wantsWords, makeReply, theirGender, guessGender, draftFor, echoOf,
  peopleCsv, notesCsv, csvText, download,
};
`;

write('docs/assets/lib.js',
  "(function () {\n'use strict';\n\n" + LIB_SHIM + '\n' + join(LIB_FILES) +
  '\n' + LIB_EXPORT + '\n})();\n');
