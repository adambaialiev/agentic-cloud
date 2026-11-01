/**
 * A knowledge change as a unified patch, so it wears the same card, the same
 * +/− counts and the same colours a code change does rather than being a
 * second kind of diff to learn. Ported from the legacy `diffOps` and
 * `knowledgePatch`; pure, and tested on its own.
 */

export interface DiffOp { op: ' ' | '-' | '+'; text: string }

/**
 * Two texts → one op per line: `' '` kept, `'-'` gone, `'+'` new.
 *
 * The common prefix and suffix are peeled off before anything expensive
 * happens, which is the whole job for the edit these screens actually see —
 * one section added to a page that is otherwise settled. Only the disagreeing
 * middle goes through the LCS table, and past a cell cap even that is given up
 * on and reported as a wholesale replace: a table big enough to align two
 * enormous pages would hang the browser, and a diff nobody can wait for is
 * worse than an honest "all of this changed".
 */
export function diffOps(beforeText: string, afterText: string): DiffOp[] {
  // 1.5M cells ≈ 6 MB of Uint32Array — comfortably more than any page a
  // person writes, and far short of what stalls a phone.
  const CELL_CAP = 1500000;
  const split = (text: string): string[] => (text ? text.replace(/\n$/, '').split('\n') : []);
  const a = split(beforeText);
  const b = split(afterText);
  const ops: DiffOp[] = [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  for (let k = 0; k < head; k += 1) ops.push({ op: ' ', text: a[k]! });
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const m = midA.length;
  const n = midB.length;
  if (m * n > CELL_CAP || m === 0 || n === 0) {
    for (const line of midA) ops.push({ op: '-', text: line });
    for (const line of midB) ops.push({ op: '+', text: line });
  } else {
    // Longest common subsequence, filled from the back so the walk forward can
    // read "which way keeps more lines" out of one lookup.
    const w = n + 1;
    const table = new Uint32Array((m + 1) * w);
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        table[i * w + j] = midA[i] === midB[j]
          ? table[(i + 1) * w + j + 1]! + 1
          : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) { ops.push({ op: ' ', text: midA[i]! }); i += 1; j += 1; }
      else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) { ops.push({ op: '-', text: midA[i]! }); i += 1; }
      else { ops.push({ op: '+', text: midB[j]! }); j += 1; }
    }
    while (i < m) { ops.push({ op: '-', text: midA[i]! }); i += 1; }
    while (j < n) { ops.push({ op: '+', text: midB[j]! }); j += 1; }
  }
  for (let k = a.length - tail; k < a.length; k += 1) ops.push({ op: ' ', text: a[k]! });
  return ops;
}

/**
 * A unified patch for one page, in the exact shape the diff renderer already
 * reads.
 *
 * '' when the two texts are identical: the caller shows nothing rather than an
 * empty card claiming a change.
 *
 * Both sides carry the page's own name even when one of them does not exist
 * yet. Git would write `/dev/null` there, and the diff card is titled from the
 * `b/` side — which would leave a removal labelled `/dev/null`. The card above
 * already says whether this is new, an update or a removal.
 */
export function knowledgePatch(path: string, beforeText: string, afterText: string): string {
  const CONTEXT = 3;
  const ops = diffOps(beforeText, afterText);
  if (!ops.some((op) => op.op !== ' ')) return '';
  // Where each op sits in each side. A line that only exists on one side has
  // no number on the other, and 0 is the value no line ever has.
  let oldNo = 0;
  let newNo = 0;
  const at = ops.map((op) => ({
    old: op.op === '+' ? 0 : (oldNo += 1),
    new: op.op === '-' ? 0 : (newNo += 1),
  }));
  // Runs of change, each with CONTEXT lines around it. Two runs closer than
  // twice that share a hunk, because their context windows already touch.
  const groups: Array<{ start: number; end: number }> = [];
  ops.forEach((op, k) => {
    if (op.op === ' ') return;
    const last = groups[groups.length - 1];
    if (last && k - last.end <= CONTEXT * 2) last.end = k;
    else groups.push({ start: k, end: k });
  });
  const out = [`diff --git a/${path} b/${path}`];
  for (const group of groups) {
    const from = Math.max(0, group.start - CONTEXT);
    const to = Math.min(ops.length - 1, group.end + CONTEXT);
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    for (let k = from; k <= to; k += 1) {
      if (ops[k]!.op !== '+') { if (!oldCount) oldStart = at[k]!.old; oldCount += 1; }
      if (ops[k]!.op !== '-') { if (!newCount) newStart = at[k]!.new; newCount += 1; }
    }
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let k = from; k <= to; k += 1) out.push(ops[k]!.op + ops[k]!.text);
  }
  return out.join('\n');
}
