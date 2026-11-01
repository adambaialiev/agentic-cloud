import { describe, expect, it } from 'vitest';
import {
  applyCodexPatchToText,
  listCodexPatchPaths,
  parseCodexPatch,
  planCodexPatchApplication,
} from '../../agent/codex-patch.js';

describe('codex-patch', () => {
  it('parses Codex-style add, update, move, and delete operations', () => {
    const operations = parseCodexPatch([
      '*** Begin Patch',
      '*** Add File: count_r.py',
      '+print("hello")',
      '*** Update File: src/app.ts',
      '*** Move to: src/version.ts',
      '@@ replace version',
      '-const version = 1;',
      '+const version = 2;',
      '*** Delete File: src/old.ts',
      '*** End Patch',
    ].join('\n'));

    expect(listCodexPatchPaths(operations)).toEqual([
      'count_r.py',
      'src/app.ts',
      'src/old.ts',
      'src/version.ts',
    ]);
    expect(operations[1]).toMatchObject({
      kind: 'update',
      path: 'src/app.ts',
      moveTo: 'src/version.ts',
    });
    expect(operations[2]).toEqual({
      kind: 'delete',
      path: 'src/old.ts',
    });
  });

  it('applies context-based updates to existing file text', () => {
    const operations = parseCodexPatch([
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@ insert log',
      ' const version = 1;',
      '+console.log(version);',
      ' export { version };',
      '*** End Patch',
    ].join('\n'));

    const update = operations[0];
    expect(update?.kind).toBe('update');
    if (!update || update.kind !== 'update') {
      throw new Error('Expected update operation');
    }

    expect(applyCodexPatchToText(
      'const version = 1;\nexport { version };\n',
      update.chunks,
    )).toBe('const version = 1;\nconsole.log(version);\nexport { version };\n');
  });

  it('unwraps a fenced patch block before parsing', () => {
    const operations = parseCodexPatch([
      '```diff',
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-const version = 1;',
      '+const version = 2;',
      '*** End Patch',
      '```',
    ].join('\n'));

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      kind: 'update',
      path: 'src/app.ts',
    });
  });

  it('ignores unified diff metadata lines inside a Codex update block', () => {
    const operations = parseCodexPatch([
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-const version = 1;',
      '+const version = 2;',
      '*** End Patch',
    ].join('\n'));

    const update = operations[0];
    expect(update?.kind).toBe('update');
    if (!update || update.kind !== 'update') {
      throw new Error('Expected update operation');
    }

    expect(update.chunks).toHaveLength(1);
    expect(update.chunks[0]?.header).toBe('-1 +1 @@');
    expect(applyCodexPatchToText('const version = 1;\n', update.chunks)).toBe('const version = 2;\n');
  });

  it('accepts a redundant bare hunk header before a unified diff header', () => {
    const operations = parseCodexPatch([
      '*** Begin Patch',
      '*** Update File: src/payments/build-payment-preview.js',
      '@@',
      '@@ -2,7 +2,7 @@',
      ' ',
      ' export function buildPaymentPreview(order, summary = buildCheckoutSummary(order)) {',
      '   const walletCreditCents = order.walletBalanceCents ?? 0;',
      '-  const chargeNowCents = Math.max(0, summary.totalBeforeCreditCents - walletCreditCents);',
      '+  const chargeNowCents = Math.max(0, summary.amountDueCents);',
      ' ',
      '   return {',
      '*** End Patch',
    ].join('\n'));

    const update = operations[0];
    expect(update?.kind).toBe('update');
    if (!update || update.kind !== 'update') {
      throw new Error('Expected update operation');
    }

    expect(update.chunks).toHaveLength(1);
    expect(update.chunks[0]?.header).toBe('-2,7 +2,7 @@');
    expect(applyCodexPatchToText(
      [
        "import { buildCheckoutSummary } from '../checkout/build-checkout-summary.js';",
        '',
        'export function buildPaymentPreview(order, summary = buildCheckoutSummary(order)) {',
        '  const walletCreditCents = order.walletBalanceCents ?? 0;',
        '  const chargeNowCents = Math.max(0, summary.totalBeforeCreditCents - walletCreditCents);',
        '',
        '  return {',
        '    lineItemTotalCents: summary.discountedMerchandiseSubtotalCents + summary.giftWrapCents,',
        '  };',
        '}',
      ].join('\n') + '\n',
      update.chunks,
    )).toContain('  const chargeNowCents = Math.max(0, summary.amountDueCents);');
  });

  it('ignores the standard no-newline marker inside update hunks', () => {
    const operations = parseCodexPatch([
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@ -1 +1 @@',
      '-const version = 1;',
      '+const version = 2;',
      '\\ No newline at end of file',
      '*** End Patch',
    ].join('\n'));

    const update = operations[0];
    expect(update?.kind).toBe('update');
    if (!update || update.kind !== 'update') {
      throw new Error('Expected update operation');
    }

    expect(update.chunks[0]?.endOfFile).toBe(true);
    expect(applyCodexPatchToText('const version = 1;', update.chunks)).toBe('const version = 2;');
  });

  it('treats an unprefixed blank hunk line as blank context', () => {
    const operations = parseCodexPatch([
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      ' export function render() {',
      '-  return "old";',
      '+  return "new";',
      '',
      ' }',
      '*** End Patch',
    ].join('\n'));

    const update = operations[0];
    expect(update?.kind).toBe('update');
    if (!update || update.kind !== 'update') {
      throw new Error('Expected update operation');
    }

    expect(applyCodexPatchToText(
      [
        'export function render() {',
        '  return "old";',
        '',
        '}',
      ].join('\n') + '\n',
      update.chunks,
    )).toBe([
      'export function render() {',
      '  return "new";',
      '',
      '}',
      '',
    ].join('\n'));
  });

  it('reports the closest matching lines when an update chunk does not match exactly', () => {
    const operations = parseCodexPatch([
      '*** Begin Patch',
      '*** Update File: src/checkout/build-checkout-summary.js',
      '@@',
      '-    totalBeforeCreditCents: discountedMerchandiseSubtotalCents + giftWrapCents + shippingCents + taxCents,',
      '-  const wallet = applyWalletCredit({',
      '-    totalBeforeCreditCents: discountedMerchandiseSubtotalCents + giftWrapCents + taxCents,',
      '-    walletBalanceCents: order.walletBalanceCents ?? 0,',
      '-  });',
      '+  const totalBeforeCreditCents = discountedMerchandiseSubtotalCents + giftWrapCents + shippingCents + taxCents;',
      '+  const wallet = applyWalletCredit({',
      '+    totalBeforeCreditCents,',
      '+    walletBalanceCents: order.walletBalanceCents ?? 0,',
      '+  });',
      '*** End Patch',
    ].join('\n'));

    const update = operations[0];
    expect(update?.kind).toBe('update');
    if (!update || update.kind !== 'update') {
      throw new Error('Expected update operation');
    }

    try {
      applyCodexPatchToText([
        '  const totalBeforeCreditCents = discountedMerchandiseSubtotalCents + giftWrapCents + shippingCents + taxCents;',
        '  const wallet = applyWalletCredit({',
        '    totalBeforeCreditCents: discountedMerchandiseSubtotalCents + giftWrapCents + taxCents,',
        '    walletBalanceCents: order.walletBalanceCents ?? 0,',
        '  });',
      ].join('\n') + '\n', update.chunks);

      throw new Error('Expected patch application to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('Failed to locate patch chunk in target file.');
      expect(message).toContain('Closest match starts at line 1 with 4/5 exact lines matched.');
      expect(message).toContain(
        'First differing line expected "    totalBeforeCreditCents: discountedMerchandiseSubtotalCents + giftWrapCents + shippingCents + taxCents,"',
      );
      expect(message).toContain(
        'but found "  const totalBeforeCreditCents = discountedMerchandiseSubtotalCents + giftWrapCents + shippingCents + taxCents;"',
      );
      expect(message).toContain('1 |   const totalBeforeCreditCents = discountedMerchandiseSubtotalCents + giftWrapCents + shippingCents + taxCents;');
    }
  });

  it('plans writes and deletes for add, update, move, and delete operations', () => {
    const operations = parseCodexPatch([
      '*** Begin Patch',
      '*** Add File: count_r.py',
      '+text = "asdferervv"',
      '+',
      '+count = text.count("r")',
      '+print(count)',
      '*** Update File: src/app.ts',
      '*** Move to: src/version.ts',
      '@@',
      '-const version = 1;',
      '+const version = 2;',
      '*** Delete File: src/old.ts',
      '*** End Patch',
    ].join('\n'));

    const plan = planCodexPatchApplication(operations, {
      'count_r.py': { kind: 'missing' },
      'src/app.ts': { kind: 'file', content: 'const version = 1;\n', mode: 0o755 },
      'src/version.ts': { kind: 'missing' },
      'src/old.ts': { kind: 'file', content: 'export const old = true;\n', mode: 0o644 },
    });

    expect(plan.deletes).toEqual([
      'src/app.ts',
      'src/old.ts',
    ]);
    expect(plan.writes).toEqual([
      {
        path: 'count_r.py',
        content: 'text = "asdferervv"\n\ncount = text.count("r")\nprint(count)\n',
        mode: 0o644,
      },
      {
        path: 'src/version.ts',
        content: 'const version = 2;\n',
        mode: 0o755,
      },
    ]);
  });

  it('rejects adding a file that already exists', () => {
    const operations = parseCodexPatch([
      '*** Begin Patch',
      '*** Add File: count_r.py',
      '+print("hello")',
      '*** End Patch',
    ].join('\n'));

    expect(() => planCodexPatchApplication(operations, {
      'count_r.py': { kind: 'file', content: 'print("old")\n', mode: 0o644 },
    })).toThrow('Cannot add "count_r.py": path already exists as file.');
  });

  it('gives a corrective error when add-file lines are missing the plus prefix', () => {
    expect(() => parseCodexPatch([
      '*** Begin Patch',
      '*** Add File: count_r.py',
      'print("hello")',
      '*** End Patch',
    ].join('\n'))).toThrow('Prefix each file-content line with "+"');
  });
});
