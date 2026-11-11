/*
 * Tests for transcript-format.js with made-up Speechmatics results in the
 * exact json-v2 format (tests/fixtures/speechmatics/ and the builder).
 *
 *   node tests/transcript-format.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../transcript-format.js');
const B = require('./fixtures/speechmatics-builder.js');

const FIX = path.join(__dirname, 'fixtures', 'speechmatics');
const saved = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n       '));
  }
}

const text = (result, opts = {}) => {
  const r = F.buildTurns(result);
  return F.formatTranscript(r.turns, r.speakers, opts.names || {}, opts.times !== false);
};

/** Every word Speechmatics returned, in the order given. */
function inputWords(result) {
  return result.results.filter((r) => r.type === 'word').map((r) => r.alternatives[0].content);
}
/** Every word in the turns (punctuation stripped). */
function outputWords(turns) {
  return turns.flatMap((t) => t.text.split(/\s+/)).map((w) => w.replace(/^[^\w']+|[^\w'-]+$/g, '').replace(/[.,?!;:]$/, '')).filter(Boolean);
}
function sameWords(result, turns) {
  const a = inputWords(result).slice().sort();
  const b = outputWords(turns).slice().sort();
  assert.deepStrictEqual(b, a, 'every word is kept, none added');
}
/** Rules that hold for every transcript. */
function checkShape(result) {
  const r = F.buildTurns(result);
  r.turns.forEach((t, i) => {
    assert.strictEqual(t.n, i + 1, 'numbered 1, 2, 3, ...');
    if (i) assert.ok(t.start >= r.turns[i - 1].start, 'in order of when each starts');
    assert.ok(t.end >= t.start, 'end after start');
    assert.ok(t.text.trim(), 'no empty turns');
  });
  r.turns.filter((t) => t.overlap).forEach((o) => {
    const main = r.turns.find((t) => !t.overlap && t.speaker !== o.speaker && t.start <= o.start && t.end >= o.end - 0.5);
    assert.ok(main, `overlap turn ${o.n} is said while someone else's turn is still going`);
    assert.ok(o.text.split(/\s+/).length <= F.RULES.overlapMaxWords, 'overlaps are short');
  });
  sameWords(result, r.turns);
  return r;
}

console.log('Transcript format');

test('two speakers: numbered turns with start-to-end times, exactly as in the plan', () => {
  const r = saved('two-speakers');
  assert.strictEqual(text(r), [
    '1. [00:00:05 \u2013 00:00:07] Speaker 1: Good morning. Thanks for coming in today.',
    '2. [00:00:12 \u2013 00:00:13] Speaker 2: Thank you for having me.',
    '3. [00:00:14 \u2013 00:00:19] Speaker 1: So tell me a little about your last job. What did you do there?',
    "4. [00:00:20 \u2013 00:00:25] Speaker 2: I was a nurse at the city hospital for six years, mostly in the children's ward.",
    '5. [00:00:27 \u2013 00:00:27] Speaker 1: Okay.',
    '6. [00:00:29 \u2013 00:00:29] Speaker 2: No.',
    '7. [00:00:30 \u2013 00:00:30] Speaker 1: No?',
    '8. [00:00:31 \u2013 00:00:35] Speaker 2: No, I mean, um, I liked it there, but the hours were long.'
  ].join('\n'));
  checkShape(r);
});

test('two speakers: Show Timestamps off gives the same turns without the times', () => {
  const r = saved('two-speakers');
  const lines = text(r, { times: false }).split('\n');
  assert.strictEqual(lines[0], '1. Speaker 1: Good morning. Thanks for coming in today.');
  assert.strictEqual(lines[6], '7. Speaker 1: No?');
  assert.strictEqual(lines.length, 8);
  lines.forEach((l) => assert.ok(!/\[\d/.test(l), l));
});

test('short words and disfluencies are kept ("Okay", "No", "um", "uh-huh", "mhm")', () => {
  const out = text(saved('two-speakers')) + text(saved('three-speakers')) + text(saved('many-overlaps'));
  for (const w of ['Okay.', 'No.', 'No?', 'um,', 'Uh-huh.', 'Mhm.', 'Yeah.']) assert.ok(out.includes(w), w);
});

test('three speakers: Speaker 1, 2 and 3 in order of first talking', () => {
  const r = saved('three-speakers');
  const out = text(r);
  assert.strictEqual(out.split('\n')[2], '3. [00:00:06 \u2013 00:00:10] Speaker 3: Yes, the budget first, please. I have the numbers from March.');
  assert.strictEqual(out.split('\n')[6], '7. [00:00:20 \u2013 00:00:23] Speaker 1: Uh-huh. We can talk about travel next month.');
  checkShape(r);
});

test('speakers are numbered by who talks first, whatever Speechmatics calls them', () => {
  const r = B.build([
    { speaker: 'S3', at: 1, say: 'I will start.' },
    { speaker: 'S1', at: 4, say: 'Then I go second.' },
    { speaker: 'S2', at: 8, say: 'And I am last.' }
  ]);
  const lines = text(r, { times: false }).split('\n');
  assert.deepStrictEqual(lines, ['1. Speaker 1: I will start.', '2. Speaker 2: Then I go second.', '3. Speaker 3: And I am last.']);
});

test('many short responses while the other person talks: own numbered turns tagged (overlap)', () => {
  const r = saved('many-overlaps');
  const lines = text(r).split('\n');
  assert.match(lines[0], /^1\. \[00:00:01 \u2013 00:00:23\] Speaker 1: So the first thing .* help us and, by then .* late for the party\.$/);
  assert.deepStrictEqual(lines.slice(1, 5), [
    '2. [00:00:05 \u2013 00:00:05] Speaker 2 (overlap): Mhm.',
    '3. [00:00:10 \u2013 00:00:10] Speaker 2 (overlap): Oh no.',
    '4. [00:00:15 \u2013 00:00:15] Speaker 2 (overlap): Uh-huh.',
    '5. [00:00:19 \u2013 00:00:20] Speaker 2 (overlap): Okay.'
  ]);
  assert.strictEqual(lines[5], '6. [00:00:23 \u2013 00:00:25] Speaker 2: That sounds awful. What did you do?');
  assert.strictEqual(lines[6], '7. [00:00:26 \u2013 00:00:32] Speaker 1: We waited. A truck driver stopped and lent me his phone and my sister came to get us.');
  assert.strictEqual(lines[7], '8. [00:00:29 \u2013 00:00:29] Speaker 2 (overlap): Yeah.');
  assert.strictEqual(lines.length, 8);
  checkShape(r);
});

test('a short reply after a question, or after the other person stops, is a normal turn', () => {
  const r = B.build([
    { speaker: 'S1', at: 0, say: 'Did you finish the report on the river?' },
    { speaker: 'S2', at: 3.2, say: 'Yes.' },
    { speaker: 'S1', at: 4, say: 'Good, then we can send it to the office today.' },
    { speaker: 'S2', at: 10, say: 'Okay.' },
    { speaker: 'S1', at: 13, say: 'And after that we can have lunch together.' }
  ]);
  const lines = text(r, { times: false }).split('\n');
  assert.deepStrictEqual(lines, [
    '1. Speaker 1: Did you finish the report on the river?',
    '2. Speaker 2: Yes.',
    '3. Speaker 1: Good, then we can send it to the office today.',
    '4. Speaker 2: Okay.',
    '5. Speaker 1: And after that we can have lunch together.'
  ]);
});

test('three people: two short responses in a row inside one long turn', () => {
  const r = B.build([
    { speaker: 'S1', at: 0, say: 'The new road will go past the school and then turn left at the market' },
    { speaker: 'S2', at: 4.6, say: 'Mhm.' },
    { speaker: 'S3', at: 5.0, say: 'Right.' },
    { speaker: 'S1', at: 5.5, say: 'so the buses will not need to go through the town centre any more.' }
  ]);
  const lines = text(r, { times: false }).split('\n');
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0], /^1\. Speaker 1: The new road .* market so the buses .* any more\.$/);
  assert.strictEqual(lines[1], '2. Speaker 2 (overlap): Mhm.');
  assert.strictEqual(lines[2], '3. Speaker 3 (overlap): Right.');
  checkShape(r);
});

test('a short response at the very start or the very end is a normal turn', () => {
  const r = B.build([
    { speaker: 'S2', at: 0, say: 'Okay.' },
    { speaker: 'S1', at: 0.8, say: 'Let me tell you what happened at the meeting this morning.' },
    { speaker: 'S2', at: 5, say: 'Mhm.' }
  ]);
  const lines = text(r, { times: false }).split('\n');
  assert.deepStrictEqual(lines, [
    '1. Speaker 1: Okay.',
    '2. Speaker 2: Let me tell you what happened at the meeting this morning.',
    '3. Speaker 1: Mhm.'
  ]);
});

test('long silences: start a new turn, times stay true to the recording', () => {
  const r = saved('long-silences');
  assert.strictEqual(text(r), [
    '1. [00:00:42 \u2013 00:00:44] Speaker 1: Is this recording? Okay, I think it is.',
    '2. [00:01:35 \u2013 00:01:37] Speaker 1: Sorry, I had to answer the door.',
    '3. [00:02:40 \u2013 00:02:41] Speaker 2: Are you ready now?',
    '4. [00:02:43 \u2013 00:02:44] Speaker 1: Yes. Let us begin.',
    '5. [00:05:00 \u2013 00:05:01] Speaker 1: That is all for today.'
  ].join('\n'));
  checkShape(r);
});

test('a silence just under the limit keeps one turn; at the limit it splits', () => {
  const at = (gap) => B.build([
    { speaker: 'S1', at: 0, say: 'First part.', each: 0.5 },
    { speaker: 'S1', at: 0.5 * 2 * 0.85 + gap, say: 'Second part.', each: 0.5 }
  ]);
  assert.strictEqual(F.buildTurns(at(F.RULES.silenceSeconds - 0.2)).turns.length, 1);
  assert.strictEqual(F.buildTurns(at(F.RULES.silenceSeconds + 0.2)).turns.length, 2);
});

test('a long talk by one person is split at the end of a sentence after a minute', () => {
  const script = [];
  for (let i = 0; i < 40; i++) script.push({ speaker: 'S1', at: i * 5, say: 'This is sentence number ' + (i + 1) + ' of the talk.' });
  const r = B.build(script);
  const out = checkShape(r);
  assert.ok(out.turns.length >= 3 && out.turns.length <= 4, out.turns.length + ' turns');
  out.turns.forEach((t) => {
    assert.strictEqual(t.speaker, 'S1');
    assert.match(t.text, /\.$/, 'ends at the end of a sentence');
  });
  out.turns.slice(0, -1).forEach((t) => assert.ok(t.end - t.start >= F.RULES.paragraphSeconds - 1));
});

test('a 2-hour result: every word kept, times in hours, fast enough for a phone', () => {
  const r = B.twoHours();
  const started = Date.now();
  const out = checkShape(r);
  const took = Date.now() - started;
  assert.ok(took < 2000, 'took ' + took + ' ms');
  assert.ok(out.turns.length > 800, out.turns.length + ' turns');
  assert.ok(out.turns.filter((t) => t.overlap).length > 100, 'short responses found');
  assert.deepStrictEqual(out.speakers, ['S1', 'S2', 'S3']);
  const all = F.formatTranscript(out.turns, out.speakers, {}, true).split('\n');
  assert.strictEqual(all.length, out.turns.length);
  assert.match(all[all.length - 1], /^\d+\. \[01:5\d:\d\d \u2013 01:5\d:\d\d\] Speaker \d: /);
  all.forEach((l, i) => assert.ok(l.startsWith((i + 1) + '. ['), l));
  console.log(`       ${out.turns.length} turns, ${out.turns.filter((t) => t.overlap).length} overlaps, ${F.countWords(out.turns)} words, built in ${took} ms`);
});

test('renaming a speaker changes every label for that speaker only', () => {
  const r = saved('many-overlaps');
  const out = text(r, { names: { S2: 'Maria' } }).split('\n');
  assert.strictEqual(out.filter((l) => /Maria/.test(l)).length, 6);
  assert.ok(out.every((l) => !/Speaker 2/.test(l)));
  assert.strictEqual(out.filter((l) => /\] Speaker 1:/.test(l)).length, 2);
  assert.strictEqual(out[1], '2. [00:00:05 \u2013 00:00:05] Maria (overlap): Mhm.');
  // A blank name goes back to "Speaker 2".
  assert.strictEqual(text(r, { names: { S2: '  ' } }), text(r));
  const turns = F.buildTurns(r);
  assert.strictEqual(F.nameOf('S2', turns.speakers, { S2: ' Maria ' }), 'Maria');
  assert.strictEqual(F.nameOf('S1', turns.speakers, { S2: 'Maria' }), 'Speaker 1');
});

test('speaker not known (UU) is "Unknown Speaker"; a word with no speaker too', () => {
  const r = B.build([
    { speaker: 'S1', at: 0, say: 'Hello there.' },
    { speaker: 'UU', at: 3, say: 'Excuse me.' },
    { speaker: 'S2', at: 6, say: 'Yes, come in.' }
  ]);
  assert.deepStrictEqual(text(r, { times: false }).split('\n'),
    ['1. Speaker 1: Hello there.', '2. Unknown Speaker: Excuse me.', '3. Speaker 2: Yes, come in.']);
  const out = F.buildTurns(r);
  assert.deepStrictEqual(out.speakers, ['S1', 'S2', 'UU']);
  r.results.filter((x) => x.alternatives[0].speaker === 'S2').forEach((x) => { delete x.alternatives[0].speaker; });
  assert.strictEqual(text(r, { times: false }).split('\n')[1], '2. Unknown Speaker: Excuse me. Yes, come in.');
});

test('punctuation that joins the next word or both words is placed without extra spaces', () => {
  const r = B.build([{ speaker: 'S1', at: 0, say: 'We met at the shop' }]);
  r.results.push({ alternatives: [{ confidence: 1, content: '-', language: 'en', speaker: 'S1' }], attaches_to: 'both', end_time: 1.6, start_time: 1.6, type: 'punctuation' });
  r.results.push({ alternatives: [{ confidence: 1, content: 'cafe', language: 'en', speaker: 'S1' }], end_time: 2, start_time: 1.7, type: 'word' });
  r.results.push({ alternatives: [{ confidence: 1, content: '"', language: 'en', speaker: 'S1' }], attaches_to: 'next', end_time: 2.1, start_time: 2.1, type: 'punctuation' });
  r.results.push({ alternatives: [{ confidence: 1, content: 'today', language: 'en', speaker: 'S1' }], end_time: 2.5, start_time: 2.2, type: 'word' });
  assert.strictEqual(text(r, { times: false }), '1. Speaker 1: We met at the shop-cafe "today');
});

test('no speech: no turns', () => {
  const r = B.build([]);
  const out = F.buildTurns(r);
  assert.deepStrictEqual(out.turns, []);
  assert.strictEqual(F.formatTranscript(out.turns, out.speakers, {}, true), '');
  assert.strictEqual(F.buildTurns({}).turns.length, 0);
});

test('times: always hours, minutes and seconds; whole seconds rounded down', () => {
  assert.strictEqual(F.clock(0), '00:00:00');
  assert.strictEqual(F.clock(5.99), '00:00:05');
  assert.strictEqual(F.clock(3725.2), '01:02:05');
  assert.strictEqual(F.clock(3 * 3600 + 59), '03:00:59');
  assert.strictEqual(F.range({ start: 12.9, end: 12.95 }), '[00:00:12 \u2013 00:00:12]');
});

test('word count counts only what was said', () => {
  const r = F.buildTurns(saved('two-speakers'));
  assert.strictEqual(F.countWords(r.turns), inputWords(saved('two-speakers')).length);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
