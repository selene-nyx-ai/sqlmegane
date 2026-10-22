#!/usr/bin/env node
// Claude Code の PreToolUse フックから SQLMegane の CLI を呼び、
// Bash / MCP ツールの入力から取り出せた SQL に、設定した重大度以上の指摘があれば、そのツール呼び出しを拒否する例。
// 本番・開発の接続先は区別しない。SQL の抽出と検出ルールには制限があり、すべての SQL 実行を監視するものではない。
//
// 設定（~/.claude/settings.json または <プロジェクト>/.claude/settings.json）:
//   {
//     "hooks": {
//       "PreToolUse": [
//         { "matcher": "Bash|mcp__.*",
//           "hooks": [ { "type": "command", "command": "node", "args": ["/absolute/path/to/sqlmegane/examples/claude-code-hook.mjs"], "onFailure": "block" } ] }
//       ]
//     }
//   }
//   （"onFailure": "block" はフック自体が起動できない・タイムアウトした時にも呼び出しを止める設定。対応していない版では外す）
//
// 環境変数:
//   SQLMEGANE_DIALECT  auto|generic|mysql|postgres|mssql|oracle（既定 auto）
//   SQLMEGANE_FAIL_ON  danger|warning|info（既定 danger）
//   SQLMEGANE_ASK_WIDE_WHERE  on|off（既定 on）: 閾値未満でも、WHERE を「列 = 値」「列 IN (値, ...)」と AND・括弧の組み合わせとして
//                      判定できない UPDATE / DELETE を permissionDecision "ask"（人が確認）に回す。
//                      `WHERE id > 0` や `WHERE id IS NOT NULL` のように構文上は「常に真」でなくても全行が対象になり得る文を、
//                      黙って通さないための分岐（2026-10-22、公開記事のコメントで指摘を受けて追加）。
//                      対象行数や安全性を判定するものではなく、対応する限られた構文だけを追加確認なしで通す。
//                      列参照と判定できない式（CURRENT_DATE 等）や、方言・引用規則で解釈が変わる条件（mysql の "..."）、
//                      一部の数値・識別子表記（`(1)`、引用符なしの非 ASCII 列名など）も "ask" 側になる
//
// このフックが SQL を取り出せる形:
//   1. Bash ツール: psql / mysql / mariadb / sqlcmd / sqlplus を呼ぶ「単純な 1 コマンド」のうち、
//      `-c "SQL"` / `--command="SQL"` / `-e "SQL"` / `--execute="SQL"` / `-Q "SQL"` の引数、
//      ヒアドキュメント（`psql ... <<'EOF'` ... `EOF`）、`< ファイル` のリダイレクト（cwd 基準で読む）
//   2. MCP ツール（tool_name が mcp__ で始まる）: tool_input の `sql` / `query` / `statement` / `statements` の文字列、または文字列の配列
// 次は「対応外」として permissionDecision "ask"（人が確認）を返す: 複合コマンド（; && || | 改行）、変数・コマンド置換（$VAR $(...) `...`）、
// 引用符の連結、`cd` を含むもの、引用符なしのヒアドキュメント内の `$`、読めない入力ファイル。
// 次は見えないので何も判定せず exit 0 で通常の許可フローに渡す: DB クライアント名を含まない Bash コマンド、`-f ファイル`・パイプ入力、
// アプリやスクリプト内部で組み立てられる SQL、PowerShell ツール、MCP 入力のネストしたオブジェクト内の SQL。
// **フックを通過しても、SQL を検査できたことや安全性を意味しない**。検出できるのは SQLMegane の実装済みルール（README「検出ルール一覧」）だけ。
// deny / ask の理由文は Claude Code（エージェント）に渡る。この例は呼び出し間の状態を保持せず、再試行そのものは制御しない。
// 運用では CLAUDE.md 等に「deny または ask が返ったら、SQL を書き換えて再試行せず、人に確認する」と明記する。
// ただし、その指示だけで再試行を確実に防げるわけではない。
//
// このスクリプト自体にはネットワーク送信処理が無く、解析は同じマシンの CLI で行う。ただし指摘文・エラー文は Claude Code に返すので、
// SQL 由来の識別子・条件値やローカルパスが Claude Code 側で記録・送信される可能性はある。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'sqlmegane.mjs');
const DIALECTS = ['auto', 'generic', 'mysql', 'postgres', 'mssql', 'oracle'];
const SEVERITIES = ['danger', 'warning', 'info'];
const DIALECT = process.env.SQLMEGANE_DIALECT || 'auto';
const FAIL_ON = process.env.SQLMEGANE_FAIL_ON || 'danger';
const ASK_WIDE_WHERE = process.env.SQLMEGANE_ASK_WIDE_WHERE || 'on';
const CLIENT_RE = /\b(psql|mysql|mariadb|sqlcmd|sqlplus)\b/;
const SQL_FLAGS_SHORT = ['-c', '-e', '-Q'];
const SQL_FLAGS_LONG = ['--command', '--execute'];

class Unsupported extends Error {}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// 単純な 1 コマンドを、シェルの引用規則に沿って単語に分ける。対応外の構文は Unsupported を投げる。
// 返り値: 単語の配列 [{ text, quoted, attached, op }]（`<` は op:true の単語）
// `-c"SQL"` / `--command="SQL"` のように、引用符の直前が SQL オプション名そのものなら連結を許す
function isFlagPrefix(cur) {
  return !cur.quoted && cur.parts === 2 && (SQL_FLAGS_SHORT.includes(cur.text) || SQL_FLAGS_LONG.some((f) => cur.text === f + '='));
}

function splitSimpleCommand(cmd) {
  const words = [];
  let i = 0;
  let cur = null; // { text, quoted（全体が引用符）, attached（-c"SQL" の形）, parts（連結数）}
  const push = () => { if (cur) { words.push(cur); cur = null; } };
  const begin = () => { if (!cur) cur = { text: '', quoted: false, parts: 0 }; };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'") {
      begin(); if (cur.parts++ > 0 && !isFlagPrefix(cur)) throw new Unsupported('引用符の連結');
      if (cur.parts === 1) cur.quoted = true; else cur.attached = true;
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) throw new Unsupported('閉じていない引用符');
      cur.text += cmd.slice(i + 1, j); i = j + 1; continue;
    }
    if (ch === '"') {
      begin(); if (cur.parts++ > 0 && !isFlagPrefix(cur)) throw new Unsupported('引用符の連結');
      if (cur.parts === 1) cur.quoted = true; else cur.attached = true;
      let j = i + 1;
      for (;;) {
        if (j >= cmd.length) throw new Unsupported('閉じていない引用符');
        const c = cmd[j];
        if (c === '"') break;
        if (c === '$' || c === '`') throw new Unsupported('変数・コマンド置換');
        if (c === '\\' && j + 1 < cmd.length && '$`"\\\n'.includes(cmd[j + 1])) { cur.text += cmd[j + 1]; j += 2; continue; }
        cur.text += c; j++;
      }
      i = j + 1; continue;
    }
    if (/\s/.test(ch)) { if (ch === '\n') throw new Unsupported('複数行のコマンド'); push(); i++; continue; }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')' || ch === '>') throw new Unsupported('複合コマンド・リダイレクト');
    if (ch === '$' || ch === '`') throw new Unsupported('変数・コマンド置換');
    if (ch === '\\') { begin(); if (i + 1 < cmd.length) { cur.text += cmd[i + 1]; i += 2; } else i++; continue; }
    if (ch === '<') { if (cmd[i + 1] === '<') throw new Unsupported('ヒアドキュメントの位置'); push(); words.push({ text: '<', quoted: false, op: true, parts: 0 }); i++; continue; }
    begin(); if (cur.parts === 0) cur.parts = 1; else if (cur.quoted) throw new Unsupported('引用符の連結');
    cur.text += ch; i++;
  }
  push();
  return words;
}

// Bash コマンド文字列から SQL を集める。見えない形は []、対応外は Unsupported。
function sqlFromBash(command, cwd) {
  if (!CLIENT_RE.test(command)) return [];
  const found = [];
  let head = command;
  // ヒアドキュメント: 1 コマンドの末尾にある <<EOF / <<'EOF' / <<-EOF だけ対応
  const here = /<<(-?)\s*(['"]?)(\w+)\2[ \t]*\n([\s\S]*?)\n[ \t]*\3[ \t]*\n?$/.exec(command);
  if (here) {
    head = command.slice(0, here.index);
    let body = here[4];
    if (here[1] === '-') body = body.replace(/^\t+/gm, '');
    if (here[2] === '' && /[$`]/.test(body)) throw new Unsupported('引用符なしのヒアドキュメント内の変数・コマンド置換');
    if (body.trim()) found.push(body);
  } else if (command.includes('<<')) {
    throw new Unsupported('ヒアドキュメントの形');
  }
  const words = splitSimpleCommand(head);
  if (words.length === 0 || !CLIENT_RE.test(words[0].text) || words[0].quoted) throw new Unsupported('先頭が DB クライアントでないコマンド');
  if (words.some((w) => w.text === 'cd')) throw new Unsupported('cd を含むコマンド');
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    if (w.op && w.text === '<') {
      const p = words[k + 1];
      if (!p || p.op) throw new Unsupported('リダイレクト先が無い');
      const abs = path.isAbsolute(p.text) ? p.text : path.join(cwd || process.cwd(), p.text);
      let body;
      try { body = fs.readFileSync(abs, 'utf8'); } catch { throw new Unsupported(`入力ファイルを読めない: ${p.text}`); }
      if (body.trim()) found.push(body);
      k++; continue;
    }
    if (w.quoted) continue; // 引用された単語はオプション名として扱わない
    const flags = [...SQL_FLAGS_LONG.map((f) => [f, f + '=']), ...SQL_FLAGS_SHORT.map((f) => [f, f])];
    for (const [f, prefix] of flags) {
      if (w.text === f) { const v = words[k + 1]; if (v && !v.op && v.text.trim()) found.push(v.text); k++; break; }
      if (w.text.length > prefix.length && w.text.startsWith(prefix) && (w.attached || prefix.endsWith('='))) {
        const v = w.text.slice(prefix.length); if (v.trim()) found.push(v); break;
      }
    }
  }
  return found;
}

function sqlFromMcp(toolInput) {
  const found = [];
  if (!toolInput || typeof toolInput !== 'object') return found;
  for (const key of ['sql', 'query', 'statement', 'statements']) {
    const v = toolInput[key];
    if (typeof v === 'string' && v.trim()) found.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) found.push(x);
  }
  return found;
}

function analyze(sql) {
  return spawnSync(process.execPath, [CLI, '--json', '--dialect', DIALECT, '--fail-on', FAIL_ON, '-'], {
    input: sql, encoding: 'utf8', timeout: 20000,
  });
}

// 閾値以上の指摘だけを 1 行ずつにする（JSON が壊れていれば []）
function describe(json) {
  const lines = [];
  let data;
  try { data = JSON.parse(json); } catch { return lines; }
  if (!data || typeof data !== 'object') return lines;
  const limit = SEVERITIES.indexOf(FAIL_ON);
  const hit = (f) => f && typeof f === 'object' && SEVERITIES.indexOf(f.severity) >= 0 && SEVERITIES.indexOf(f.severity) <= limit;
  for (const f of Array.isArray(data.globalFindings) ? data.globalFindings : []) if (hit(f)) lines.push(`- ${f.title}: ${f.message}`);
  for (const st of Array.isArray(data.statements) ? data.statements : []) {
    for (const f of Array.isArray(st.findings) ? st.findings : []) if (hit(f)) lines.push(`- #${st.number} ${st.kind}: ${f.title}: ${f.message}`);
  }
  return lines;
}

// --- 対象範囲をこのフックで確認できるかの構文判定（UPDATE / DELETE） ---
// CLI の JSON にある verifySelect（`SELECT COUNT(*) FROM ... WHERE <条件>;`。条件は CLI が空白を整えたもので原文そのままではない）から
// 最初の WHERE 以降を文字列として取り出し（引用符や括弧の深さは見ない簡易抽出）、
// 「<列> = <値>」「<列> IN (<値>, ...)」を AND でつないだ形（括弧は可）だけで構成されているかを調べる。
// 値は文字列・数値・TRUE/FALSE・NULL・バインド変数（? :name $1 @name）。列と列の比較、OR / NOT、< > <> !=、LIKE、IS、BETWEEN、
// 副問い合わせ、関数呼び出し、認識できない表記は「確認できない」として false。スキーマは見ないので、
// 等価条件でも実際の行数が多いことはある（例: `WHERE status = 'active'`）。
function whereFromVerifySelect(verifySelect) {
  if (typeof verifySelect !== 'string') return null;
  const body = verifySelect.replace(/^\s*--.*$/gm, '').trim();
  const m = /\bWHERE\b([\s\S]*?);?\s*$/i.exec(body);
  return m ? m[1].trim() : '';
}

// 括弧なしで値を返す特殊な語（列名として受け取らない。方言ごとの一覧ではなく、よく使われるものだけ）
const NOT_A_COLUMN = new Set(['AND', 'OR', 'NOT', 'IN', 'IS', 'LIKE', 'BETWEEN', 'NULL', 'TRUE', 'FALSE', 'SELECT', 'EXISTS', 'CASE', 'DEFAULT',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP', 'CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER', 'USER',
  'SYSDATE', 'SYSTIMESTAMP', 'NOW', 'UTC_DATE', 'UTC_TIME', 'UTC_TIMESTAMP', 'CURRENT_ROLE', 'CURRENT_CATALOG', 'CURRENT_SCHEMA']);
const MAX_DEPTH = 32;

function tokenizeWhere(text) {
  const re = /\s+|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\b|[A-Za-z_][\w$#]*|:\w+|\$\d+|@[A-Za-z_]\w*|\?|\(|\)|,|=|\./gy;
  const tokens = [];
  let last = 0;
  for (let m; (m = re.exec(text)) !== null;) {
    if (m.index !== last) return null; // 認識できない文字（<, >, !, 演算子など）
    last = re.lastIndex;
    if (!/^\s+$/.test(m[0])) tokens.push(m[0]);
    if (last === text.length) break;
  }
  if (last !== text.length) return null;
  return tokens;
}

// dialect は CLI の JSON の dialect（mysql では "..." が ANSI_QUOTES 無効時に文字列になるため、二重引用符の識別子を受け取らない）
function isEqualityOnlyWhere(text, dialect) {
  const tokens = tokenizeWhere(text);
  if (!tokens || tokens.length === 0) return false;
  let i = 0;
  let depth = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const upper = (t) => (t === undefined ? '' : t.toUpperCase());
  const isWord = (t) => typeof t === 'string' && /^[A-Za-z_][\w$#]*$/.test(t) && !NOT_A_COLUMN.has(t.toUpperCase());
  const quotedIdentRe = dialect === 'mysql' ? /^(`.*`)$/s : /^(".*"|`.*`|\[.*\])$/s;
  const isQuotedIdent = (t) => typeof t === 'string' && quotedIdentRe.test(t);
  const isLiteral = (t) => typeof t === 'string' && (/^'(?:[^']|'')*'$/s.test(t) || /^[+-]?[\d.]/.test(t) || ['TRUE', 'FALSE', 'NULL'].includes(t.toUpperCase()) || /^(:\w+|\$\d+|@[A-Za-z_]\w*|\?)$/.test(t));
  const ident = () => {
    if (!(isWord(peek()) || isQuotedIdent(peek()))) return false;
    next();
    while (peek() === '.') { next(); if (!(isWord(peek()) || isQuotedIdent(peek()))) return false; next(); }
    return true;
  };
  const term = () => {
    if (peek() === '(') { if (++depth > MAX_DEPTH) return false; next(); if (!expr()) return false; if (next() !== ')') return false; depth--; return true; }
    if (!ident()) return false;
    if (peek() === '=') { next(); if (!isLiteral(peek())) return false; next(); return true; }
    if (upper(peek()) === 'IN') {
      next(); if (next() !== '(') return false;
      if (!isLiteral(peek())) return false; next();
      while (peek() === ',') { next(); if (!isLiteral(peek())) return false; next(); }
      return next() === ')';
    }
    return false;
  };
  const expr = () => {
    if (!term()) return false;
    while (upper(peek()) === 'AND') { next(); if (!term()) return false; }
    return true;
  };
  return expr() && i === tokens.length;
}

// 閾値未満でも人の確認に回す UPDATE / DELETE を 1 件ずつにする。
// 「対象範囲をこのフックでは確認できない」文を集める（等価条件なら対象が狭いという判定ではない）
function wideDml(json) {
  const lines = [];
  let data;
  try { data = JSON.parse(json); } catch { return lines; }
  if (!data || typeof data !== 'object') return lines;
  for (const st of Array.isArray(data.statements) ? data.statements : []) {
    if (!['UPDATE', 'DELETE'].includes(st.kind)) continue;
    let ok;
    try {
      const where = whereFromVerifySelect(st.verifySelect);
      if (where === '') continue; // WHERE なしは CLI 側の【危険】指摘（no-where-*）が deny にする
      ok = where !== null && isEqualityOnlyWhere(where, data.dialect);
    } catch { ok = false; } // 判定処理の例外も ask に集約する
    if (!ok) {
      lines.push(
        `- #${st.number} ${st.kind}: このフックでは対象範囲を確認できませんでした。SQL を書き換えて再試行せず、人に確認してください。` +
        (typeof st.verifySelect === 'string'
          ? `\n  件数確認用の参考 SELECT（元の SQL の条件と一致するか確認してから使ってください）:\n  ${st.verifySelect.trim().replace(/\n/g, '\n  ')}`
          : ''),
      );
    }
  }
  return lines;
}

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }) + '\n');
}

const NOTE = '（この判定は SQLMegane の実装済みルールと、このフックが取り出せた SQL の範囲に限られ、通過しても安全を保証するものではありません）';

function main() {
  if (!DIALECTS.includes(DIALECT) || !SEVERITIES.includes(FAIL_ON) || !['on', 'off'].includes(ASK_WIDE_WHERE)) {
    emit('ask', `フックの環境変数が不正です（SQLMEGANE_DIALECT=${DIALECT}, SQLMEGANE_FAIL_ON=${FAIL_ON}, SQLMEGANE_ASK_WIDE_WHERE=${ASK_WIDE_WHERE}）。設定を直すまで SQL は人が確認してください。`);
    return;
  }
  let input;
  try { input = JSON.parse(readStdin()); } catch { return; } // 入力が読めないときは判定しない（"onFailure": "block" でも止まらない分岐）
  if (!input || typeof input !== 'object') return;
  if (input.hook_event_name && input.hook_event_name !== 'PreToolUse') return;
  const toolName = String(input.tool_name || '');
  let sqls = [];
  try {
    if (toolName === 'Bash') sqls = sqlFromBash(String((input.tool_input || {}).command || ''), input.cwd);
    else if (toolName.startsWith('mcp__')) sqls = sqlFromMcp(input.tool_input);
  } catch (err) {
    if (err instanceof Unsupported) {
      emit('ask', `DB クライアントを呼ぶコマンドですが、このフックが対応していないシェルの形（${err.message}）のため SQL を取り出せませんでした。SQL を人が確認してください。`);
      return;
    }
    throw err;
  }
  if (sqls.length === 0) return; // SQL が見えない呼び出しは通常の許可フローへ

  const problems = [];
  const wide = [];
  const errors = [];
  for (const sql of sqls) {
    const r = analyze(sql);
    if (r.error || r.status === null) errors.push(`SQLMegane の CLI を実行できませんでした（${r.error ? r.error.message : 'timeout'}）。`);
    else if (r.status === 2) { const lines = describe(r.stdout); problems.push(lines.length ? lines.join('\n') : '（指摘の詳細を取り出せませんでした）'); }
    else if (r.status !== 0) errors.push(`SQLMegane が終了コード ${r.status} で終了しました: ${(r.stderr || '').trim().slice(0, 300)}`);
    else if (ASK_WIDE_WHERE === 'on') wide.push(...wideDml(r.stdout));
  }
  if (problems.length) {
    emit('deny',
      `SQLMegane が実行前の SQL に【${FAIL_ON === 'danger' ? '危険' : FAIL_ON === 'warning' ? '警告' : '情報'}】以上の指摘を見つけたため、この呼び出しを止めました。` +
      `SQL を書き換えて再試行せず、人に確認してください。\n${problems.join('\n')}\n${NOTE}`);
  } else if (wide.length || errors.length) {
    const parts = [];
    if (wide.length) {
      parts.push('このフックでは UPDATE / DELETE の対象範囲を確認できませんでした。SQL を書き換えて再試行せず、' +
        '元の SQL・対象データ・接続先を人が確認して実行の可否を判断してください。\n' + wide.join('\n'));
    }
    if (errors.length) parts.push(errors.join('\n') + '\nSQL を人が確認してください。');
    emit('ask', `${parts.join('\n')}\n${NOTE}`);
  }
}

main();
