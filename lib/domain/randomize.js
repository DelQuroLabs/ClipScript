// Coherent brief randomizer. Pure module (no DOM/Node).
//
// There are no preset briefs. Every field is assembled from parts, and one shared "roll context"
// (niche + mood + format) links them:
//   niche → protagonist/goal/obstacle/twist/setting/audience/CTA   (story)
//   mood  → tone words, palette, compatible visual styles, speaking pace
//   format (story | reel) → aspect ratio, dialogue mode, total duration, faceless styles, clip timing
// In the story format, character names and roles are shared between the concept and the character sheet.
// Seeded PRNG, so the same seed gives the same brief.
import { CLIP_SECOND_PRESETS } from './project.js';

// ---------- PRNG ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const newSeed = () => Math.floor(Math.random() * 2 ** 31);
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function sample(rng, arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
function weighted(rng, entries) { // [[value, weight], ...]
  const total = entries.reduce((s, e) => s + e[1], 0);
  let r = rng() * total;
  for (const [v, w] of entries) { if ((r -= w) < 0) return v; }
  return entries[entries.length - 1][0];
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s) => s.split(' ').map((w, i) => (i && /^(a|an|the|of|in|on|at|to|and|for)$/.test(w) ? w : cap(w))).join(' ');
// Tagged items: a plain string fits everything; { t, k } fits leads whose tags overlap k. Untagged leads fit everything.
const txt = (x) => (typeof x === 'string' ? x : x.t);
const fits = (x, tags) => typeof x === 'string' || !x.k || !tags || x.k.some((k) => tags.includes(k));
const fitting = (arr, tags) => { const f = arr.filter((x) => fits(x, tags)); return f.length ? f : arr; };
const pickFit = (rng, arr, tags) => txt(pick(rng, fitting(arr, tags)));
const protoOpts = (p) => p[2] || {};
const fitsAll = (x, ...tagSets) => tagSets.every((t) => fits(x, t));
const fittingAll = (arr, ...tagSets) => { for (let n = tagSets.length; n > 0; n--) { const f = arr.filter((x) => fitsAll(x, ...tagSets.slice(0, n))); if (f.length) return f; } return arr; };
/** "on a moonlit beach", "at a backyard barbecue", "aboard a generation ship's deck", "in a misty forest". */
export function prepFor(place) {
  const p = String(place).toLowerCase();
  if (/\b(station|ship'?s?|deck|train)\b/.test(p)) return 'aboard';
  if (/\b(barbecue|bus stop|venue|table|dinner party|party|stall)\b/.test(p)) return 'at';
  if (/\b(beach|beaches|boardwalk|rooftop|island|trail|path|streets?|corner|line|grid|lookout|stage|reef|route|hillside|tundra)\b/.test(p)) return 'on';
  return 'in';
}

// ---------- moods: tone words, palettes, pace ----------
export const MOODS = {
  calm:       { tone: ['calm', 'gentle', 'soothing', 'unhurried', 'reflective', 'soft-spoken'], pace: 2.2,
    palettes: ['sage green, oat, soft white', 'misty blue, sand, pale grey', 'lavender dusk, cream, slate', 'eucalyptus, linen, driftwood', 'morning fog grey, butter yellow, white'] },
  warm:       { tone: ['warm', 'heartfelt', 'friendly', 'nostalgic', 'cozy', 'sincere'], pace: 2.4,
    palettes: ['warm amber, cream, terracotta', 'honey gold, rust, off-white', 'peach, caramel, deep brown', 'golden hour orange, rose, cream', 'mustard, brick red, warm white'] },
  playful:    { tone: ['playful', 'cheeky', 'upbeat', 'whimsical', 'light-hearted', 'bouncy'], pace: 2.7,
    palettes: ['bubblegum pink, mint, sunshine yellow', 'tangerine, sky blue, white', 'lime, grape purple, cream', 'coral, teal, lemon', 'candy red, baby blue, vanilla'] },
  energetic:  { tone: ['energetic', 'punchy', 'bold', 'fast-paced', 'hype', 'confident'], pace: 3.0,
    palettes: ['electric blue, neon lime, black', 'hot magenta, cyan, charcoal', 'safety orange, black, white', 'acid yellow, deep purple, black', 'red, white, chrome silver'] },
  dramatic:   { tone: ['dramatic', 'intense', 'urgent', 'cinematic', 'gripping', 'serious'], pace: 2.3,
    palettes: ['crimson, black, gunmetal', 'deep teal, orange rim light, black', 'blood orange, navy, smoke grey', 'gold, black, ivory', 'storm blue, steel, white highlights'] },
  mysterious: { tone: ['mysterious', 'hushed', 'eerie', 'suspenseful', 'curious', 'understated'], pace: 2.2,
    palettes: ['midnight blue, cold cyan, black', 'moss green, fog grey, black', 'violet haze, silver, ink black', 'sodium-lamp amber, deep shadow', 'emerald, obsidian, pale moonlight'] },
  inspiring:  { tone: ['inspiring', 'hopeful', 'uplifting', 'determined', 'triumphant', 'optimistic'], pace: 2.5,
    palettes: ['sunrise gold, sky blue, white', 'fresh green, sunlight yellow, cloud white', 'ocean blue, coral, sand', 'rose gold, soft navy, cream', 'warm white, amber flare, deep blue'] },
  wry:        { tone: ['wry', 'dry-witted', 'deadpan', 'sardonic', 'clever', 'matter-of-fact'], pace: 2.6,
    palettes: ['muted olive, beige, black', 'dusty pink, grey, off-white', 'office beige, fluorescent green, grey', 'faded denim, mustard, cream', 'concrete grey, one pop of red, white'] },
};
export const MOOD_IDS = Object.keys(MOODS);

// ---------- visual styles (mood-compatible; faceless-safe flag) ----------
export const VISUAL_STYLES = [
  { s: 'cinematic photoreal, 35mm film grain, shallow depth of field', moods: ['warm', 'dramatic', 'inspiring', 'calm', 'mysterious'], faceless: true, story: true },
  { s: 'Pixar-style 3D animation, soft global illumination, rounded shapes', moods: ['playful', 'warm', 'inspiring'], faceless: false, story: true },
  { s: 'Studio Ghibli-inspired hand-painted anime, lush backgrounds', moods: ['calm', 'warm', 'inspiring', 'mysterious'], faceless: false, story: true },
  { s: 'moody neo-noir, hard shadows, rain-slick reflections, high contrast', moods: ['dramatic', 'mysterious', 'wry'], faceless: true, story: true },
  { s: 'bright flat vector illustration, bold outlines, clean shapes', moods: ['playful', 'energetic', 'wry', 'inspiring'], faceless: true, story: true },
  { s: 'claymation stop-motion look, fingerprint textures, miniature sets', moods: ['playful', 'wry', 'warm'], faceless: false, story: true },
  { s: 'paper cut-out collage, layered textures, subtle parallax', moods: ['playful', 'calm', 'wry', 'warm'], faceless: true, story: true },
  { s: 'vintage 1970s film look, faded colour, light leaks', moods: ['warm', 'wry', 'calm'], faceless: true, story: true },
  { s: 'glossy commercial product photography, seamless backdrop, rim lighting', moods: ['energetic', 'inspiring', 'calm'], faceless: true, story: false },
  { s: 'macro close-up photography, extreme detail, creamy bokeh', moods: ['calm', 'mysterious', 'inspiring', 'dramatic'], faceless: true, story: false },
  { s: 'kinetic typography over abstract gradients, bold sans-serif text', moods: ['energetic', 'wry', 'dramatic', 'inspiring'], faceless: true, story: false },
  { s: 'isometric 3D infographic, soft shadows, clean pastel shapes', moods: ['calm', 'playful', 'inspiring', 'wry'], faceless: true, story: false },
  { s: 'minimal 3D icons floating in space, glassmorphism, soft glow', moods: ['calm', 'energetic', 'inspiring'], faceless: true, story: false },
  { s: 'archival documentary look, grainy black-and-white footage, slow zooms', moods: ['dramatic', 'mysterious', 'calm'], faceless: true, story: false },
  { s: 'top-down flat-lay, hands-only POV, natural window light', moods: ['calm', 'warm', 'playful', 'inspiring'], faceless: true, story: false },
  { s: 'dark cinematic silhouettes, volumetric fog, single light source', moods: ['dramatic', 'mysterious', 'inspiring'], faceless: true, story: false },
  { s: 'drone aerials and sweeping landscapes, golden hour haze', moods: ['inspiring', 'calm', 'dramatic'], faceless: true, story: false },
  { s: 'retro synthwave 3D, neon grid, chrome text, VHS scanlines', moods: ['energetic', 'wry', 'mysterious'], faceless: true, story: true },
  { s: 'watercolor storybook illustration, soft washes, visible paper grain', moods: ['calm', 'warm', 'inspiring'], faceless: false, story: true },
  { s: 'gritty handheld documentary, natural light, real textures', moods: ['dramatic', 'inspiring', 'wry'], faceless: true, story: true },
];

// ---------- story niches ----------
// protagonist: [role, age]. Keep every slot generic enough to combine with any other slot in its niche.
export const NICHES = [
  { id: 'small-biz', label: 'Small business', moods: ['warm', 'inspiring', 'playful', 'wry'],
    protagonists: [['a stubborn bakery owner', '40s'], ['a first-time food-truck chef', '20s'], ['a florist with a tiny corner shop', '30s'], ['a retired carpenter turned toymaker', '60s'], ['a bike-repair shop owner', '30s'], ['a second-generation tailor', '50s'], ['a coffee roaster working from a garage', '20s']],
    goals: ['saves the shop from closing', 'wins back the neighbourhood', 'lands the order of a lifetime', 'survives the opening week', 'turns one bad review into a comeback', 'launches a product nobody asked for'],
    obstacles: ['a chain store opens across the street', 'the one machine they rely on breaks on launch day', 'rent doubles overnight', 'a storm floods the storefront', 'the supplier vanishes', 'a viral video gets the story wrong'],
    twists: ['the rival turns out to be an old friend', 'the mistake becomes the bestseller', 'the whole street shows up to help', 'a regular reveals a surprising secret', 'the answer was in a grandparent\'s notebook', 'the fix costs nothing at all'],
    settings: ['a rainy harbour town', 'a sunlit city corner', 'a snowy mountain village', 'a busy night market', 'a quiet suburban high street', 'a seaside boardwalk'],
    audiences: ['local shoppers', 'small business owners', 'foodies aged 25–45', 'community-minded families'],
    ctas: ['Visit your local shop this week', 'Follow for more small-business stories', 'Tag a shop you love', 'Order online today'] },
  { id: 'sci-fi', label: 'Sci-fi', moods: ['mysterious', 'dramatic', 'inspiring', 'wry'],
    protagonists: [['a lone repair robot', 'ageless', { kind: 'robot' }], ['a rookie cargo pilot', '20s'], ['an ageing station engineer', '50s'], ['a botanist on a Mars greenhouse', '30s'], ['a curious android child', 'looks 10', { kind: 'robot' }], ['a night-shift signal analyst', '30s'], ['a smuggler with a heart of gold', '40s']],
    goals: ['must restart a dying star-station', 'decodes a signal from deep space', 'tries to get home before the oxygen runs out', 'protects the last seed vault', 'searches for a missing crewmate', 'teaches a machine to dream'],
    obstacles: ['the ship\'s AI refuses to cooperate', 'a solar storm knocks out comms', 'time moves differently on this planet', 'the map is centuries out of date', 'someone on board is lying', 'the power will last ten minutes'],
    twists: ['the signal is their own voice from the future', 'the AI was protecting them all along', 'the planet is alive', 'home was never where they thought', 'the missing crewmate left on purpose', 'the dream is a memory'],
    settings: ['an orbital station above a gas giant', 'a red desert under two moons', 'a flooded neon megacity', 'an abandoned asteroid mine', 'a generation ship\'s greenhouse deck', 'a frozen research outpost'],
    audiences: ['sci-fi fans', 'gamers aged 18–35', 'fans of short animated films', 'space and science enthusiasts'],
    ctas: ['Follow for part two', 'Comment what happens next', 'Share with a sci-fi fan', 'Subscribe for more short films'] },
  { id: 'cozy-fantasy', label: 'Cozy fantasy', moods: ['calm', 'warm', 'playful', 'mysterious'],
    protagonists: [['a young apprentice witch', 'teen', { g: 'f' }], ['a grumpy dragon who hoards teacups', 'ancient', { kind: 'animal', looks: ['moss-green scales and stubby wings', 'dusty violet scales with a cracked horn', 'copper scales dulled with age', 'pale blue scales and a curled tail'] }], ['a travelling lantern-maker', '30s'], ['a talking fox librarian', 'middle-aged', { kind: 'animal', looks: ['russet fur and a white-tipped tail', 'silver-grey fur with a dark muzzle', 'deep orange fur and one torn ear'] }], ['a retired knight running an inn', '60s'], ['a mushroom-forager with a map of secrets', '20s']],
    goals: ['brews a potion to cure the village\'s gloom', 'delivers a letter across an enchanted forest', 'finds the missing spring festival', 'befriends the creature everyone fears', 'restores a broken moon-clock', 'bakes the bread that grants one wish'],
    obstacles: ['the recipe is written in riddles', 'the forest rearranges itself at night', 'a spell makes everyone forget their names', 'the bridge troll wants a fair trade', 'winter arrives three months early', 'the magic only works when nobody is watching'],
    twists: ['the feared creature was lonely', 'the missing ingredient was kindness all along', 'the map was drawn by the hero\'s future self', 'the village was enchanted to protect it', 'the wish is given away', 'the moon-clock was keeping a promise'],
    settings: ['a mossy hillside village', 'a lantern-lit forest', 'a floating island market', 'a snowy mountain monastery', 'a riverside mushroom town', 'a library built inside a giant tree'],
    audiences: ['cozy-game fans', 'fans of animated storybooks', 'adults who love comfort content', 'families with kids 6–12'],
    ctas: ['Follow for the next chapter', 'Save this for a cozy night', 'Share with someone who needs calm', 'Comment your favourite character'] },
  { id: 'fitness', label: 'Fitness & wellness', moods: ['energetic', 'inspiring', 'calm', 'wry'],
    protagonists: [['a desk worker who can\'t touch their toes', '30s'], ['a grandmother training for her first 5K', '70s', { g: 'f' }], ['a burnt-out nurse', '40s'], ['a teenager learning to skateboard', 'teen'], ['a former athlete coming back from injury', '30s'], ['a night-shift chef', '20s']],
    goals: ['builds a two-minute daily habit', 'finishes a first race', 'sleeps through the night again', 'stops the 3pm energy crash', 'lifts a personal best', 'walks ten thousand steps for thirty days'],
    obstacles: ['motivation disappears on day three', 'a knee injury flares up', 'the schedule has zero free time', 'everyone online says something different', 'the weather refuses to cooperate', 'the scale won\'t move'],
    twists: ['the smallest habit changes everything', 'the rest days were the secret', 'a friend was quietly doing it too', 'progress was hiding in a different number', 'the coach learns from the student', 'the goal changes halfway and it\'s better'],
    settings: ['a tiny city apartment', 'a sunrise beach path', 'a community centre gym', 'a rooftop at dawn', 'a snowy park trail', 'a busy hospital break room'],
    audiences: ['busy professionals', 'beginners over 40', 'fitness beginners aged 20–35', 'people returning after injury'],
    ctas: ['Try it for seven days', 'Save this routine', 'Follow for daily two-minute tips', 'Share with your workout buddy'] },
  { id: 'mystery', label: 'Mystery', moods: ['mysterious', 'dramatic', 'wry'],
    protagonists: [['a retired detective', '60s'], ['a nosy night-bus driver', '40s'], ['a museum night guard', '30s'], ['a true-crime podcaster', '20s'], ['a small-town pharmacist', '50s'], ['a bored hotel concierge', '30s']],
    goals: ['finds out who keeps leaving the notes', 'tracks down a painting that vanished overnight', 'solves a decades-old disappearance', 'figures out why every clock stopped at 3:17', 'identifies a stranger with no records', 'recovers a stolen family recipe'],
    obstacles: ['the only witness is a parrot', 'the evidence keeps moving', 'the town wants the past left alone', 'every lead points back to themselves', 'a storm cuts off the island', 'the prime suspect has a perfect alibi'],
    twists: ['the victim staged it', 'the culprit is the one who hired them', 'there was never a crime at all', 'the clue was in the first scene', 'two cases turn out to be one', 'the detective wrote the first note'],
    settings: ['a fog-covered island hotel', 'a museum after closing', 'a sleepy seaside town', 'a night train crossing the mountains', 'a rain-soaked city alley', 'a snowed-in mountain lodge'],
    audiences: ['true-crime fans', 'mystery readers', 'puzzle lovers', 'adults 25–55 who love whodunits'],
    ctas: ['Comment who you think did it', 'Follow for the reveal', 'Watch again for the clue', 'Share with your detective friend'] },
  { id: 'travel', label: 'Travel', moods: ['inspiring', 'calm', 'warm', 'playful'],
    protagonists: [['a solo backpacker on a budget', '20s'], ['a recently retired teacher on a first trip abroad', '60s'], ['a travel photographer with one lens', '30s'], ['a van-life parent with two restless kids', '30s'], ['a chef hunting a lost recipe', '40s'], ['a student on a gap year', 'teen']],
    goals: ['finds the view from an old postcard', 'eats the best street food in the city', 'crosses the country by train', 'learns ten phrases in a week', 'reaches the summit before sunrise', 'retraces a grandparent\'s journey'],
    obstacles: ['the train is cancelled', 'the wallet is stolen on day one', 'the map app loses signal', 'a festival floods every hotel', 'the weather closes the pass', 'the phrasebook is decades out of date'],
    twists: ['a stranger becomes a guide', 'the detour is the best part', 'the postcard view was right outside the hostel', 'the recipe was never written down', 'home looks different on return', 'the grandparent\'s path leads to family'],
    settings: ['a cliffside Mediterranean village', 'a neon night market in Asia', 'a Patagonian mountain trail', 'a Moroccan medina', 'Icelandic black-sand beaches', 'a Japanese countryside rail line'],
    audiences: ['budget travellers', 'first-time solo travellers', 'retirees who love to travel', 'travel dreamers aged 20–40'],
    ctas: ['Save this for your next trip', 'Follow for more hidden spots', 'Tag your travel buddy', 'Comment where to go next'] },
  { id: 'tech-explainer', label: 'Tech explained', moods: ['wry', 'energetic', 'inspiring', 'calm'],
    protagonists: [['a confused grandparent with a new phone', '70s'], ['a junior developer on their first day', '20s'], ['a smart fridge with opinions', 'ageless', { kind: 'robot' }], ['a small-business owner going online', '40s'], ['a teenager fixing the family Wi-Fi', 'teen'], ['a retired engineer who hates passwords', '60s']],
    goals: ['finally understands how the internet works', 'sets up a password manager', 'ships their first website', 'stops a phishing scam', 'backs up twenty years of photos', 'figures out what AI actually does'],
    obstacles: ['every tutorial assumes they know the jargon', 'the update breaks everything', 'a scam email looks exactly like the bank', 'the cloud is full', 'nobody agrees which app is best', 'the router is older than the kid'],
    twists: ['the grandparent explains it better than the expert', 'the simplest setting fixed it', 'the scammer gets scammed', 'the backup saved the day a week later', 'the AI admits it doesn\'t know', 'the old way was already the secure way'],
    settings: ['a cluttered kitchen table', 'a busy open-plan office', 'a tiny home studio', 'a family living room at night', 'a café with bad Wi-Fi', 'a basement server closet'],
    audiences: ['non-technical adults', 'small business owners', 'parents and grandparents', 'curious beginners'],
    ctas: ['Follow for more tech made simple', 'Save this before you need it', 'Share with someone who asks you for tech help', 'Comment your tech question'] },
  // Nature uses habitat tags (k) so a sea turtle never lands in a tundra and a bee never "escapes the aquarium".
  { id: 'nature', label: 'Nature & animals', moods: ['calm', 'inspiring', 'playful', 'dramatic'],
    protagonists: [
      ['a young sea turtle', 'hatchling', { kind: 'animal', k: ['sea', 'coast'], looks: ['an olive-green shell with pale gold edges', 'a dark shell with a tiny chip on one side', 'a mottled brown shell and bright black eyes'] }],
      ['an old lighthouse cat', 'senior', { kind: 'animal', k: ['coast', 'urban'], looks: ['a grizzled grey tabby', 'a scruffy black-and-white tuxedo cat', 'a battle-scarred ginger tom'] }],
      ['a bumblebee who is late for spring', 'young', { kind: 'animal', k: ['flyer', 'meadow', 'urban'], looks: ['extra-fuzzy gold-and-black stripes', 'pollen-dusted fur and slightly bent wings', 'a round orange-tailed body'] }],
      ['a wildlife ranger', '40s', { k: ['ranger', 'forest', 'tundra', 'meadow', 'coast'] }],
      ['a stray dog in a big city', 'adult', { kind: 'animal', k: ['urban', 'coast', 'forest'], looks: ['a lanky brown mutt with one floppy ear', 'a scruffy white terrier with a grey patch', 'a big black shepherd mix with gentle eyes'] }],
      ['a curious octopus', 'young', { kind: 'animal', k: ['sea'], looks: ['coral-red skin that shifts to blue when nervous', 'speckled sandy skin and huge golden eyes', 'deep purple skin with pale spots'] }],
    ],
    goals: [{ t: 'makes it to the ocean', k: ['sea'] }, { t: 'finds a home before winter', k: ['coast', 'urban', 'flyer', 'forest', 'meadow'] }, { t: 'rescues a lost cub', k: ['ranger', 'forest', 'tundra'] }, { t: 'protects the last wildflower meadow', k: ['flyer', 'meadow', 'ranger'] }, 'guides the others home', { t: 'escapes the aquarium', k: ['sea'] }, { t: 'finds the way back to the colony', k: ['sea', 'flyer'] }, 'survives the longest night of the year'],
    obstacles: ['a storm rolls in', { t: 'the river has changed course', k: ['forest', 'meadow', 'tundra', 'ranger'] }, { t: 'humans have built a road through the path', k: ['forest', 'meadow', 'urban', 'coast'] }, 'the season came early', 'a predator is watching', { t: 'the tide is going out fast', k: ['sea', 'coast'] }, { t: 'a fishing net drifts closer', k: ['sea'] }],
    twists: ['the predator was a protector', 'a child helps without knowing', { t: 'the meadow grows back stronger', k: ['meadow', 'flyer', 'ranger'] }, 'home was there all along', { t: 'the whole colony returns', k: ['sea', 'flyer'] }, { t: 'the escape was to rescue a friend', k: ['sea'] }, 'the smallest one leads the way'],
    settings: [{ t: 'a moonlit beach', k: ['coast', 'sea'] }, { t: 'a misty pine forest', k: ['forest', 'ranger'] }, { t: 'a city rooftop garden', k: ['urban', 'flyer'] }, { t: 'an arctic tundra', k: ['tundra'] }, { t: 'a coral reef at dawn', k: ['sea'] }, { t: 'a wildflower meadow', k: ['meadow', 'flyer'] }, { t: 'a harbour at low tide', k: ['coast', 'sea', 'urban'] }, { t: 'a swaying kelp forest', k: ['sea'] }],
    audiences: ['nature lovers', 'families with young kids', 'animal lovers of all ages', 'eco-conscious viewers'],
    ctas: ['Follow for more wild stories', 'Share with an animal lover', 'Save this for bedtime', 'Support your local wildlife rescue'] },
  { id: 'comedy', label: 'Comedy sketch', moods: ['wry', 'playful', 'energetic'],
    protagonists: [['an overconfident office intern', '20s', { k: ['work'] }], ['a dad who refuses to read instructions', '40s', { g: 'm', k: ['home'] }], ['a cat convinced it runs the house', 'adult', { kind: 'animal', k: ['home'], looks: ['a round grey tabby', 'a sleek black cat with yellow eyes', 'a fluffy white Persian', 'a ginger cat with one bent whisker'] }], ['a wedding planner having the worst day', '30s', { k: ['home', 'work'] }], ['a self-proclaimed life coach', '30s'], ['a grandma who just discovered memes', '70s', { g: 'f', k: ['home'] }]],
    goals: [{ t: 'tries to impress the boss', k: ['work'] }, { t: 'gets through one video call without incident', k: ['work'] }, 'tries to go viral on purpose', { t: 'assembles flat-pack furniture in one go', k: ['home'] }, { t: 'plans the perfect surprise party', k: ['home'] }, { t: 'wins the neighbourhood barbecue contest', k: ['home'] }, { t: 'survives the office potluck', k: ['work'] }],
    obstacles: [{ t: 'one screw is always missing', k: ['home'] }, { t: 'the microphone is on', k: ['work'] }, { t: 'the guest of honour arrives early', k: ['home'] }, { t: 'the recipe says "a pinch" of everything', k: ['home'] }, 'the algorithm hates them', 'autocorrect has other plans', { t: 'the printer jams at the worst possible moment', k: ['work'] }, { t: 'the smoke alarm has opinions', k: ['home'] }],
    twists: ['the disaster goes viral instead', { t: 'the pet was right all along', k: ['home'] }, { t: 'the boss did the exact same thing years ago', k: ['work'] }, 'the quietest person in the room wins', { t: 'the instructions were for a different product', k: ['home'] }, { t: 'the party was for them', k: ['home'] }, 'everyone else was pretending too'],
    settings: [{ t: 'an open-plan office', k: ['work'] }, { t: 'a video call grid', k: ['work'] }, { t: 'a tiny suburban kitchen', k: ['home'] }, { t: 'a backyard barbecue', k: ['home'] }, { t: 'a cluttered living room', k: ['home'] }, { t: 'a chaotic wedding venue', k: ['home'] }, { t: 'a fluorescent-lit break room', k: ['work'] }],
    audiences: ['office workers', 'parents', 'meme lovers aged 18–40', 'anyone who needs a laugh'],
    ctas: ['Tag someone who does this', 'Follow for more chaos', 'Comment your worst version of this', 'Share with the group chat'] },
  { id: 'history', label: 'History story', moods: ['dramatic', 'mysterious', 'inspiring', 'calm'],
    protagonists: [['a medieval scribe', '30s', { k: ['medieval'] }], ['a lighthouse keeper in 1900', '50s', { k: ['modern', 'keeper'] }], ['a wartime codebreaker', '20s', { k: ['war', 'codebreaker'] }], ['an ancient Roman baker', '40s', { k: ['ancient'] }], ['a silk-road merchant', '40s', { k: ['medieval', 'ancient'] }], ['a pioneer photographer', '30s', { k: ['modern', 'war'] }]],
    goals: ['must deliver a message before it is too late', 'protects a library from fire', 'records a city before it vanishes', { t: 'keeps the light burning through a hurricane', k: ['keeper'] }, { t: 'breaks an enemy code in three days', k: ['codebreaker'] }, 'carries a forbidden idea across the border'],
    obstacles: ['the message is intercepted', 'the rulers forbid the work', 'the storm lasts four nights', 'no one believes the discovery', 'the only copy is damaged', { t: 'the route is closed by bandits', k: ['medieval', 'ancient'] }, { t: 'the enemy is listening', k: ['war'] }],
    twists: ['the mistake saved thousands', 'the forgotten helper was the real hero', { t: 'the code was a love letter', k: ['war'] }, 'the burned library had a secret copy', { t: 'one photograph is the only record that survived', k: ['modern', 'war'] }, 'history remembered the wrong name'],
    settings: [{ t: 'a candlelit monastery', k: ['medieval'] }, { t: 'a storm-battered lighthouse', k: ['keeper'] }, { t: 'a smoky wartime office', k: ['war'] }, { t: 'the streets of ancient Rome', k: ['ancient'] }, { t: 'a desert caravan route', k: ['medieval', 'ancient'] }, { t: 'a gaslit Victorian city', k: ['modern'] }],
    audiences: ['history buffs', 'students', 'documentary lovers', 'curious adults'],
    ctas: ['Follow for more forgotten history', 'Comment what you want next', 'Save this for later', 'Share with a history nerd'] },
  { id: 'self-improvement', label: 'Motivation', moods: ['inspiring', 'calm', 'dramatic', 'energetic'],
    protagonists: [['a graduate who feels behind', '20s'], ['a single parent starting over', '30s'], ['a musician about to quit', '20s'], ['a manager who has never said no', '40s'], ['a retiree learning to paint', '60s'], ['a student terrified of public speaking', 'teen']],
    goals: ['makes one brave decision', 'finishes the project they abandoned', 'says no for the first time', 'performs on stage', 'builds a morning that feels like theirs', 'starts again at zero'],
    obstacles: ['the fear gets louder every day', 'everyone else seems ahead', 'the first attempt fails in public', 'there is no time left in the day', 'an old voice says they are not enough', 'the plan falls apart'],
    twists: ['the failure was the lesson', 'someone was watching and was inspired', 'the small step was the big one', 'the critic was their younger self', 'the audience was on their side all along', 'starting over was the head start'],
    settings: ['an empty stage', 'a quiet early-morning kitchen', 'a rainy bus stop', 'a crowded subway car', 'a mountain lookout', 'a tiny rented studio'],
    audiences: ['young adults', 'career changers', 'creatives', 'anyone starting over'],
    ctas: ['Save this for a hard day', 'Share with someone who needs it', 'Follow for daily motivation', 'Comment your one brave step'] },
  { id: 'food', label: 'Food & cooking', moods: ['warm', 'playful', 'energetic', 'calm'],
    protagonists: [['a college student with one pan', 'teen'], ['a grandmother guarding a secret recipe', '70s', { g: 'f' }], ['a street-food vendor', '40s'], ['a nervous first-date cook', '30s'], ['a picky kid who dreams of being a chef', 'child'], ['a home baker entering a contest', '30s']],
    goals: ['cooks a feast with five ingredients', 'recreates a dish from memory', 'wins the neighbourhood bake-off', 'feeds the whole street', 'makes the perfect loaf', 'impresses the toughest critic at the table'],
    obstacles: ['the power goes out', 'a key ingredient is missing', 'the oven runs hot', 'the guests double', 'the recipe card is smudged', 'the timer was never started'],
    twists: ['the burnt part is the best part', 'the secret ingredient was patience', 'the critic asks for the recipe', 'grandma was improvising all along', 'the simplest idea saves dinner', 'the leftovers become the new classic'],
    settings: ['a tiny dorm kitchen', 'a sunlit farmhouse kitchen', 'a busy night market stall', 'a rooftop dinner party', 'a snowy cabin', 'a bustling family restaurant'],
    audiences: ['home cooks', 'students on a budget', 'foodies', 'busy parents'],
    ctas: ['Save this recipe', 'Follow for more easy meals', 'Tag who you\'d cook this for', 'Comment your secret ingredient'] },
];

// ---------- characters ----------
const NAMES_F = ['Maya', 'Ava', 'Nora', 'Iris', 'Zoe', 'Luna', 'Mila', 'Aria', 'Sana', 'Rosa', 'Clara', 'Yara', 'Hana', 'Freya', 'Elena', 'Amara', 'Priya', 'Ines', 'Noor', 'Lena', 'Ivy', 'Maeve', 'Ada', 'Lila', 'Sofia', 'Opal', 'Talia', 'Asha'];
const NAMES_M = ['Leo', 'Theo', 'Omar', 'Felix', 'Ravi', 'Jonah', 'Hugo', 'Eli', 'Idris', 'Mateo', 'Otis', 'Nico', 'Tariq', 'Jude', 'Silas', 'Arlo', 'Kofi', 'Diego', 'Basil', 'Rafael', 'Samir', 'Tomas', 'Ezra', 'Kenji', 'Marek', 'Gus', 'Emil'];
const NAMES_N = ['Kai', 'Remy', 'Juno', 'Bo', 'Wren', 'Sky', 'Ash', 'Rio'];
const FIRST_NAMES = [...NAMES_F, ...NAMES_M, ...NAMES_N];
const namesFor = (g) => (g === 'f' ? [...NAMES_F, ...NAMES_N] : g === 'm' ? [...NAMES_M, ...NAMES_N] : FIRST_NAMES);
const HAIR = ['curly dark hair tied up', 'a silver buzz cut', 'long red braids', 'a messy blond mop', 'short black hair with a streak of blue', 'grey hair in a low bun', 'shoulder-length brown waves', 'a shaved head', 'thick black curls', 'a sleek auburn bob', 'wild white hair', 'two space buns'];
const OUTFIT = ['a mustard-yellow apron', 'a faded denim jacket', 'a moss-green raincoat', 'a crisp white shirt with rolled sleeves', 'a patched brown leather coat', 'an oversized red hoodie', 'a navy wool sweater', 'a floral dress with a cardigan', 'grease-stained overalls', 'a teal scarf and long grey coat', 'a striped sailor top', 'a worn orange flight suit'];
const DETAIL = ['round tortoiseshell glasses', 'a small scar on the chin', 'freckles across the nose', 'a pencil tucked behind one ear', 'mismatched socks', 'a silver pocket watch', 'paint-stained fingers', 'a lucky red bracelet', 'a camera around the neck', 'a gap-toothed smile', 'a knitted beanie', 'bright green sneakers'];
const VOICES = ['warm and unhurried', 'quick and excitable', 'low and gravelly', 'soft and curious', 'dry and deadpan', 'bright and confident', 'gentle with a slight rasp', 'theatrical and grand'];
const ANIMAL_DETAIL = ['a small scar above one eye', 'unusually bright amber eyes', 'a tiny red scarf', 'a curious head tilt', 'a slightly lopsided walk', 'a faint white marking like a star'];
const ROBOT_FINISH = ['scuffed white enamel plating', 'matte olive-green panels', 'polished copper casing', 'chipped yellow industrial paint', 'brushed steel with rust at the seams'];
const ROBOT_LIGHTS = ['one flickering blue eye-lens', 'twin warm amber eye-lights', 'a cracked visor with a soft green glow', 'a round screen face showing pixel eyes'];
const ROBOT_DETAIL = ['a dented antenna', 'a patched cloth scarf', 'stickers on one shoulder', 'a tool arm with a tiny wrench', 'a squeaky left wheel'];
// Narrator voices, each tagged with the moods it suits.
const NARRATOR_VOICES = [
  ['warm, friendly female narrator', ['warm', 'calm', 'inspiring', 'playful']],
  ['deep, calm male narrator', ['calm', 'dramatic', 'mysterious', 'inspiring']],
  ['energetic young narrator', ['energetic', 'playful', 'inspiring']],
  ['hushed documentary narrator', ['mysterious', 'calm', 'dramatic']],
  ['dry, witty narrator', ['wry', 'playful']],
  ['bright, upbeat narrator', ['playful', 'energetic', 'warm']],
  ['soft, intimate whisper-close narrator', ['calm', 'mysterious', 'warm']],
  ['confident news-anchor narrator', ['energetic', 'dramatic', 'wry']],
  ['gravelly movie-trailer narrator', ['dramatic', 'mysterious', 'energetic']],
  ['gentle storyteller grandparent voice', ['warm', 'calm']],
];
const narratorsFor = (mood) => NARRATOR_VOICES.filter((v) => v[1].includes(mood)).map((v) => v[0]);

// ---------- reels (faceless, data-driven) ----------
export const REEL_STRUCTURES = [
  { id: 'hook-facts-cta', label: 'Hook → 3 facts → payoff', data: 'any', angles: ['Lead with the single most surprising fact', 'Open with a question the data answers', 'Start with the fact that sounds fake but is true'] },
  { id: 'myth-vs-fact', label: 'Myth vs fact', data: 'any', angles: ['Bust the most common misconception in the data', 'Contrast what people assume with what the data shows', 'Frame each clip as "you think X, actually Y"'] },
  { id: 'countdown', label: 'Countdown (top N)', data: 'any', angles: ['Rank the most striking points, best saved for last', 'Count down from least to most surprising', 'Top list of the key takeaways'] },
  { id: 'stat-bomb', label: 'Stat bomb', data: 'numbers', angles: ['Rapid-fire the biggest numbers', 'Make every clip one number with context', 'Put the numbers in everyday comparisons'] },
  { id: 'timeline', label: 'Timeline', data: 'dates', angles: ['Walk through the events in order', 'Then vs now: how it changed', 'The turning points, in sequence'] },
  { id: 'problem-solution', label: 'Problem → solution', data: 'any', angles: ['Show the pain, then the fix the data points to', 'Frame it as a warning, then the way out', 'The mistake most people make, and what to do instead'] },
  { id: 'explain-simple', label: 'Explain it simply', data: 'any', angles: ['Explain it like to a curious 12-year-old', 'One idea per clip, zero jargon', 'Use an everyday analogy for each point'] },
  { id: 'did-you-know', label: '"Did you know" chain', data: 'any', angles: ['Chain lesser-known facts, each more surprising', 'Every clip opens with "and it gets weirder"', 'Hidden details most people miss'] },
  { id: 'hot-take', label: 'Hot take + evidence', data: 'any', angles: ['Make a bold claim, then back it with the data', 'Take the unpopular side the data supports', 'Challenge the obvious conclusion'] },
  { id: 'case-study', label: 'Mini case study', data: 'any', angles: ['Tell it as one story: situation, action, result', 'Focus on what changed and why', 'The before/after in the data'] },
  { id: 'cost-breakdown', label: 'Breakdown / cost', data: 'numbers', angles: ['Break the total into its parts', 'Where the money/time actually goes', 'Compare the options side by side'] },
  { id: 'qa', label: 'Q&A rapid fire', data: 'any', angles: ['Answer the top questions people ask about this', 'Each clip: one question, one sharp answer', 'The questions nobody asks but should'] },
];
const REEL_TITLES = ['Nobody talks about this', 'Wait for the last one', 'The numbers don\'t lie', 'You\'ve been told this wrong', 'This changes everything', 'Read this before you scroll', 'The part they leave out', 'I didn\'t believe it either', 'Save this for later', 'Here\'s what actually happened', 'Most people get this wrong', 'The truth in 30 seconds'];
const REEL_AUDIENCES = ['curious scrollers aged 18–34', 'busy professionals who want the short version', 'students and lifelong learners', 'people new to the topic', 'skeptics who want receipts', 'fans of quick explainers', 'small business owners', 'parents short on time'];
const REEL_CTAS = ['Follow for part two', 'Save this so you don\'t forget', 'Share with someone who needs this', 'Comment which one surprised you', 'Follow for more in under a minute', 'Send this to the group chat', 'Comment "more" for the deep dive', 'Follow so you don\'t miss the next one'];

// ---------- timing ----------
const TARGET_TOTAL = { reel: [15, 20, 25, 30, 35, 40, 45, 50, 60], story: [30, 40, 45, 50, 60, 75, 90, 120] };
function pickTiming(rng, mode, mood) {
  const targets = TARGET_TOTAL[mode];
  for (let tries = 0; tries < 50; tries++) {
    const total = pick(rng, targets);
    const lens = CLIP_SECOND_PRESETS.filter((l) => (mode === 'reel' ? l >= 3 && l <= 10 : l >= 5));
    const len = pick(rng, lens);
    const count = Math.round(total / len);
    if (count >= 2 && count <= 10) {
      const pace = Math.round(Math.min(3.4, Math.max(1.6, MOODS[mood].pace + (rng() - 0.5) * 0.4)) * 10) / 10;
      const pad = pick(rng, [0.25, 0.5, 0.5, 0.75]);
      return { clipCount: count, clipSeconds: len, wordsPerSecond: pace, paddingSeconds: pad };
    }
  }
  return { clipCount: 5, clipSeconds: 6, wordsPerSecond: MOODS[mood].pace, paddingSeconds: 0.5 };
}

// ---------- source-data analysis (used to bias reel structure) ----------
export function analyzeSource(text) {
  const t = String(text || '');
  const words = (t.match(/[\p{L}\p{N}]+/gu) || []).length;
  const numbers = (t.match(/(?<![\p{L}])[$€£]?\d[\d,.]*\s?(?:%|percent|k|m|bn|million|billion)?/giu) || []).length;
  const dates = (t.match(/\b(1[5-9]\d{2}|20\d{2})\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/gi) || []).length;
  const lines = t.split(/\n+/).filter((l) => l.trim()).length;
  return { chars: t.length, words, numbers, dates, lines };
}

// ---------- roll context ----------
export const ctxToVibe = (ctx) => `${ctx.nicheId || ''}|${ctx.mood}`;
export function vibeToCtx(vibe, mode) {
  const [nicheId, mood] = String(vibe || '').split('|');
  if (!MOODS[mood]) return null;
  if (mode === 'story' && !NICHES.some((n) => n.id === nicheId)) return null;
  return { mode, nicheId: mode === 'story' ? nicheId : null, mood };
}
/** Create (or complete) the shared context all fields derive from. */
export function makeContext(rng, mode, partial = {}) {
  const niche = mode === 'story' ? (NICHES.find((n) => n.id === partial.nicheId) || pick(rng, NICHES)) : null;
  const moodPool = niche ? niche.moods : MOOD_IDS;
  const mood = partial.mood && moodPool.includes(partial.mood) ? partial.mood : pick(rng, moodPool);
  return { mode, nicheId: niche ? niche.id : null, mood };
}

// ---------- field generators (each coherent with ctx + current brief) ----------
function genTone(rng, ctx) { return sample(rng, MOODS[ctx.mood].tone, 2).join(', '); }
function stylesFor(ctx) {
  const pool = VISUAL_STYLES.filter((v) => v.moods.includes(ctx.mood) && (ctx.mode === 'reel' ? v.faceless : v.story));
  return pool.length ? pool : VISUAL_STYLES.filter((v) => (ctx.mode === 'reel' ? v.faceless : v.story));
}
function genVisual(rng, ctx) {
  const palette = pick(rng, MOODS[ctx.mood].palettes);
  return `${pick(rng, stylesFor(ctx)).s}; palette: ${palette}`;
}
function lookFor(rng, p) {
  const o = protoOpts(p);
  if (o.kind === 'robot') return { look: `${pick(rng, ROBOT_FINISH)}, ${pick(rng, ROBOT_LIGHTS)}, ${pick(rng, ROBOT_DETAIL)}` };
  if (o.kind === 'animal') return { look: `${pick(rng, o.looks || ['distinctive markings'])}, ${pick(rng, ANIMAL_DETAIL)}` };
  return { look: `${pick(rng, HAIR)}, ${pick(rng, OUTFIT)}, ${pick(rng, DETAIL)}` };
}
/** Lead first, then a goal that suits the lead, then a setting that suits both, then supporting cast that suits the setting. */
function genStoryCast(rng, niche, dialogueMode) {
  const n = dialogueMode === 'dialogue' || dialogueMode === 'mixed' ? 2 : 1;
  for (let attempt = 0; ; attempt++) {
    const r = tryCast(rng, niche, n);
    if (r.cast.length === n || attempt >= 30) return r;
  }
}
function tryCast(rng, niche, n) {
  const lead = pick(rng, niche.protagonists);
  const leadTags = protoOpts(lead).k;
  const goal = pick(rng, fittingAll(niche.goals, leadTags));
  const goalTags = typeof goal === 'string' ? undefined : goal.k;
  const setting = pick(rng, fittingAll(niche.settings, leadTags, goalTags));
  const setTags = typeof setting === 'string' ? undefined : setting.k;
  const others = sample(rng, niche.protagonists.filter((p) => p !== lead && fits(setting, protoOpts(p).k) && (!setTags || !protoOpts(p).k || protoOpts(p).k.some((k) => setTags.includes(k)))), n - 1);
  const roles = [lead, ...others];
  const used = new Set();
  const cast = roles.map((r) => {
    const name = pick(rng, namesFor(protoOpts(r).g).filter((x) => !used.has(x))); used.add(name);
    return { name, role: r[0], age: r[1], tags: protoOpts(r).k, ...lookFor(rng, r), voice: pick(rng, VOICES) };
  });
  return { cast, setting: txt(setting), goal: txt(goal), tags: [leadTags, goalTags, setTags] };
}
function castToNotes(cast) {
  return cast.map((c) => `${c.name}: ${c.role.replace(/^an? /, '')}, ${c.age}, ${c.look}. Voice: ${c.voice}.`).join('\n');
}
function genConcept(rng, niche, cast, g) {
  const [a, b] = cast;
  const tags = g && cast[0].tags === g.cast[0].tags ? g.tags : [a.tags];
  const goal = g && cast[0].tags === g.cast[0].tags ? g.goal : txt(pick(rng, fittingAll(niche.goals, ...tags)));
  const where = g ? g.setting : txt(pick(rng, fittingAll(niche.settings, ...tags)));
  const obstacle = txt(pick(rng, fittingAll(niche.obstacles, ...tags))), twist = txt(pick(rng, fittingAll(niche.twists, ...tags)));
  const partner = b ? ` with ${b.name}, ${b.role},` : '';
  return { text: `${cap(prepFor(where))} ${where}, ${a.name}, ${a.role},${partner} ${goal}, but ${obstacle}. Twist: ${twist}.`, setting: where, goal };
}
function genTitle(rng, niche, cast, setting, goal) {
  if (!niche) return pick(rng, REEL_TITLES);
  const the = `the ${titleCase(setting.replace(/^(an?|the) /i, ''))}`;
  const where = `${cap(prepFor(setting))} ${the}`;
  const who = cast[0].name;
  const t = [`${who}'s Last Chance`, `Midnight ${where.replace(/^./, (c) => c.toLowerCase())}`, `${who} vs. Everything`, `One Week ${where.replace(/^./, (c) => c.toLowerCase())}`, `${who} of ${the}`, `Not Today, ${who}`];
  if (goal) t.push(`${who} ${titleCase(goal.replace(/^(must|tries to) /, ''))}`, `${who} ${titleCase(goal)}`);
  return pick(rng, t).replace(/\bthe the\b/gi, 'the').replace(/^(midnight|one week) (\w)/i, (m, a, b) => `${a} ${b}`);
}
function genDialogueMode(rng, ctx, source) {
  if (ctx.mode === 'reel') return weighted(rng, [['voiceover', 9], ['none', 1]]);
  return weighted(rng, [['voiceover', 4], ['dialogue', 3], ['mixed', 3]]);
}
function genAspect(rng, ctx) {
  if (ctx.mode === 'reel') return '9:16';
  return weighted(rng, [['9:16', 5], ['16:9', 3], ['1:1', 1], ['4:5', 1]]);
}
function genStructure(rng, source) {
  const s = analyzeSource(source);
  const ok = REEL_STRUCTURES.filter((r) => r.data === 'any' || (r.data === 'numbers' && s.numbers >= 3) || (r.data === 'dates' && s.dates >= 3));
  const w = ok.map((r) => [r, r.data === 'numbers' ? 1 + s.numbers / 5 : r.data === 'dates' ? 1 + s.dates / 3 : 1]);
  return weighted(rng, w);
}

/**
 * Randomize a brief.
 * @param {object} brief current brief (normalized)
 * @param {object} opts { seed, fill: 'all' | 'blanks', locks: string[] (fields to keep; 'timing' locks all four timing numbers), ctx }
 * sourceData, language and mode are NEVER changed (they are your inputs, not dice).
 * Returns { brief, ctx, seed }.
 */
export function randomizeBrief(brief, { seed = newSeed(), fill = 'all', locks = [], ctx: prevCtx } = {}) {
  const rng = mulberry32(seed);
  const mode = brief.mode === 'reel' ? 'reel' : 'story';
  const keep = fill === 'blanks' ? (prevCtx && prevCtx.mode === mode ? prevCtx : vibeToCtx(brief.vibe, mode)) : null;
  const ctx = makeContext(rng, mode, keep || {});
  const locked = new Set(locks);
  const blank = (k) => !locked.has(k) && (fill === 'all' || brief[k] === '' || brief[k] == null);
  const rollAll = (k) => fill === 'all' && !locked.has(k);
  const out = { ...brief };
  const timing = pickTiming(rng, mode, ctx.mood);
  if (rollAll('timing')) Object.assign(out, timing);
  if (blank('tone')) out.tone = genTone(rng, ctx);
  if (blank('visualStyle')) out.visualStyle = genVisual(rng, ctx);
  if (rollAll('dialogueMode')) out.dialogueMode = genDialogueMode(rng, ctx);
  if (mode === 'reel' && (out.dialogueMode === 'dialogue' || out.dialogueMode === 'mixed')) out.dialogueMode = 'voiceover'; // faceless: never on-camera speech
  if (rollAll('aspectRatio')) out.aspectRatio = genAspect(rng, ctx);
  if (mode === 'story') {
    const niche = NICHES.find((n) => n.id === ctx.nicheId);
    const gen = genStoryCast(rng, niche, out.dialogueMode);
    // Concept, characters and title share names/roles/setting, so they're built from one cast.
    const castBlank = blank('characterNotes');
    const cast = castBlank ? gen.cast : parseCast(out.characterNotes, gen.cast);
    if (castBlank) out.characterNotes = castToNotes(cast);
    let c = { setting: gen.setting, goal: castBlank ? gen.goal : null };
    if (blank('concept')) { c = genConcept(rng, niche, cast, gen); out.concept = c.text; }
    if (blank('title')) out.title = genTitle(rng, niche, cast, c.setting, c.goal);
    if (blank('audience')) out.audience = pick(rng, niche.audiences);
    if (blank('callToAction')) out.callToAction = pick(rng, niche.ctas);
    out.reelStructure = '';
  } else {
    // Faceless reel: no characters; the concept is an angle on YOUR data; the structure is biased by what the data contains.
    const st = blank('reelStructure') ? genStructure(rng, brief.sourceData) : (REEL_STRUCTURES.find((r) => r.id === brief.reelStructure) || genStructure(rng, brief.sourceData));
    out.reelStructure = st.id;
    if (blank('concept')) out.concept = pick(rng, st.angles);
    out.characterNotes = '';
    if (blank('title')) out.title = pick(rng, REEL_TITLES);
    if (blank('audience')) out.audience = pick(rng, REEL_AUDIENCES);
    if (blank('callToAction')) out.callToAction = pick(rng, REEL_CTAS);
    if (blank('narratorVoice')) out.narratorVoice = pick(rng, narratorsFor(ctx.mood));
  }
  if (mode === 'story' && blank('narratorVoice')) out.narratorVoice = out.dialogueMode === 'dialogue' ? '' : pick(rng, narratorsFor(ctx.mood));
  out.vibe = ctxToVibe(ctx);
  return { brief: out, ctx, seed };
}

/** Recover cast names from user-edited character notes ("Name: ...") so concept/title keep using them. */
function parseCast(notes, fallback) {
  const found = String(notes || '').split('\n').map((l) => l.match(/^\s*([\p{L}][\p{L}' -]{0,30}?)\s*[:—-]\s*(.+)$/u)).filter(Boolean)
    .map((m, i) => ({ ...(fallback[i] || fallback[0]), name: m[1].trim(), role: (m[2].split(',')[0] || fallback[0].role).trim(), tags: undefined }));
  return found.length ? found : fallback;
}

/**
 * Re-roll a single field while keeping it consistent with the rest of the brief.
 * Fields: title, concept, characterNotes, tone, visualStyle, audience, callToAction, timing, dialogueMode, aspectRatio, reelStructure, narratorVoice
 */
export function rerollField(brief, field, { seed = newSeed(), ctx, locks = [] } = {}) {
  const rng = mulberry32(seed);
  const mode = brief.mode === 'reel' ? 'reel' : 'story';
  const c = (ctx && ctx.mode === mode ? ctx : null) || vibeToCtx(brief.vibe, mode) || makeContext(rng, mode);
  const out = { ...brief };
  const niche = NICHES.find((n) => n.id === c.nicheId);
  switch (field) {
    case 'tone': out.tone = genTone(rng, c); break;
    case 'visualStyle': out.visualStyle = genVisual(rng, c); break;
    case 'timing': Object.assign(out, pickTiming(rng, mode, c.mood)); break;
    case 'dialogueMode': {
      out.dialogueMode = genDialogueMode(rng, c);
      // Two-person modes need two characters: top up the cast and mention them in the concept.
      if (mode === 'story' && (out.dialogueMode === 'dialogue' || out.dialogueMode === 'mixed') && countCast(out.characterNotes) < 2) {
        const have = parseCast(out.characterNotes, genStoryCast(rng, niche, 'voiceover').cast);
        const extra = genStoryCast(rng, niche, 'dialogue').cast.find((x) => !have.some((y) => y.name === x.name));
        if (extra) {
          out.characterNotes = [String(out.characterNotes).trim(), castToNotes([extra])].filter(Boolean).join('\n');
          if (out.concept && !out.concept.includes(extra.name)) out.concept = `${out.concept.trim()} ${extra.name}, ${extra.role}, is along for the ride.`;
        }
      }
      if (mode === 'story' && out.dialogueMode === 'dialogue') out.narratorVoice = '';
      break;
    }
    case 'aspectRatio': out.aspectRatio = genAspect(rng, c); break;
    case 'audience': out.audience = pick(rng, niche ? niche.audiences : REEL_AUDIENCES); break;
    case 'callToAction': out.callToAction = pick(rng, niche ? niche.ctas : REEL_CTAS); break;
    case 'narratorVoice': out.narratorVoice = pick(rng, narratorsFor(c.mood)); break;
    case 'title': {
      if (!niche) { out.title = pick(rng, REEL_TITLES); break; }
      const g = genStoryCast(rng, niche, out.dialogueMode);
      const setting = (String(out.concept).match(/^(?:In|On|At|Aboard) ([^,]+),/) || [])[1] || g.setting;
      out.title = genTitle(rng, niche, parseCast(out.characterNotes, g.cast), setting);
      break;
    }
    case 'reelStructure': { const st = genStructure(rng, out.sourceData); out.reelStructure = st.id; if (mode === 'reel') out.concept = pick(rng, st.angles); break; }
    case 'concept':
      if (mode === 'reel') { const st = REEL_STRUCTURES.find((r) => r.id === out.reelStructure) || genStructure(rng, out.sourceData); out.concept = pick(rng, st.angles); }
      else { const g = genStoryCast(rng, niche, out.dialogueMode); const cast = parseCast(out.characterNotes, g.cast); out.concept = genConcept(rng, niche, cast, cast[0].tags === g.cast[0].tags ? g : null).text; }
      break;
    case 'characterNotes': {
      if (mode === 'reel') { out.characterNotes = ''; break; }
      const g = genStoryCast(rng, niche, out.dialogueMode);
      out.characterNotes = castToNotes(g.cast);
      out.concept = genConcept(rng, niche, g.cast, g).text; // keep names/setting in sync
      break;
    }
    default: break;
  }
  // Linked fields (e.g. concept ↔ characters) never overwrite something you locked.
  for (const k of locks) {
    if (k === field) continue;
    if (k === 'timing') for (const t of TIMING_KEYS) out[t] = brief[t];
    else if (k in brief) out[k] = brief[k];
  }
  out.vibe = ctxToVibe(c);
  return { brief: out, ctx: c, seed };
}
export const TIMING_KEYS = ['clipCount', 'clipSeconds', 'wordsPerSecond', 'paddingSeconds'];
export const DICE_FIELDS = ['title', 'concept', 'characterNotes', 'tone', 'visualStyle', 'audience', 'callToAction', 'timing', 'dialogueMode', 'aspectRatio', 'reelStructure', 'narratorVoice'];
const countCast = (notes) => String(notes || '').split('\n').filter((l) => /^\s*[\p{L}][^:]{0,30}:/u.test(l)).length;

// ---------- honest combination count (lower bound, computed from the lists above) ----------
export function combinationCount(mode) {
  let total = 0;
  const timingCombos = (m) => {
    let n = 0;
    for (const t of TARGET_TOTAL[m]) for (const l of CLIP_SECOND_PRESETS.filter((x) => (m === 'reel' ? x >= 3 && x <= 10 : x >= 5))) { const c = Math.round(t / l); if (c >= 2 && c <= 10) n++; }
    return n * 4 /* pad */ * 5; /* pace jitter steps */
  };
  const pairs = (k) => (k * (k - 1)) / 2;
  if (mode === 'story') {
    const lookCount = (p) => { const o = protoOpts(p); return o.kind === 'robot' ? ROBOT_FINISH.length * ROBOT_LIGHTS.length * ROBOT_DETAIL.length : o.kind === 'animal' ? (o.looks || [1]).length * ANIMAL_DETAIL.length : HAIR.length * OUTFIT.length * DETAIL.length; };
    for (const n of NICHES) {
      // Counts only the single-lead case, with coherent (tag-compatible) story slots.
      let storyCombos = 0;
      for (const lead of n.protagonists) {
        const lt = protoOpts(lead).k;
        let chains = 0;
        for (const goal of fittingAll(n.goals, lt)) {
          const gt = typeof goal === 'string' ? undefined : goal.k;
          const sets = fittingAll(n.settings, lt, gt).length;
          chains += sets * fittingAll(n.obstacles, lt, gt).length * fittingAll(n.twists, lt, gt).length;
        }
        storyCombos += namesFor(protoOpts(lead).g).length * lookCount(lead) * VOICES.length * chains;
      }
      for (const m of n.moods) {
        const styles = VISUAL_STYLES.filter((v) => v.moods.includes(m) && v.story).length || 1;
        total += pairs(MOODS[m].tone.length) * styles * MOODS[m].palettes.length * storyCombos * n.audiences.length * n.ctas.length * timingCombos('story');
      }
    }
  } else {
    for (const m of MOOD_IDS) {
      const styles = VISUAL_STYLES.filter((v) => v.moods.includes(m) && v.faceless).length || 1;
      const angles = REEL_STRUCTURES.reduce((s, r) => s + r.angles.length, 0);
      total += pairs(MOODS[m].tone.length) * styles * MOODS[m].palettes.length * angles * REEL_TITLES.length * REEL_AUDIENCES.length * REEL_CTAS.length * narratorsFor(m).length * timingCombos('reel');
    }
  }
  return total;
}
export function formatBig(n) {
  const units = [[1e15, 'quadrillion'], [1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million']];
  for (const [v, u] of units) if (n >= v) return `${(n / v).toFixed(n / v >= 100 ? 0 : 1)} ${u}`;
  return n.toLocaleString('en-US');
}
