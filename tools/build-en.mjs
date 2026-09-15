// en/index.html を index.html から生成する。
// 実行: node tools/build-en.mjs
//
// index.html の data-i18n="key" 要素の中身を messages.en[key] で静的に置き換え、
// <head> のメタ情報を英語にし、相対パスを ../ に付け替える。JS を無効にしたブラウザや
// クローラにも英語が見えるようにするための「焼き込み」であり、実行時の data-i18n 置換
// （js/app.js）は en ページでも同じ結果になる（冪等）。
// ロケールは <html data-locale="en"> で伝える（インラインスクリプト不要、CSP と両立）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

await import(pathToFileURL(path.join(root, 'js', 'i18n.js')).href);
const en = globalThis.SQLMeganeI18n.messages.en;

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// 1. <html> タグ
html = html.replace(/<html lang="ja">/, '<html lang="en" data-locale="en">');

// 2. <head> のメタ情報
const headReplacements = [
  [/<title>[^<]*<\/title>/, '<title>SQLMegane — Review SQL before you run it</title>'],
  [/<meta name="description" content="[^"]*">/, '<meta name="description" content="A private, browser-only SQL review tool. Paste an UPDATE, DELETE, or TRUNCATE and read it back as one plain-English sentence before you run it. Flags missing WHERE clauses, full-table changes, and risky JOINs. Nothing leaves your browser.">'],
  [/<link rel="canonical" href="[^"]*">/, '<link rel="canonical" href="https://selene-nyx-ai.github.io/sqlmegane/en/">'],
  [/<meta property="og:url" content="[^"]*">/, '<meta property="og:url" content="https://selene-nyx-ai.github.io/sqlmegane/en/">'],
  [/<meta property="og:site_name" content="[^"]*">/, '<meta property="og:site_name" content="SQLMegane">'],
  [/<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="SQLMegane — Review SQL before you run it">'],
  [/<meta property="og:description" content="[^"]*">/, '<meta property="og:description" content="Read your SQL back as one plain-English sentence and catch missing WHERE clauses, full-table changes, TRUNCATE, and risky JOINs before execution. Everything stays in your browser.">'],
  [/<meta property="og:locale" content="[^"]*">/, '<meta property="og:locale" content="en_US">'],
];
for (const [re, rep] of headReplacements) {
  if (!re.test(html)) throw new Error(`head の置換対象が見つかりません: ${re}`);
  html = html.replace(re, rep);
}

// 3. 相対パス（css / js / 画像）
html = html.replace(/(href|src)="(css|js|img|images)\//g, '$1="../$2/');

// 4. data-i18n 要素の中身を英語に焼き込む
//    <tag ... data-i18n="key" ...>中身</tag> の「中身」を置き換える。同名タグの入れ子は
//    想定しない（index.html にはない）。data-i18n-html="true" の要素は HTML をそのまま入れる。
let replaced = 0;
html = html.replace(
  /<([a-zA-Z0-9]+)([^>]*\sdata-i18n="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/g,
  (whole, tag, attrs, key, inner) => {
    if (!(key in en)) throw new Error(`en に無いキー: ${key}`);
    replaced++;
    // data-i18n-attr="placeholder" のように属性を翻訳する要素は、中身ではなく属性値を置き換える
    const attrTarget = attrs.match(/\sdata-i18n-attr="([^"]+)"/);
    if (attrTarget) {
      const name = attrTarget[1];
      const value = en[key].replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
      const re = new RegExp(`\\s${name}="[^"]*"`);
      if (!re.test(attrs)) throw new Error(`${name} 属性が見つかりません: ${key}`);
      return `<${tag}${attrs.replace(re, ` ${name}="${value}"`)}>${inner}</${tag}>`;
    }
    return `<${tag}${attrs}>${en[key]}</${tag}>`;
  }
);
// aria-label
html = html.replace(/aria-label="[^"]*"([^>]*\sdata-i18n-aria="([^"]+)")/g, (whole, rest, key) => {
  if (!(key in en)) throw new Error(`en に無いキー: ${key}`);
  return `aria-label="${en[key]}"${rest}`;
});
// placeholder / title 属性
html = html.replace(/placeholder="[^"]*"([^>]*\sdata-i18n-placeholder="([^"]+)")/g, (whole, rest, key) => {
  if (!(key in en)) throw new Error(`en に無いキー: ${key}`);
  return `placeholder="${en[key]}"${rest}`;
});

// 5. 言語切替リンク: 日本語ページの "English" リンクを、英語ページでは "日本語" リンクにする
html = html.replace(/<a href="en\/" lang="en" data-i18n="ui.langLink">[^<]*<\/a>/, '<a href="../" lang="ja" data-i18n="ui.langLink">日本語</a>');
if (!html.includes('href="../" lang="ja" data-i18n="ui.langLink"')) throw new Error('言語切替リンクの置換に失敗');

fs.mkdirSync(path.join(root, 'en'), { recursive: true });
fs.writeFileSync(path.join(root, 'en', 'index.html'), html, 'utf8');

const jp = /[぀-ヿ㐀-鿿]/;
const jpLines = html.split('\n').filter((l) => jp.test(l));
console.log(`en/index.html を生成: data-i18n 置換 ${replaced} 箇所、日本語を含む行 ${jpLines.length}`);
for (const l of jpLines) console.log('  JP: ' + l.trim().slice(0, 100));
