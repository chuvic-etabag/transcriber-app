/*
 * Makes made-up Speechmatics batch results in the exact "json-v2" format the
 * real service returns (GET /v2/jobs/{id}/transcript?format=json-v2), from a
 * simple script of who says what and when.
 *
 *   build([{ speaker: 'S1', at: 0.5, say: 'Good morning, how are you?' }, ...], { id, duration })
 *
 * Words get times from `at` onwards (about 0.32 s a word, or `each`). Words
 * ending in . ? ! get a punctuation item with is_eos: true, like the real
 * service. "um", "uh", "er" and "erm" get the disfluency tag.
 *
 *   node tests/fixtures/speechmatics-builder.js   rewrites the saved examples
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DISFLUENCIES = new Set(['um', 'uh', 'er', 'erm', 'hmm', 'mm']);

function round(n) { return Math.round(n * 100) / 100; }

function tokens(text) {
  // "Hello, world!" -> ['Hello', ',', 'world', '!']; keeps "uh-huh" and "don't" as one word.
  return String(text).match(/[A-Za-z0-9'’-]+(?:\.[A-Za-z0-9]+)*|[.,?!;:]/g) || [];
}

function build(script, opts = {}) {
  const results = [];
  let maxEnd = 0;
  for (const line of script) {
    const each = line.each || 0.32;
    let t = line.at;
    let lastEnd = t;
    for (const tok of tokens(line.say)) {
      if (/^[.,?!;:]$/.test(tok)) {
        // Like the real service: punctuation sits at the end of the word before it.
        const item = {
          alternatives: [{ confidence: 1, content: tok, language: 'en', speaker: line.speaker }],
          attaches_to: 'previous',
          end_time: round(lastEnd),
          is_eos: /[.?!]/.test(tok),
          start_time: round(lastEnd),
          type: 'punctuation'
        };
        results.push(item);
        continue;
      }
      const start = t, end = t + each * 0.85;
      const alt = { confidence: 0.98, content: tok, language: 'en', speaker: line.speaker };
      if (DISFLUENCIES.has(tok.toLowerCase())) alt.tags = ['disfluency'];
      results.push({ alternatives: [alt], end_time: round(end), start_time: round(start), type: 'word' });
      lastEnd = end;
      t += each;
      maxEnd = Math.max(maxEnd, end);
    }
  }
  // The real service lists results in time order (punctuation right after its word).
  results.forEach((r, i) => { r._i = i; });
  results.sort((a, b) => a.start_time - b.start_time || (a.type === 'punctuation' ? 1 : 0) - (b.type === 'punctuation' ? 1 : 0) || a._i - b._i);
  results.forEach((r) => { delete r._i; });
  const created = '2026-11-11T02:15:31.523Z';
  return {
    format: '2.9',
    job: {
      created_at: created,
      data_name: opts.dataName || 'recording.ogg',
      duration: Math.ceil(opts.duration || maxEnd),
      id: opts.id || 'r8p6xk2dtw'
    },
    metadata: {
      created_at: created,
      language_pack_info: {
        adapted: false,
        itn: true,
        language_description: 'English',
        word_delimiter: ' ',
        writing_direction: 'left-to-right'
      },
      transcription_config: {
        diarization: 'speaker',
        language: 'en',
        operating_point: 'enhanced'
      },
      type: 'transcription'
    },
    results
  };
}

// ---------- The saved examples ----------

function twoSpeakers() {
  return build([
    { speaker: 'S1', at: 5.1, say: 'Good morning. Thanks for coming in today.' },
    { speaker: 'S2', at: 12.2, say: 'Thank you for having me.' },
    { speaker: 'S1', at: 14.6, say: 'So tell me a little about your last job. What did you do there?' },
    { speaker: 'S2', at: 20.4, say: 'I was a nurse at the city hospital for six years, mostly in the children\'s ward.' },
    { speaker: 'S1', at: 27.5, say: 'Okay.' },
    { speaker: 'S2', at: 29.0, say: 'No.' },
    { speaker: 'S1', at: 30.2, say: 'No?' },
    { speaker: 'S2', at: 31.0, say: 'No, I mean, um, I liked it there, but the hours were long.' }
  ], { id: 'twospkr001', duration: 36 });
}

function threeSpeakers() {
  return build([
    { speaker: 'S1', at: 0.4, say: 'Welcome everyone to the planning meeting.' },
    { speaker: 'S2', at: 3.5, say: 'Thanks. Should we start with the budget?' },
    { speaker: 'S3', at: 6.8, say: 'Yes, the budget first, please. I have the numbers from March.' },
    { speaker: 'S1', at: 11.5, say: 'Go ahead.' },
    { speaker: 'S3', at: 13.0, say: 'We spent about twelve thousand on supplies and four thousand on travel.' },
    { speaker: 'S2', at: 18.0, say: 'That is more than we planned.' },
    { speaker: 'S1', at: 20.5, say: 'Uh-huh. We can talk about travel next month.' }
  ], { id: 'threespk01', duration: 24 });
}

/** Speaker 1 tells a long story; Speaker 2 keeps saying short things while Speaker 1 is talking. */
function manyOverlaps() {
  return build([
    { speaker: 'S1', at: 1.0, say: 'So the first thing that happened was the car broke down on the highway' },
    { speaker: 'S2', at: 5.2, say: 'Mhm.' },
    { speaker: 'S1', at: 5.6, say: 'and we had to wait for almost two hours for someone to come and help us,' },
    { speaker: 'S2', at: 10.0, say: 'Oh no.' },
    { speaker: 'S1', at: 10.6, say: 'and by then the kids were hungry and tired and crying in the back seat' },
    { speaker: 'S2', at: 15.0, say: 'Uh-huh.' },
    { speaker: 'S1', at: 15.4, say: 'and my phone was almost dead, so I could not even call my sister' },
    { speaker: 'S2', at: 19.8, say: 'Okay.' },
    { speaker: 'S1', at: 20.2, say: 'to tell her we would be late for the party.' },
    { speaker: 'S2', at: 23.5, say: 'That sounds awful. What did you do?' },
    { speaker: 'S1', at: 26.0, say: 'We waited. A truck driver stopped and lent me his phone' },
    { speaker: 'S2', at: 29.6, say: 'Yeah.' },
    { speaker: 'S1', at: 30.0, say: 'and my sister came to get us.' }
  ], { id: 'overlaps01', duration: 33 });
}

/** Long silences between and inside turns, and silence at the start and end. */
function longSilences() {
  return build([
    { speaker: 'S1', at: 42.0, say: 'Is this recording? Okay, I think it is.' },
    { speaker: 'S1', at: 95.0, say: 'Sorry, I had to answer the door.' },
    { speaker: 'S2', at: 160.5, say: 'Are you ready now?' },
    { speaker: 'S1', at: 163.0, say: 'Yes. Let us begin.' },
    { speaker: 'S1', at: 300.0, say: 'That is all for today.' }
  ], { id: 'silence001', duration: 420 });
}

const SENTENCES = [
  'We need to look again at the plan for the new school building.',
  'The parents asked whether the classrooms will be ready by June.',
  'I think the roof will take another three weeks, maybe four.',
  'Um, the money for the library is still waiting for approval.',
  'Can you send me the list of teachers who signed up?',
  'The children enjoyed the science fair last Friday.',
  'We should ask the town council for help with the road.',
  'My brother says the rain will stop by the weekend.'
];

/** About 2 hours: three people talking, with short responses and pauses, built the same way every time. */
function twoHours() {
  const script = [];
  let t = 2;
  let n = 0;
  const speakers = ['S1', 'S2', 'S3'];
  while (t < 7200 - 20) {
    const speaker = speakers[n % 3 === 2 ? 2 : n % 2];
    const say = [SENTENCES[n % 8], SENTENCES[(n * 3 + 1) % 8], SENTENCES[(n * 5 + 2) % 8]].slice(0, 1 + (n % 3)).join(' ');
    script.push({ speaker, at: t, say });
    const words = say.split(' ').length;
    // Every fourth turn someone else says "Mhm." in the middle.
    if (n % 4 === 1 && words > 12) {
      const other = speakers[(speakers.indexOf(speaker) + 1) % 3];
      script.push({ speaker: other, at: t + 0.32 * 6 + 0.05, say: 'Mhm.' });
    }
    t += words * 0.32 + 1.2 + (n % 25 === 24 ? 30 : 0);  // now and then a long pause
    n++;
  }
  // Short responses push the main speaker's later words along; rebuild so times never go backwards.
  return build(script, { id: 'twohours01', duration: 7200 });
}

module.exports = { build, twoSpeakers, threeSpeakers, manyOverlaps, longSilences, twoHours };

if (require.main === module) {
  const dir = path.join(__dirname, 'speechmatics');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, fn] of Object.entries({ 'two-speakers': twoSpeakers, 'three-speakers': threeSpeakers,
    'many-overlaps': manyOverlaps, 'long-silences': longSilences })) {
    fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(fn(), null, 2) + '\n');
  }
  console.log('Saved examples in ' + dir);
}
