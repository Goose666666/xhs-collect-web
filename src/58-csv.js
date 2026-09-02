// 导出成 CSV，拿到电脑上用表格软件打开。
//
// 表头和列序跟手机版 lib/local/export.dart 完全一致，三端导出的表能直接摞在一起。

// Excel 认这个字节序标记才不会把中文显示成乱码。
const csvBom = '﻿';

// 换行用 \r\n。Excel 在 Windows 上认这个，只给 \n 会把一行拆成两行。
const csvEol = '\r\n';

function csvCell(v) {
  const s = asText(v);
  // 逗号、引号、换行都要包起来，引号本身再翻一倍
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

function csvText(header, rows) {
  let buf = csvBom + csvRow(header) + csvEol;
  for (const r of rows) buf += csvRow(r) + csvEol;
  return buf;
}

// 表头一律用界面上的说法，导出来的表和面板里看到的能对上号。
const peopleHeader = ['昵称', '类型', '属地', '说的话', '时间', '点赞', '关键词', '笔记标题'];
const notesHeader = ['标题', '作者', '属地', '正文', '话题标签', '发布时间', '点赞', '评论', '关键词', '笔记链接'];
const commentsHeader = ['昵称', '属地', '说的话', '时间', '点赞', '关键词', '笔记标题'];

function peopleCsv(rows) {
  return csvText(peopleHeader, rows.map((r) => [
    r.nickname, r.kind, r.ip_location, r.said, r.ts, r.likes, r.keyword, r.note_title,
  ]));
}

function notesCsv(rows) {
  return csvText(notesHeader, rows.map((r) => [
    r.title, r.author_name, r.ip_location, r.content, r.topics,
    r.publish_time, r.likes, r.comment_cnt, r.keyword, r.note_url,
  ]));
}

// 把一段文字存成文件让用户下载。
//
// iPhone 上点了会弹出存到文件或者用别的 app 打开，跟手机版的分享是一个意思。
function download(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}
