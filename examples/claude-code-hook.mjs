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

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }) + '\n');
}

const NOTE = '（この判定は SQLMegane の実装済みルールと、このフックが取り出せた SQL の範囲に限られ、通過しても安全を保証するものではありません）';

function main() {
  if (!DIALECTS.includes(DIALECT) || !SEVERITIES.includes(FAIL_ON)) {
    emit('ask', `フックの環境変数が不正です（SQLMEGANE_DIALECT=${DIALECT}, SQLMEGANE_FAIL_ON=${FAIL_ON}）。設定を直すまで SQL は人が確認してください。`);
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
  const errors = [];
  for (const sql of sqls) {
    const r = analyze(sql);
    if (r.error || r.status === null) errors.push(`SQLMegane の CLI を実行できませんでした（${r.error ? r.error.message : 'timeout'}）。`);
    else if (r.status === 2) { const lines = describe(r.stdout); problems.push(lines.length ? lines.join('\n') : '（指摘の詳細を取り出せませんでした）'); }
    else if (r.status !== 0) errors.push(`SQLMegane が終了コード ${r.status} で終了しました: ${(r.stderr || '').trim().slice(0, 300)}`);
  }
  if (problems.length) {
    emit('deny',
      `SQLMegane が実行前の SQL に【${FAIL_ON === 'danger' ? '危険' : FAIL_ON === 'warning' ? '警告' : '情報'}】以上の指摘を見つけたため、この呼び出しを止めました。` +
      `内容を見直してから、必要なら人が実行してください。\n${problems.join('\n')}\n${NOTE}`);
  } else if (errors.length) {
    emit('ask', `${errors.join('\n')}\nSQL を人が確認してください。`);
  }
}

main();
