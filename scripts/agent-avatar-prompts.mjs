// The prompt sheet for the 40 agent avatars — one dog per name in
// TELEGRAM_AGENT_NAME_POOL (backend/src/types/user.ts).
//
// Read this before editing:
//
// The avatar's real job is a ~40px circle in the Telegram chat list, where the
// user has to tell Nina from Nora at a glance. That drives every choice here:
//
//   * PIXEL ART, NOT PHOTOREAL. Flat colour blocks and hard edges survive a
//     40px circle; fur and bokeh turn to mush. It also matches the Claude Code
//     pixel mark and reads as a game companion, which is the point.
//     Note the generator re-quantises the output onto a real pixel grid —
//     diffusion models draw pixel-art-FLAVOURED images whose "pixels" are
//     off-grid and anti-aliased, which reads as blurry fake retro.
//   * BUST, NOT SCENE. The head fills the frame and the body is cut below the
//     shoulders; anything wider shrinks the only part that carries identity.
//   * MAXIMUM SEPARATION. Forty breeds picked to differ in silhouette (ear
//     shape, muzzle length, head mass) AND coat colour, because at avatar size
//     silhouette and colour are the only two signals that survive. Forty
//     golden retrievers in different poses would be useless. At forty the
//     budget is tight, so read the whole sheet before adding a breed: the
//     warm gold/red/tan half fills up first, and the sets that already sit
//     closest — Ivy/Juno (grey), Nora/Greta/Sadie (black), Iris/Pearl (white),
//     Emma/Gus (red-and-white with a blaze) — are carried by silhouette and
//     head mass alone. Caleb was a brown flat-coated retriever for one round
//     and was indistinguishable from Sam; it took a whole new head shape, not
//     a different brown, to separate them.
//   * PICK A BREED THE MODEL HAS SEEN. Rowan was a Bedlington terrier twice —
//     once by name, once described as a lamb, fleece and tassels and all — and
//     came back both times as a plain smooth yellow dog with tassels on its
//     ears, i.e. Leo. There is no prompt fix for a breed the model cannot
//     draw: generate it, look at it beside its neighbours, and if it is not
//     recognisably that breed, spend the slot on one it knows.
//   * NO FLAT FACES. Theo was a French bulldog and Oscar was a pug until
//     #1012 replaced both. A brachycephalic muzzle is the one feature that
//     vanishes at 40px, and it takes half the dog's identity with it — what
//     is left is a round blob. Every dog here has a muzzle you can see.
//   * NOTHING BUT THE DOG. An earlier pass put each dog at a desk with a
//     monitor and a lamp. It looked good at full size and cost the dog half
//     the frame at avatar size, where only the dog carries identity. The
//     background is now one flat colour on purpose.
//   * SAFE INSIDE A CIRCLE. Telegram crops to a circle, so nothing that
//     matters may live in the corners.
//
// Print every final prompt with:  node scripts/generate-agent-avatars.mjs --print

/**
 * Shared across all 40 so they read as one litter: same outline weight, same
 * shading, same background. Only the dog changes. `{{dog}}` is substituted per
 * name.
 */
export const STYLE_PROMPT = [
  'Cute cartoon pixel-art portrait of {{dog}}, facing the viewer.',
  'Drawn as a detailed 128x128 sprite with small crisp pixels — fine pixel detail, not coarse chunky blocks.',
  'Cartoon character styling: simplified friendly shapes, large expressive eyes, a clean dark outline around the dog, flat cel-shaded colours with only one or two shading steps.',
  'Modern indie-game pixel art, charming and warm, not photorealistic.',
  'Hard aliased edges, no gradients, no blur, no anti-aliasing, no glow.',
  'Alert, friendly, happy expression, mouth closed.',
  'Tightly cropped: the head fills most of the frame and the body is cut off just below the shoulders.',
  'Plain flat dark slate-grey background, a single uniform colour with nothing in it — no desk, no furniture, no monitor, no lamp, no props, no scenery, no pattern, no gradient.',
  'A subtle warm rim light along the top of the dog so it separates cleanly from the background.',
  // "Safe inside a circular crop" made the model DRAW the circle — a white
  // vignette with bare corners, which Telegram shows uncropped on the profile
  // page. Ask for a full-bleed square and describe the centring instead.
  'Square 1:1 image that fills the entire frame edge to edge, with the head centred.',
  'No circular mask, no vignette, no border, no rounded corners, no white edges, no framing device of any kind.',
  'No text, no lettering, no logos, no watermark, no humans, no hands, no clothing on the dog.',
].join(' ');

/**
 * Style-reference wrapper used for every dog after the hero, so all 40 inherit
 * one lighting setup instead of drifting. `{{prompt}}` is the full style prompt
 * for that dog.
 */
export const REFERENCE_PROMPT = [
  'Use the attached image strictly as a reference for art style, palette, pixel size, outline weight, lighting, framing and background — not for the animal itself.',
  'Keep the identical cartoon pixel-art style, pixel scale, outline, shading, plain flat background colour and crop.',
  'Replace the dog with a clearly different one: {{prompt}}',
].join(' ');

/**
 * The hero is generated first from STYLE_PROMPT alone and then conditions the
 * other thirty-nine. A mid-tone, medium-fur, medium-muzzle dog sets the palette
 * best — extremes (pure white samoyed, black poodle) would bake in a contrast
 * the rest can't match.
 *
 * Keep it Leo, and keep --hero-url when you top the pool up: the dogs already
 * on disk were conditioned on one Leo, and a fresh hero would relight the new
 * ones just differently enough to split the litter in two.
 */
export const HERO_NAME = 'Leo';

/**
 * name -> the dog, written as it should appear inside STYLE_PROMPT.
 * Order matches TELEGRAM_AGENT_NAME_POOL; the generator fails loudly if the two
 * lists ever drift apart.
 */
export const DOGS = {
  Alex: 'a black-and-tan German shepherd with tall upright pointed ears and a long muzzle',
  Leo: 'a light golden retriever with soft feathered floppy ears and a broad friendly muzzle',
  Theo: 'a salt-and-pepper miniature schnauzer with dense bushy silver eyebrows and a long silver beard hanging from a rectangular muzzle, and small folded V-shaped ears',
  Felix: 'a black-and-white border collie with a white blaze down the muzzle, one ear up and one folded',
  Oscar: 'a blue merle Australian shepherd with a mottled patchwork coat of slate grey and charcoal, copper-tan eyebrow dots and cheek patches, a white blaze and chest, warm amber eyes and half-pricked folded ears',
  Noah: 'a grey-and-white Siberian husky with pale ice-blue eyes and thick upright ears',
  Kai: 'a red-orange Shiba Inu with cream cheeks, small triangular ears and a fox-like face',
  Ben: 'a tricolour beagle with a bold black mask across the top of the head and around the eyes, tan cheeks, a white muzzle and blaze, and very long low drooping ears',
  Sam: 'a very dark chocolate-brown Labrador, almost espresso coloured, with a glossy short coat, a slightly lighter muzzle and short soft folded ears',
  Jack: 'a scruffy white Jack Russell terrier with a tan patch over one eye and a wiry rough coat',
  Mia: 'a tiny cream Pomeranian, an enormous fluffy ruff of fur around a small pointed face',
  Zoe: 'a long-haired ginger dachshund with a long narrow muzzle and very long silky drooping ears',
  Nora: 'a black standard poodle with a dense tightly curled coat and a long elegant muzzle',
  Ivy: 'a silver-grey Italian greyhound, extremely slender head, long thin muzzle, small rose-folded ears',
  Emma: 'a Blenheim Cavalier King Charles spaniel, chestnut and white, with long wavy feathered ears',
  Eva: 'a pure white Samoyed with a thick plush coat, small upright ears and the classic upturned smiling mouth',
  Nina: 'a Dalmatian, bright white with crisp black spots across the face and short smooth ears',
  Ada: 'a Pembroke Welsh corgi, orange-and-white, with oversized upright rounded ears and a fox-like face',
  Ruby: 'an Irish setter with a vivid bright copper-red silky coat and very long feathered ears',
  Stella: 'a blue-grey Great Dane with a huge square head, soft folded ears and a noble calm expression',
  Milo: 'a white-and-red-sable Papillon with enormous upright butterfly ears heavily fringed with long white hair, and a fine pointed muzzle',
  Hugo: 'a deep mahogany-and-black bloodhound with a heavily wrinkled hooded brow, long drooping jowls and immense low-set velvet ears',
  Gus: 'a deep red-and-white Saint Bernard with a massive broad head, a dark mask around the eyes, a wide white blaze and heavy soft folded ears',
  Toby: 'a tiny Yorkshire terrier with a long straight silky coat, steel-blue over the back and rich tan on the face, and small upright V-shaped ears',
  Otis: 'a shaggy grey-and-white Old English sheepdog, a huge round mass of soft shaggy fur, a long fringe parting just enough for two bright eyes to look through, and no ears visible at all',
  Elias: 'a pale cream-gold Afghan hound with a very long narrow muzzle, a fine aristocratic head and extremely long straight flowing silky hair falling from the ears',
  Caleb: 'a rich tan Pharaoh hound with a very fine chiselled wedge-shaped head, a long clean narrow muzzle, enormous upright pointed ears and warm amber eyes',
  Isaac: 'a brindle-and-white bull terrier with the unmistakable egg-shaped convex head sloping straight to the nose, tiny triangular eyes and small erect ears',
  Marcus: 'a fawn bullmastiff with a coal-black mask over a broad square muzzle, small dark folded ears and a heavy wrinkled brow',
  Rowan: 'a deep cinnamon-red Chow Chow with an enormous dense lion\'s mane of fur framing a broad serious face, tiny rounded ears almost buried in the ruff, deep-set dark eyes and a short but clearly defined broad muzzle',
  Iris: 'a blue belton English setter, crisp white densely flecked all over with fine blue-black speckles, with a long straight muzzle and long feathered drooping ears',
  Hazel: 'a warm chocolate-brown Lagotto Romagnolo with a dense woolly curled coat, a full round beard and thick round eyebrows, and folded triangular ears',
  Clara: 'a white-and-pale-grey borzoi with an extremely long narrow arched head and muzzle, tiny rose ears folded flat back against the skull, and a long silky wavy coat',
  Freya: 'a wolf-grey Keeshond with an enormously thick plush stand-off coat, a small foxy face buried in a huge ruff, tiny sharp pointed ears and dark spectacle markings radiating back from the eyes',
  Juno: 'a silver mouse-grey Weimaraner with a short glossy coat, pale amber eyes and long smooth velvet drop ears',
  Willow: 'a golden sable-and-white rough collie with a very long narrow tapering muzzle, a full mane of long fur around the neck and small tipped-over ears',
  Greta: 'a solid deep black Newfoundland with a huge blocky head, a thick soft coat, small folded ears and a gentle heavy-lidded expression',
  Pearl: 'a crisp white English pointer with one large solid liver-brown patch covering an eye and ear, a long clean muzzle and neat folded ears',
  Sadie: 'a jet-black Puli whose entire coat hangs in long thin natural cords like dreadlocks that hide the ears completely, with two bright eyes and a black nose showing clearly through the cords',
  Rosa: 'a fawn-and-white smooth-coated chihuahua with a tiny round apple-domed head, a short but clearly pointed muzzle and enormous upright flaring ears',
};

/** The finished prompt for one name (no style reference). */
export function buildPrompt(name) {
  const dog = DOGS[name];
  if (!dog) {
    throw new Error(`No dog defined for "${name}" — add one to DOGS in scripts/agent-avatar-prompts.mjs`);
  }
  return STYLE_PROMPT.replace('{{dog}}', dog);
}

/** The finished prompt for one name, conditioned on the hero image. */
export function buildReferencePrompt(name) {
  return REFERENCE_PROMPT.replace('{{prompt}}', buildPrompt(name));
}

/**
 * The reserved Bernese candidate (note #434) — NOT in DOGS, because it is not
 * a pool name: it lives at backend/assets/agent-avatars/workspace-agent.jpg
 * under a slug no room agent can reach. Since note #582, new workplaces pick
 * among this dog and the shepherd/big-working-dog subset of DOGS. It was
 * chosen against the whole sheet above:
 * the litter has no black/rust/white tricolour head (Gus is red-and-white,
 * Greta solid black, Ben a small tricolour with beagle ears), so at 40px it
 * reads as a different kind of agent, which is the job — one steward per
 * person, workplace-wide, beside forty room agents. Same STYLE_PROMPT, same
 * Leo reference, so it is still one litter's drawing of a different dog.
 */
export const WORKSPACE_AGENT_SLUG = 'workspace-agent';
export const WORKSPACE_AGENT_DOG =
  'a Bernese mountain dog, tricolour: a glossy black head and ears, rich rust-red eyebrow dots and cheeks, and a wide white blaze down the muzzle and white chest, with a broad gentle head and soft folded ears';

/** The finished prompt for the Workspace Agent's face, conditioned on the hero. */
export function buildWorkspaceAgentPrompt() {
  return REFERENCE_PROMPT.replace('{{prompt}}', STYLE_PROMPT.replace('{{dog}}', WORKSPACE_AGENT_DOG));
}
