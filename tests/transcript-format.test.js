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

// ---------- Show Fillers ----------

console.log('Show Fillers');

const ALWAYS = ['mhm', 'm-hm', 'mm-hmm', 'uh-huh', 'mm', 'uh-uh', 'huh-uh', 'aha', 'uh-oh', 'huh', 'aw'];
const HIDDEN = ['um', 'umm', 'uhm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'hm'];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
/** The turns as "Speaker N: text" lines in the view asked for (no times). */
const view = (script, showFillers) => {
  const r = F.buildTurns(B.build(script));
  return F.formatTranscript(r.turns, r.speakers, {}, false, showFillers).split('\n').filter(Boolean);
};

test('the two lists are exactly the ones in the plan', () => {
  assert.deepStrictEqual(F.ALWAYS_SHOWN, ALWAYS);
  assert.deepStrictEqual(F.HESITATIONS, HIDDEN);
  assert.ok(!ALWAYS.some((w) => HIDDEN.includes(w)), 'no word is on both lists');
});

test('every hesitation on the list is hidden, in any spelling of capitals and with any punctuation', () => {
  for (const w of HIDDEN) {
    for (const form of [w, cap(w), w.toUpperCase(), w + ',', cap(w) + '.', w + '...', '"' + w + '"', w + '?', w + ' —']) {
      assert.strictEqual(F.hideFillers(form).replace(/[^A-Za-z]/g, ''), '', JSON.stringify(form));
      const inside = F.hideFillers('I think ' + form + ' we can go');
      assert.ok(!new RegExp('\\b' + w + '\\b', 'i').test(inside), JSON.stringify(form) + ' -> ' + inside);
      assert.ok(/I think/.test(inside) && /we can go/i.test(inside), inside);
    }
  }
});

test('every always-shown sound stays, in any spelling of capitals and with any punctuation', () => {
  for (const w of ALWAYS) {
    for (const form of [w, cap(w), w.toUpperCase(), w + '.', cap(w) + ',', w + '?', cap(w) + '!', '"' + cap(w) + '."']) {
      assert.strictEqual(F.hideFillers(form), form, JSON.stringify(form));
      assert.strictEqual(F.hideFillers('Um, ' + form + ' um'), form.replace(/^(["“]?)([a-z])/, (m, q, c) => q + c.toUpperCase()), 'next to hesitations: ' + form);
      // Said twice, both stay: they are never treated as a repeated word.
      assert.strictEqual(F.hideFillers(form + ' ' + form), form + ' ' + form);
    }
  }
});

test('yes and no sounds that contain a hesitation are not touched ("uh-huh" is not "uh")', () => {
  for (const t of ['Uh-huh.', 'Uh-uh.', 'Uh-oh.', 'Huh-uh.', 'Mm-hmm.', 'M-hm.', 'Uh‑huh.', 'Uh–huh.']) {
    assert.strictEqual(F.hideFillers(t), t, t);
  }
  // Written as two words, they are still one sound and stay whole.
  for (const t of ['Uh huh.', 'Mm hmm.', 'Uh oh.', 'Uh uh.', 'Huh uh.', 'M hm.', 'uh huh, yeah']) {
    assert.strictEqual(F.hideFillers(t), t, t);
  }
  // But two hesitations in a row (with a comma between) are hesitations.
  assert.strictEqual(F.hideFillers('Uh, uh, I think so.'), 'I think so.');
  assert.strictEqual(F.hideFillers('Uh, huh?'), 'Huh?');
});

test('words that merely look similar are never hidden', () => {
  for (const t of ['The umbrella is here.', 'Ah-ha, I see.', 'Her error was small.', 'Uhuru Park.', 'Hmmm.', 'Ahh.', 'Erm-like.',
    'An ahi tuna bowl.', 'Umm-hm.', 'He hummed a hymn.', 'Mmm.', 'Oh.', 'Okay.', 'Yeah.', 'No.']) {
    assert.strictEqual(F.hideFillers(t), t, t);
  }
});

test('back-to-back repeated words become one', () => {
  const cases = [
    ['I I I think', 'I think'],
    ['I, I, I think so.', 'I think so.'],
    ['The the cat sat on on the mat.', 'The cat sat on the mat.'],
    ['We we went to to to the the shop.', 'We went to the shop.'],
    ['It was was, you know, fine.', 'It was, you know, fine.'],
    ['I, um, I think', 'I think'],                      // a hesitation between the repeats
    ['the THE The end', 'the end'],                     // whatever the capitals
    ["It's it's fine.", "It's fine."],
    // Not repeats: a new sentence, different words, numbers.
    ['It was good. Good food.', 'It was good. Good food.'],
    ['I did. Did you?', 'I did. Did you?'],
    ['Call 5 5 5 1 2 3 4.', 'Call 5 5 5 1 2 3 4.'],
    ['I think I think so', 'I think I think so'],       // repeated phrases are left alone (only single words)
    ['their there', 'their there']
  ];
  for (const [from, to] of cases) assert.strictEqual(F.hideFillers(from), to, from);
});

test('punctuation and capital letters are tidied where a hesitation was', () => {
  const cases = [
    ['Um, so we went home.', 'So we went home.'],
    ['um, so we went home.', 'so we went home.'],
    ['And, um, I think that, uh, we should go.', 'And I think that we should go.'],
    ['I went to the, um. Then we left.', 'I went to the. Then we left.'],
    ['Is it, uh?', 'Is it?'],
    ['We left. Um, then it rained.', 'We left. Then it rained.'],
    ['We left. Um. Then it rained.', 'We left. Then it rained.'],
    ['Well uh I guess so', 'Well I guess so'],
    ['Ah, okay.', 'Okay.'],
    ['Er, no.', 'No.'],
    ['Hmm, mhm.', 'Mhm.'],
    ['So, yes.', 'So, yes.']                             // commas that were not around a hesitation stay
  ];
  for (const [from, to] of cases) assert.strictEqual(F.hideFillers(from), to, from);
  assert.strictEqual(F.hideFillers(''), '');
  assert.strictEqual(F.hideFillers(null), '');
});

test('switch on: nothing is changed at all', () => {
  for (const name of ['two-speakers', 'three-speakers', 'many-overlaps', 'long-silences']) {
    const r = F.buildTurns(saved(name));
    assert.strictEqual(F.formatTranscript(r.turns, r.speakers, {}, true, true), F.formatTranscript(r.turns, r.speakers, {}, true), name);
    assert.deepStrictEqual(F.visibleTurns(r.turns, true).map((t) => [t.n, t.text]), r.turns.map((t) => [t.n, t.text]), name);
  }
});

test('transcript 1 (mixed): hesitation-only turns disappear and the numbers close up; yes sounds stay', () => {
  const script = [
    { speaker: 'S1', at: 0.5, say: 'Um, so I I wanted to ask about the, uh, schedule for next week.' },
    { speaker: 'S2', at: 2.0, say: 'Mhm.' },                       // said over speaker 1: an overlap turn
    { speaker: 'S2', at: 7.0, say: 'Um.' },                        // only a hesitation
    { speaker: 'S1', at: 8.0, say: 'Is Monday okay?' },
    { speaker: 'S2', at: 10.0, say: 'Uh-huh.' },                   // only a yes sound
    { speaker: 'S1', at: 11.0, say: 'Hmm.' },                      // only a hesitation, said while speaker 2 goes on
    { speaker: 'S2', at: 12.0, say: 'Er, Tuesday is is better, um, I think.' },
    { speaker: 'S1', at: 16.0, say: 'Uh-uh.' },                    // only a no sound
    { speaker: 'S2', at: 17.0, say: 'Uh, erm.' },                  // only hesitations
    { speaker: 'S1', at: 18.5, say: 'Huh?' }
  ];
  const on = view(script, true);
  const off = view(script, false);
  assert.deepStrictEqual(on, [
    '1. Speaker 1: Um, so I I wanted to ask about the, uh, schedule for next week.',
    '2. Speaker 2 (overlap): Mhm.',
    '3. Speaker 2: Um.',
    '4. Speaker 1: Is Monday okay?',
    '5. Speaker 2: Uh-huh. Er, Tuesday is is better, um, I think.',
    '6. Speaker 1 (overlap): Hmm.',
    '7. Speaker 1: Uh-uh.',
    '8. Speaker 2: Uh, erm.',
    '9. Speaker 1: Huh?'
  ]);
  // Off: turns 3, 6 and 8 (only hesitations) are gone and the numbers close up.
  assert.deepStrictEqual(off, [
    '1. Speaker 1: So I wanted to ask about the schedule for next week.',
    '2. Speaker 2 (overlap): Mhm.',
    '3. Speaker 1: Is Monday okay?',
    '4. Speaker 2: Uh-huh. Tuesday is better I think.',
    '5. Speaker 1: Uh-uh.',
    '6. Speaker 1: Huh?'
  ]);
  // Back on: every turn is back, numbered as before. Nothing was deleted.
  assert.deepStrictEqual(view(script, true), on);
});

test('transcript 2 (only hesitations): with the switch off there is nothing to show', () => {
  const script = [
    { speaker: 'S1', at: 0.5, say: 'Um.' }, { speaker: 'S2', at: 2, say: 'Uh, er.' }, { speaker: 'S1', at: 4, say: 'Hmm, hm.' },
    { speaker: 'S2', at: 6, say: 'Erm, uhm, ah.' }, { speaker: 'S1', at: 9, say: 'Umm, uhh.' }
  ];
  assert.strictEqual(view(script, true).length, 5);
  assert.deepStrictEqual(view(script, false), []);
  const r = F.buildTurns(B.build(script));
  assert.strictEqual(F.countWords(F.visibleTurns(r.turns, false)), 0);
  assert.strictEqual(F.countWords(F.visibleTurns(r.turns, true)), 10);
});

test('transcript 3 (only yes and no sounds): every turn stays as its own numbered turn, switch on or off', () => {
  const script = ALWAYS.map((w, i) => ({ speaker: i % 2 ? 'S2' : 'S1', at: 1 + i * 2, say: cap(w) + '.' }));
  const on = view(script, true);
  assert.strictEqual(on.length, ALWAYS.length);
  assert.deepStrictEqual(view(script, false), on);
  on.forEach((line, i) => assert.ok(line.startsWith(`${i + 1}. Speaker ${i % 2 ? 2 : 1}: ${cap(ALWAYS[i])}.`), line));
});

test('transcript 4: Speechmatics tags some yes sounds as disfluencies; the tag is ignored, the lists decide', () => {
  const script = [
    { speaker: 'S1', at: 0.5, say: 'Do you want, um, tea?' },
    { speaker: 'S2', at: 3, say: 'Mm.' },                          // the builder tags "mm" as a disfluency, like Speechmatics can
    { speaker: 'S1', at: 5, say: 'Sugar?' },
    { speaker: 'S2', at: 7, say: 'Hmm, uh-uh.' }
  ];
  const result = B.build(script);
  const tagged = result.results.filter((x) => (x.alternatives[0].tags || []).includes('disfluency')).map((x) => x.alternatives[0].content.toLowerCase());
  assert.ok(tagged.includes('mm') && tagged.includes('um'), 'the made-up result has the tag on a yes sound: ' + tagged);
  // Also tag every word of the last turn, as if Speechmatics called "uh-uh" a disfluency.
  result.results.forEach((x) => { if (/uh-uh/i.test(x.alternatives[0].content)) x.alternatives[0].tags = ['disfluency']; });
  const r = F.buildTurns(result);
  assert.deepStrictEqual(F.formatTranscript(r.turns, r.speakers, {}, false, false).split('\n'), [
    '1. Speaker 1: Do you want tea?',
    '2. Speaker 2: Mm.',
    '3. Speaker 1: Sugar?',
    '4. Speaker 2: Uh-uh.'
  ]);
});

test('transcript 5: an overlap made only of a hesitation disappears; the turn it interrupted stays one turn', () => {
  const script = [
    { speaker: 'S1', at: 0.5, say: 'So the plan is to leave early and and drive straight there without stopping at all.' },
    { speaker: 'S2', at: 2.2, say: 'Um.' },
    { speaker: 'S2', at: 4.0, say: 'Aha.' },
    { speaker: 'S1', at: 8.0, say: 'Aw, uh, that is a shame.' }
  ];
  assert.deepStrictEqual(view(script, true), [
    '1. Speaker 1: So the plan is to leave early and and drive straight there without stopping at all. Aw, uh, that is a shame.',
    '2. Speaker 2 (overlap): Um.',
    '3. Speaker 2 (overlap): Aha.'
  ]);
  assert.deepStrictEqual(view(script, false), [
    '1. Speaker 1: So the plan is to leave early and drive straight there without stopping at all. Aw that is a shame.',
    '2. Speaker 2 (overlap): Aha.'
  ]);
});

test('the view keeps each turn\'s place in the saved list, times, speaker and overlap mark', () => {
  const r = F.buildTurns(B.build([
    { speaker: 'S1', at: 1, say: 'Um.' }, { speaker: 'S2', at: 3, say: 'Hello there.' }, { speaker: 'S1', at: 6, say: 'Uh, hi.' }
  ]));
  const shown = F.visibleTurns(r.turns, false);
  assert.deepStrictEqual(shown.map((t) => [t.n, t.index, t.text, t.speaker]), [[1, 1, 'Hello there.', 'S2'], [2, 2, 'Hi.', 'S1']]);
  assert.strictEqual(shown[0].start, r.turns[1].start);
  assert.strictEqual(r.turns[0].text, 'Um.', 'the saved turns are untouched');
  assert.strictEqual(r.turns[2].text, 'Uh, hi.');
});

test('with times showing, Copy text follows the same view', () => {
  const r = F.buildTurns(B.build([{ speaker: 'S1', at: 5, say: 'Um.' }, { speaker: 'S2', at: 65, say: 'Uh, we we can start.' }]));
  assert.strictEqual(F.formatTranscript(r.turns, r.speakers, { S2: 'Teacher' }, true, false), '1. [00:01:05 – 00:01:06] Teacher: We can start.');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
