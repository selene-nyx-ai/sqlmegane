// js/vendor/ 配下の node-sql-parser 同梱ファイルを生成するスクリプト。
//
// 実行方法:
//   npm install --no-save node-sql-parser
//   node tools/build-vendor.mjs
//
// なぜラップが必要か:
//   node-sql-parser の UMD ビルドは、CommonJS でも AMD でもない場合に
//   「エクスポートされた各キーをグローバルへ直接代入する」実装になっている
//   （`for (var n in e) global[n] = e[n]` 相当）。つまり <script> で読み込むと
//   window.Parser が定義される。方言別バンドルを3つ読み込むと 3つとも
//   window.Parser を上書きし合い、最後に読み込んだ方言しか残らない。
//
//   そこで、元のUMDコードを一切書き換えずに「module / exports がローカル変数として
//   見えるIIFE」で包む。UMD側は CommonJS 環境だと判断して module.exports に
//   代入するため、グローバルは汚れず、こちらで方言名付きの名前空間
//   globalThis.SQLMeganeVendor[dialect] に登録できる。
//
// 生成物は js/vendor/ にコミットして配布する（実行時のCDN読み込みは行わない）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'node_modules', 'node-sql-parser', 'umd');
const outDir = path.join(root, 'js', 'vendor');

const DIALECTS = ['mysql', 'postgresql', 'transactsql'];

if (!fs.existsSync(srcDir)) {
  console.error('node_modules/node-sql-parser が見つかりません。先に `npm install --no-save node-sql-parser` を実行してください。');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'node-sql-parser', 'package.json'), 'utf8'));

fs.mkdirSync(outDir, { recursive: true });

for (const dialect of DIALECTS) {
  const src = fs.readFileSync(path.join(srcDir, `${dialect}.umd.js`), 'utf8')
    // .map ファイルは同梱しないので、参照コメントを削除しておく（DevTools で404にしないため）
    .replace(/\/\/# sourceMappingURL=.*\s*$/, '');

  const header = `/*!
 * node-sql-parser ${pkg.version} (${dialect} dialect) - Apache-2.0
 * https://github.com/taozhi8833998/node-sql-parser
 *
 * SQLMegane が同梱しているサードパーティ製ライブラリです。ライセンス全文は
 * js/vendor/LICENSE-node-sql-parser を参照してください。
 * 下記のIIFEラッパー以外、上流のUMDビルドを一切改変していません
 * （ラップの理由は tools/build-vendor.mjs のコメントを参照）。
 * このファイルは tools/build-vendor.mjs によって自動生成されています。
 */
;(function (globalScope) {
  var module = { exports: {} };
  var exports = module.exports;
  /* ===== node-sql-parser (${dialect}) ここから ===== */
`;

  const footer = `
  /* ===== node-sql-parser (${dialect}) ここまで ===== */
  var vendor = globalScope.SQLMeganeVendor || (globalScope.SQLMeganeVendor = {});
  vendor[${JSON.stringify(dialect)}] = module.exports;
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;

  const outPath = path.join(outDir, `node-sql-parser-${dialect}.js`);
  fs.writeFileSync(outPath, header + src + footer, 'utf8');
  console.log(`generated ${path.relative(root, outPath)} (${(header.length + src.length + footer.length) / 1024 | 0} KB)`);
}

const licenseSrc = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
  .map((f) => path.join(root, 'node_modules', 'node-sql-parser', f))
  .find((f) => fs.existsSync(f));

if (licenseSrc) {
  fs.copyFileSync(licenseSrc, path.join(outDir, 'LICENSE-node-sql-parser'));
  console.log('copied LICENSE-node-sql-parser');
} else {
  console.warn('node-sql-parser の LICENSE ファイルが見つかりませんでした。js/vendor/LICENSE-node-sql-parser を手動で確認してください。');
}
