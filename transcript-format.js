/*
 * transcript-format.js — Turns a Speechmatics result (format "json-v2") into
 * numbered speaker turns, and turns those into text.
 *
 *   1. [00:00:05 – 00:00:11] Speaker 1: Good morning, how are you?
 *   2. [00:00:12 – 00:00:30] Speaker 2: I'm fine. I wanted to ask about...
 *   3. [00:00:17 – 00:00:17] Speaker 1 (overlap): Mhm.
 *
 * Rules (the same for every transcript):
 * - A turn is one speaker talking. It ends when someone else talks or after
 *   a long silence (RULES.silenceSeconds). Very long turns are split at the
 *   end of a sentence once they pass RULES.paragraphSeconds, so a long
 *   lecture is not one giant paragraph.
 * - A short response (RULES.overlapMaxWords words or fewer, lasting no more
 *   than RULES.overlapMaxSeconds) said while the other person is still
 *   talking becomes its own turn at the moment it was said, tagged
 *   "(overlap)". The other person's turn carries on as one turn around it.
 *   "Still talking" means they pick up again within RULES.overlapMaxGap
 *   seconds, had not just asked a question, and one side of it is more than
 *   a short response itself.
 * - Turns are numbered in order of when each starts.
 * - Speakers are numbered in order of when they first talk: Speaker 1,
 *   Speaker 2, and so on. Speechmatics' "UU" (speaker not known) is shown
 *   as "Unknown Speaker".
 * - Every word Speechmatics returns is kept, including "mhm", "uh-huh" and
 *   other disfluencies.
 * - Show Fillers (see "Fillers" below): with the switch off, hesitations
 *   ("um", "uh", ...) and back-to-back repeated words are left out of the
 *   view. Sounds that carry meaning ("mhm", "uh-huh", ...) are always shown.
 *   Nothing is deleted: the saved turns keep every word.
 *
 * Exposes window.TranscriptFormat (and module.exports for the Node tests).
 */
(function (global) {
  'use strict';

  var RULES = {
    silenceSeconds: 5,      // a pause this long starts a new turn, even for the same speaker
    paragraphSeconds: 60,   // a turn this long is split at the next end of a sentence
    overlapMaxWords: 4,     // a short response has at most this many words...
    overlapMaxSeconds: 3,   // ...and lasts at most this long
    overlapMaxGap: 1        // the main speaker stops and picks up again within this many seconds
  };

  var UNKNOWN = 'UU';

  // ---------- Time ----------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 5 -> "00:00:05", 3725.9 -> "01:02:05" (always hours, minutes and seconds). */
  function clock(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    var h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  /** "[00:00:05 – 00:00:11]" (an en dash with a space either side). */
  function range(turn) {
    var start = Math.floor(turn.start), end = Math.max(start, Math.floor(turn.end));
    return '[' + clock(start) + ' – ' + clock(end) + ']';
  }

  // ---------- Reading the Speechmatics result ----------

  var SENTENCE_END = /[.?!]["'”’)]*$/;

  /** The latest word by this speaker among the last few (when two people talk at once). */
  function lastWordOf(words, speaker) {
    for (var k = words.length - 1; k >= 0 && k >= words.length - 4; k--) {
      if (!speaker || words[k].speaker === speaker) return words[k];
    }
    return words[words.length - 1];
  }

  /**
   * The words in time order, with punctuation joined on:
   * [{ text, start, end, speaker, noSpaceBefore, eos }]
   */
  function readWords(result) {
    var items = (result && result.results) || [];
    var words = [];
    var pendingPrefix = '';
    var joinNext = false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var alt = item && item.alternatives && item.alternatives[0];
      if (!alt || typeof alt.content !== 'string') continue;
      var content = alt.content;
      if (item.type === 'word') {
        if (!content) continue;
        var start = Number(item.start_time) || 0;
        var end = Math.max(start, Number(item.end_time) || start);
        words.push({
          text: pendingPrefix + content,
          start: start,
          end: end,
          speaker: alt.speaker || UNKNOWN,
          noSpaceBefore: joinNext,
          eos: false
        });
        pendingPrefix = '';
        joinNext = false;
      } else if (item.type === 'punctuation') {
        var attach = item.attaches_to || 'previous';
        var last = lastWordOf(words, alt.speaker);
        if (attach === 'next' || (!last && attach !== 'none')) {
          pendingPrefix += content;
        } else if (last) {
          last.text += (attach === 'none' ? ' ' : '') + content;
          if (item.is_eos || SENTENCE_END.test(content)) last.eos = true;
          if (attach === 'both') joinNext = true;
        }
      }
      // Other types (entities, speaker changes) carry no extra words.
    }
    // Speechmatics already sends words in time order; keep it that way for safety.
    words.forEach(function (w, n) { w.index = n; });
    words.sort(function (a, b) { return a.start - b.start || a.index - b.index; });
    return words;
  }

  // ---------- Building turns ----------

  function wordCount(run) { return run.words.length; }

  function isShort(run) {
    return wordCount(run) <= RULES.overlapMaxWords && run.end - run.start <= RULES.overlapMaxSeconds;
  }

  function endsWithQuestion(run) {
    var last = run.words[run.words.length - 1];
    return /\?["'”’)]*$/.test(last.text);
  }

  /** Consecutive words by the same speaker with no long silence between them. */
  function speakerRuns(words) {
    var runs = [];
    var run = null;
    words.forEach(function (w) {
      if (run && run.speaker === w.speaker && w.start - run.end < RULES.silenceSeconds) {
        run.words.push(w);
        run.end = Math.max(run.end, w.end);
      } else {
        run = { speaker: w.speaker, words: [w], start: w.start, end: w.end };
        runs.push(run);
      }
    });
    return runs;
  }

  /**
   * Starting at runs[i], is there a group of short responses by other people
   * that the main speaker talks through? Returns the index of the run where
   * the main speaker picks up again, or -1.
   */
  function talksThrough(main, runs, i) {
    if (endsWithQuestion(main)) return -1;
    var j = i;
    var lastEnd = main.end;
    // A short question ("No?") asks for an answer, so it is a turn of its own.
    while (j < runs.length && runs[j].speaker !== main.speaker && isShort(runs[j]) && !endsWithQuestion(runs[j]) &&
           runs[j].start - lastEnd <= RULES.overlapMaxGap) {
      lastEnd = Math.max(lastEnd, runs[j].end);
      j++;
    }
    if (j === i || j >= runs.length) return -1;
    var resume = runs[j];
    if (resume.speaker !== main.speaker) return -1;
    if (resume.start - lastEnd > RULES.overlapMaxGap) return -1;
    if (resume.start - main.end >= RULES.silenceSeconds) return -1;
    // Someone answering a short word with a short word is a normal exchange.
    if (isShort(main) && isShort(resume)) return -1;
    return j;
  }

  /** Split a long turn at the end of a sentence once it passes RULES.paragraphSeconds. */
  function splitLong(turn) {
    var parts = [];
    var current = [];
    turn.words.forEach(function (w, k) {
      current.push(w);
      var more = k < turn.words.length - 1;
      if (more && w.eos && w.end - current[0].start >= RULES.paragraphSeconds) {
        parts.push(current);
        current = [];
      }
    });
    if (current.length) parts.push(current);
    return parts.map(function (words) {
      return { speaker: turn.speaker, words: words, overlap: false };
    });
  }

  function joinWords(words) {
    var text = '';
    words.forEach(function (w) {
      text += (text && !w.noSpaceBefore ? ' ' : '') + w.text;
    });
    return text;
  }

  function finish(turn) {
    var start = Infinity, end = 0;
    turn.words.forEach(function (w) {
      if (w.start < start) start = w.start;
      if (w.end > end) end = w.end;
    });
    return {
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      speaker: turn.speaker,
      overlap: Boolean(turn.overlap),
      text: joinWords(turn.words)
    };
  }

  /**
   * Build the numbered turns from a Speechmatics json-v2 result.
   * Returns { turns: [{ n, start, end, speaker, overlap, text }], speakers: ['S1', ...], duration }.
   */
  function buildTurns(result) {
    var words = readWords(result);
    var runs = speakerRuns(words);
    var mains = [];
    var overlaps = [];
    var i = 0;
    while (i < runs.length) {
      var main = { speaker: runs[i].speaker, words: runs[i].words.slice(), start: runs[i].start, end: runs[i].end };
      i++;
      var latest = {};   // this turn's latest short response by each person
      for (;;) {
        var j = talksThrough(main, runs, i);
        if (j === -1) break;
        for (var k = i; k < j; k++) {
          var run = runs[k];
          var before = latest[run.speaker];
          // Words of one short response that the main speaker's words landed in the middle of
          // ("Oh ... no") stay together as one response.
          if (before && run.start - before.end <= RULES.overlapMaxGap &&
              before.words.length + run.words.length <= RULES.overlapMaxWords) {
            before.words = before.words.concat(run.words);
            before.end = Math.max(before.end, run.end);
          } else {
            latest[run.speaker] = { speaker: run.speaker, words: run.words.slice(), end: run.end, overlap: true };
            overlaps.push(latest[run.speaker]);
          }
        }
        main.words = main.words.concat(runs[j].words);
        main.end = Math.max(main.end, runs[j].end);
        i = j + 1;
      }
      mains.push(main);
    }

    var turns = [];
    mains.forEach(function (m) { splitLong(m).forEach(function (t) { turns.push(finish(t)); }); });
    overlaps.forEach(function (o) { turns.push(finish(o)); });
    // In order of when each turn starts; at the same moment the main turn comes first.
    turns.sort(function (a, b) { return a.start - b.start || (a.overlap ? 1 : 0) - (b.overlap ? 1 : 0); });
    turns.forEach(function (t, n) { t.n = n + 1; });

    var speakers = [];
    turns.forEach(function (t) {
      if (t.speaker !== UNKNOWN && speakers.indexOf(t.speaker) === -1) speakers.push(t.speaker);
    });
    turns.forEach(function (t) { if (t.speaker === UNKNOWN && speakers.indexOf(UNKNOWN) === -1) speakers.push(UNKNOWN); });

    var duration = Number(result && result.job && result.job.duration) || 0;
    if (words.length) duration = Math.max(duration, words[words.length - 1].end);
    return { turns: turns, speakers: speakers, duration: duration };
  }

  // ---------- Names and text ----------

  /** The default label for each speaker: "Speaker 1", "Speaker 2", ... in order of first talking. */
  function defaultNames(speakers) {
    var names = {};
    var n = 0;
    speakers.forEach(function (s) {
      names[s] = s === UNKNOWN ? 'Unknown Speaker' : 'Speaker ' + (++n);
    });
    return names;
  }

  /** The label shown for a speaker: their new name if renamed, otherwise "Speaker N". */
  function nameOf(speaker, speakers, renamed) {
    var custom = renamed && renamed[speaker];
    if (custom && String(custom).trim()) return String(custom).trim();
    return defaultNames(speakers)[speaker] || 'Unknown Speaker';
  }

  // ---------- Fillers ----------

  // Always shown, whatever the switch says, because they carry meaning (yes, no, surprise...).
  var ALWAYS_SHOWN = ['mhm', 'm-hm', 'mm-hmm', 'uh-huh', 'mm', 'uh-uh', 'huh-uh', 'aha', 'uh-oh', 'huh', 'aw'];
  // Hidden when Show Fillers is off: hesitations only.
  var HESITATIONS = ['um', 'umm', 'uhm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'hm'];

  function listSet(list) {
    var set = Object.create(null);
    list.forEach(function (w) { set[w] = true; });
    return set;
  }
  var ALWAYS = listSet(ALWAYS_SHOWN);
  var HIDDEN = listSet(HESITATIONS);

  var EDGE_START = /^[^\p{L}\p{N}]+/u;
  var EDGE_END = /[^\p{L}\p{N}]+$/u;
  var ENDS_SENTENCE = /[.?!…]/;

  /** One written word split into the punctuation before it, the word, and the punctuation after it. */
  function parseToken(raw) {
    var lead = (raw.match(EDGE_START) || [''])[0];
    var rest = raw.slice(lead.length);
    var trail = (rest.match(EDGE_END) || [''])[0];
    var core = rest.slice(0, rest.length - trail.length);
    // The word as it is checked against the lists: lower case, any kind of hyphen as "-".
    var key = core.toLowerCase().replace(/[\u2010-\u2015\u2212]/g, '-');
    return { lead: lead, core: core, trail: trail, key: key, kept: false };
  }

  function capitalised(word) {
    return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  }

  /**
   * The text of a turn with hesitations and back-to-back repeated words left out.
   * Every word is checked against the two lists above (Speechmatics' own
   * "disfluency" label is not used: it also marks some yes and no sounds).
   *
   *   "Um, I I I think, uh, we should go."  ->  "I think we should go."
   *   "Mhm."                                ->  "Mhm."   (always shown)
   *   "Um."                                 ->  ""       (the turn disappears)
   */
  function hideFillers(text) {
    var tokens = String(text || '').split(/\s+/).filter(Boolean).map(parseToken);
    var i;
    // A yes or no sound written as two words ("uh huh", "mm hmm", "uh oh") is kept whole.
    for (i = 0; i + 1 < tokens.length; i++) {
      if (!tokens[i].trail && !tokens[i + 1].lead && ALWAYS[tokens[i].key + '-' + tokens[i + 1].key]) {
        tokens[i].kept = tokens[i + 1].kept = true;
      }
    }

    // 1. Leave out the hesitations, tidying the punctuation around them.
    var out = [];
    var capitaliseNext = false;
    tokens.forEach(function (tok) {
      var prev = out[out.length - 1];
      var startsSentence = !prev || ENDS_SENTENCE.test(prev.trail);
      if (!tok.kept && !ALWAYS[tok.key] && HIDDEN[tok.key]) {
        if (ENDS_SENTENCE.test(tok.trail)) {
          // "... the, um. Then ..." -> "... the. Then ...": the sentence still ends here.
          if (!startsSentence) prev.trail = prev.trail.replace(/[,;:\s\u2013\u2014-]+$/, '') + tok.trail.replace(/[,;:]/g, '');
        } else if (startsSentence) {
          // "Um, so we went" -> "So we went".
          if (/^\p{Lu}/u.test(tok.core)) capitaliseNext = true;
        } else if (/^,/.test(tok.trail) && prev.trail === ',') {
          // "that, uh, we" -> "that we": both commas were only there for the hesitation.
          prev.trail = '';
        }
        return;
      }
      if (capitaliseNext && tok.core) {
        tok.core = capitalised(tok.core);
        capitaliseNext = false;
      }
      out.push(tok);
    });

    // 2. Back-to-back repeated words become one ("I I I think" -> "I think").
    //    Not across the end of a sentence, not for numbers, and never for the always-shown sounds.
    var kept = [];
    out.forEach(function (tok) {
      var prev = kept[kept.length - 1];
      if (prev && tok.key && tok.key === prev.key && !tok.kept && !prev.kept && !ALWAYS[tok.key] &&
          !/\d/.test(tok.key) && !ENDS_SENTENCE.test(prev.trail) && !tok.lead) {
        prev.trail = tok.trail;   // the first one's capital letter, the last one's punctuation
      } else {
        kept.push(tok);
      }
    });

    return kept.map(function (t) { return t.lead + t.core + t.trail; }).join(' ');
  }

  /**
   * The turns as they are shown: [{ n, index, start, end, speaker, overlap, text }].
   * index is the turn's place in the saved list. With showFillers off, hesitations are left
   * out, a turn left with no words disappears, and the numbers close up. The saved turns
   * are never changed, so switching back on shows everything again.
   */
  function visibleTurns(turns, showFillers) {
    var shown = [];
    (turns || []).forEach(function (t, index) {
      var text = showFillers === false ? hideFillers(t.text) : t.text;
      if (showFillers === false && !text) return;
      shown.push({ n: shown.length + 1, index: index, start: t.start, end: t.end, speaker: t.speaker,
        overlap: Boolean(t.overlap), text: text });
    });
    return shown;
  }

  /** One turn as a line of text. */
  function formatTurn(turn, name, showTimes) {
    return turn.n + '. ' + (showTimes ? range(turn) + ' ' : '') + name +
      (turn.overlap ? ' (overlap)' : '') + ': ' + turn.text;
  }

  /** The whole transcript as text, one turn per line, in the view asked for. */
  function formatTranscript(turns, speakers, renamed, showTimes, showFillers) {
    var names = defaultNames(speakers);
    return visibleTurns(turns, showFillers).map(function (t) {
      var custom = renamed && renamed[t.speaker] && String(renamed[t.speaker]).trim();
      return formatTurn(t, custom || names[t.speaker] || 'Unknown Speaker', showTimes);
    }).join('\n');
  }

  /** Words said (not counting numbers, times or speaker names). */
  function countWords(turns) {
    var n = 0;
    turns.forEach(function (t) {
      var m = String(t.text || '').match(/[^\s]+/g);
      if (m) n += m.length;
    });
    return n;
  }

  var TranscriptFormat = {
    RULES: RULES,
    clock: clock,
    range: range,
    readWords: readWords,
    buildTurns: buildTurns,
    defaultNames: defaultNames,
    nameOf: nameOf,
    ALWAYS_SHOWN: ALWAYS_SHOWN,
    HESITATIONS: HESITATIONS,
    hideFillers: hideFillers,
    visibleTurns: visibleTurns,
    formatTurn: formatTurn,
    formatTranscript: formatTranscript,
    countWords: countWords
  };

  global.TranscriptFormat = TranscriptFormat;
  if (typeof module !== 'undefined' && module.exports) module.exports = TranscriptFormat;
})(typeof window !== 'undefined' ? window : globalThis);
