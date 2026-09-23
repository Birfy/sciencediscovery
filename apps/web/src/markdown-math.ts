// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Escape every single `$` that cannot delimit inline math under Pandoc's rule, so remark-math
 * only sees real formulas. remark-math pairs any two dollars, which turns a shell line
 * (`for i in $(seq 1 9); do echo $i; done`) or prices (`$5 and $10`) into garbled math.
 *
 * Pandoc's rule: the opening `$` is followed by a non-space character; the closing `$` is
 * preceded by a non-space character and not followed by a digit; the formula stays within
 * its paragraph. `$$…$$`, already escaped dollars, fenced code and inline code are left as
 * they are.
 */
export function escapeNonMathDollars(markdown: string): string {
  if (!markdown.includes("$")) return markdown;
  const out: string[] = [];
  let fence: string | undefined;
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(escapeProse(prose.join("\n")));
    prose = [];
  };
  for (const line of markdown.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    } else if (marker) {
      flush();
      fence = marker;
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n");
}

/** Escape the stray dollars of text with no fenced code in it; inline code spans are kept whole. */
function escapeProse(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      result += text.slice(index, index + 2);
      index += 2;
    } else if (char === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const end = text.indexOf(run, index + run.length);
      const stop = end < 0 ? index + run.length : end + run.length;
      result += text.slice(index, stop);
      index = stop;
    } else if (char !== "$") {
      result += char;
      index += 1;
    } else if (text[index + 1] === "$") {
      // Display math: keep everything up to the closing `$$`.
      const end = text.indexOf("$$", index + 2);
      const stop = end < 0 ? index + 2 : end + 2;
      result += text.slice(index, stop);
      index = stop;
    } else {
      const close = inlineMathEnd(text, index);
      if (close < 0) {
        result += "\\$";
        index += 1;
      } else {
        result += text.slice(index, close + 1);
        index = close + 1;
      }
    }
  }
  return result;
}

/** The index of the `$` that closes inline math opened at `open`, or -1 when none may. */
function inlineMathEnd(text: string, open: number): number {
  const first = text[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") {
      index += 1;
    } else if (char === "\n" && text[index + 1] === "\n") {
      return -1;
    } else if (char === "$") {
      if (text[index + 1] === "$") return -1;
      if (!/\s/.test(text[index - 1]!) && !/\d/.test(text[index + 1] ?? "")) return index;
    }
  }
  return -1;
}
