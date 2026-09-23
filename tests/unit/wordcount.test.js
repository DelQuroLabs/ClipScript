import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords, wordBudget, budgetStatus, speakingSeconds, dialogueWords } from '../../lib/domain/wordcount.js';

test('countWords basics', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
  assert.equal(countWords('Hello world'), 2);
  assert.equal(countWords('  Hello,   world!  '), 2);
});
test('contractions count once, hyphen parts count separately', () => {
  assert.equal(countWords("Don't stop — it's state-of-the-art."), 7); // don't stop it's state of the art
  assert.equal(countWords('We’re here'), 2);
});
test('stage directions are not spoken', () => {
  assert.equal(countWords('[laughs] Okay (beat) let us go *whispers*'), 4);
});
test('numbers and unicode', () => {
  assert.equal(countWords('Buy 2 get 1 free'), 5);
  assert.equal(countWords('Café déjà vu'), 3);
});
test('wordBudget', () => {
  assert.equal(wordBudget(8, 2.5, 0.5), 18);
  assert.equal(wordBudget(5, 2.5, 0), 12);
  assert.equal(wordBudget(10, 2.5, 0.5), 23);
  assert.equal(wordBudget(1, 2.5, 2), 0);
  assert.equal(wordBudget(NaN, 2.5), 0);
  assert.equal(wordBudget(8, 0), 0);
});
test('budgetStatus', () => {
  assert.equal(budgetStatus(0, 18), 'empty');
  assert.equal(budgetStatus(10, 18), 'ok');
  assert.equal(budgetStatus(17, 18), 'tight');
  assert.equal(budgetStatus(18, 18), 'tight');
  assert.equal(budgetStatus(19, 18), 'over');
  assert.equal(budgetStatus(3, 0), 'over');
});
test('speakingSeconds + dialogueWords', () => {
  assert.equal(speakingSeconds(25, 2.5), 10);
  assert.equal(dialogueWords([{ speaker: 'A', line: 'one two' }, { speaker: 'B', line: 'three' }]), 3);
  assert.equal(dialogueWords(null), 0);
});

// ---- spoken-length estimate (cut-off protection) ----
import { toSpoken, numberToWords, syllables, speechEstimate, speakingWindow, fitStatus, trimToFit } from '../../lib/domain/wordcount.js';

test('numbers, money, years, percents and acronyms expand to what a voice says', () => {
  assert.equal(numberToWords(0).join(' '), 'zero');
  assert.equal(numberToWords(1234567).join(' '), 'one million two hundred thirty four thousand five hundred sixty seven');
  assert.equal(toSpoken('In 1998').text, 'In nineteen ninety eight');
  assert.equal(toSpoken('by 2005').text, 'by two thousand five');
  assert.equal(toSpoken('$2.5M').text, 'two point five million dollars');
  assert.equal(toSpoken('40%').text, 'forty percent');
  assert.equal(toSpoken('$1').text, 'one dollar');
  assert.equal(toSpoken('12,000 trees').text, 'twelve thousand trees');
  assert.equal(toSpoken('the FBI').text, 'the f b i');
  assert.equal(toSpoken('visit www.example.com').text, 'visit example dot com');
  assert.equal(toSpoken('salt & pepper').text, 'salt and pepper');
  assert.deepEqual(toSpoken('The 1998 FBI report').expansions.map((e) => e.from), ['1998', 'FBI']);
});

test('syllable heuristic is sane', () => {
  assert.equal(syllables('cat'), 1);
  assert.equal(syllables('baker'), 2);
  assert.equal(syllables('make'), 1);
  assert.equal(syllables('extraordinary') >= 5, true);
  assert.equal(syllables('w'), 3);
});

test('speechEstimate: same word count, very different speaking time', () => {
  const short = speechEstimate('We sat by the sea and ate warm bread.', 2.5);
  const long = speechEstimate('Unbelievably, international collaboration revolutionized contemporary manufacturing.', 2.5);
  assert.ok(long.words < short.words, 'fewer words…');
  assert.ok(long.seconds > short.seconds * 1.5, `…but takes longer to say (${long.seconds}s vs ${short.seconds}s)`);
  const nums = speechEstimate('In 1998 the FBI spent $2.5M.', 2.5);
  assert.equal(nums.words, 7);
  assert.ok(nums.spokenWords >= 14, `read aloud as ${nums.spokenWords} words`);
  assert.equal(speechEstimate('', 2.5).seconds, 0);
  // calibration: ordinary narration ≈ words / wps
  const plain = speechEstimate('Every morning this little town wakes up to the smell of fresh bread and hope', 2.5);
  assert.ok(Math.abs(plain.seconds - plain.words / 2.5) < 1.2, `${plain.seconds}s for ${plain.words} words`);
});

test('speaking window + safety margin, and budget honours the margin', () => {
  assert.equal(speakingWindow(8, 0.5, 0), 7.5);
  assert.equal(speakingWindow(8, 0.5, 10), 6.75);
  assert.equal(wordBudget(8, 2.5, 0.5, 10), 16);
  assert.equal(wordBudget(8, 2.5, 0.5, 0), 18);
  assert.equal(speakingWindow(8, 0.5, 99), 3.75, 'margin clamped to 50%');
});

test('fitStatus flags clips that fit by words but not by time', () => {
  const e = speechEstimate('Unbelievably, international collaboration revolutionized contemporary manufacturing forever.', 2.5);
  assert.ok(e.words <= 8);
  assert.equal(fitStatus(e, 16, 3), 'over', 'within word budget, but too long to say in 3s');
  assert.equal(fitStatus(e, 16, 20), 'ok');
  assert.equal(fitStatus(speechEstimate('', 2.5), 16, 5), 'empty');
});

test('trimToFit only cuts at sentence/clause boundaries, never mid-word', () => {
  const t = 'Bees are amazing. A colony holds sixty thousand bees in summer. Worker bees live about six weeks.';
  const out = trimToFit(t, 12, 5, 2.5);
  assert.ok(t.startsWith(out) && /[.!?]$/.test(out), out);
  assert.ok(speechEstimate(out, 2.5).seconds <= 5);
  const clause = trimToFit('This one long sentence keeps going, and going, and going far beyond any reasonable clip length for sure', 8, 4, 2.5);
  assert.match(clause, /\.$/); assert.ok(!clause.includes('reasonable'));
  assert.equal(trimToFit('Short.', 10, 5, 2.5), 'Short.');
});
