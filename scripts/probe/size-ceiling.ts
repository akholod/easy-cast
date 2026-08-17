import { fromResponse, gh, observe, save, upload } from './execute.js';
import { nextRunNumber } from './run.js';
import { checkInterlock } from './interlock.js';

/**
 * What does the endpoint do with a file that is too large?
 *
 * The obvious way to ask is to send a file that is too large. That is the wrong
 * way twice over: it takes as long as the upload takes, and if the guess about
 * the ceiling is wrong it leaves a very large attachment that can never be
 * deleted.
 *
 * So the question is asked in ascending order of cost, and stops at the first
 * answer:
 *
 * 1. **Declared size only.** `size` is a query parameter, so a 5 GiB claim can be
 *    made with a few bytes in the body. If the endpoint checks the declared size
 *    first, this yields the ceiling's response shape for free. If it complains
 *    about the mismatch instead, that is also an answer — about validation order
 *    — and still free.
 * 2. **A real body over the documented figure**, run only if step 1 answers
 *    nothing. GitHub documents 10 MB for images; 12 MB of PNG is comfortably over
 *    it and cheap to send. This is the only step that can create an attachment,
 *    and only if the documented figure is wrong.
 *
 * Step 2 is deliberately not a binary search. One refusal establishes the shape,
 * which is what the classifier needs; the exact byte at which it flips would cost
 * one permanent asset per probe and buy nothing the classifier can use.
 */

const ABSURD_DECLARED_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB, claimed but not sent
const OVER_DOCUMENTED_BYTES = 12 * 1024 * 1024; // 12 MB, over GitHub's documented 10 MB for images

const say = (line: string) => process.stdout.write(`${line}\n`);

/**
 * A PNG header followed by filler. Not a valid image beyond its first bytes —
 * the endpoint has never been observed to decode anything, and a real 12 MB
 * image would take longer to make than the question is worth.
 */
function bigPng(bytes: number): Buffer {
  const header = Buffer.from('89504e470d0a1a0a', 'hex');
  return Buffer.concat([header, Buffer.alloc(bytes - header.length, 0x61)]);
}

async function main(): Promise<number> {
  const verdict = checkInterlock(process.env, process.argv.slice(2));
  if (!verdict.ok) {
    say(`refusing to start:\n  ${verdict.missing.join('\n  ')}`);
    return 2;
  }

  const idResult = await gh(['api', `repos/${verdict.repo}`, '--jq', '.id']);
  if (!idResult.ok) {
    say(`could not read repos/${verdict.repo}: ${idResult.out.slice(0, 200)}`);
    return 1;
  }
  const repositoryId = Number(idResult.out.trim());

  const run = nextRunNumber();
  say(`size-ceiling run #${run} against ${verdict.repo}`);

  // ---- Step 1: declared size only. Cannot create a large asset. ----
  const small = bigPng(64);
  const declared = await upload(
    small,
    'ceiling-declared.png',
    'image/png',
    repositoryId,
    undefined,
    ABSURD_DECLARED_SIZE,
  );
  say(`  declared ${ABSURD_DECLARED_SIZE} bytes, sent ${small.length} -> ${declared.status}`);
  save(
    observe(
      run,
      'size.declared-only',
      'accepted-types',
      `Does the endpoint refuse on the declared size alone? (declared ${ABSURD_DECLARED_SIZE}, sent ${small.length})`,
      'observed',
      fromResponse(declared),
    ),
  );

  if (declared.status === 201) {
    // It accepted a body that does not match its own declared size. That is a
    // finding about validation, and it cost one small permanent attachment.
    say('  ACCEPTED a mismatched size. The declared size is not validated.');
    say('  One small attachment was created and cannot be deleted.');
  }

  // A refusal at step 1 already gives the shape the classifier needs, whether it
  // is about the ceiling or about the mismatch. Sending 12 MB on top would add
  // no row to the table and might add an asset.
  if (declared.status !== null && declared.status !== 201) {
    say('  refused at step 1 — the shape is recorded; step 2 is unnecessary.');
    return 0;
  }

  // ---- Step 2: a real body over the documented figure. May create an asset. ----
  const big = bigPng(OVER_DOCUMENTED_BYTES);
  say(`  sending ${big.length} bytes for real...`);
  const real = await upload(big, 'ceiling-real.png', 'image/png', repositoryId);
  say(`  ${big.length} bytes -> ${real.status}`);
  save(
    observe(
      run,
      'size.over-documented',
      'accepted-types',
      `Is ${OVER_DOCUMENTED_BYTES} bytes — over GitHub's documented 10 MB for images — refused?`,
      'observed',
      fromResponse(real),
    ),
  );

  if (real.status === 201) {
    say('  ACCEPTED. The documented 10 MB is not the endpoint ceiling, and this run');
    say('  created a 12 MB attachment that cannot be deleted.');
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
