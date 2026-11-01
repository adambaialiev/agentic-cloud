/**
 * The vocabulary behind word-based preview names (`brave-otter-427`).
 *
 * Every word here is picked to survive being READ ALOUD off a phone screen and
 * retyped by someone else — that is the whole job of a preview link. So:
 *
 *  - one obvious spelling (no `grey`/`gray`, no `-ise`/`-ize`, no silent
 *    doubles a listener has to guess at);
 *  - concrete and picturable, because a picture is what makes it stick;
 *  - 3–10 letters, lowercase a–z only, so a name stays short and every token
 *    is a valid DNS label on its own;
 *  - nothing that reads as an official or credential surface. The two lists
 *    are checked against DEPLOYMENT_NAME_DENYLIST in the unit tests, since a
 *    preview slug shares the apps domain with paid hosting sites — a
 *    `secure-bank-402.agentbuilt.app` we minted ourselves would be a
 *    phishing gift.
 *
 * The two lists are kept disjoint so a name never reads as a stutter
 * (`forest-forest`), and sorted so a duplicate is visible in review.
 */

/** Adjectives: colour, weather, light, character, motion, season, terrain. */
export const PREVIEW_ADJECTIVES: readonly string[] = [
  'airy', 'alpine', 'amber', 'ample', 'ancient', 'arctic', 'autumn', 'azure',
  'balmy', 'bold', 'boreal', 'bounding', 'brave', 'breezy', 'bright', 'brisk',
  'broad', 'bronze', 'calm', 'candid', 'cheery', 'chilly', 'classic', 'clever',
  'cloudy', 'coastal', 'cobalt', 'copper', 'coral', 'cosmic', 'crimson',
  'crisp', 'curious', 'dappled', 'daring', 'desert', 'dewy', 'downy',
  'drifting', 'eager', 'earnest', 'eastern', 'elegant', 'emerald', 'evening',
  'fabled', 'fearless', 'festive', 'fleet', 'foggy', 'frosty', 'gallant',
  'generous', 'gentle', 'genuine', 'gilded', 'gleaming', 'gliding', 'glossy',
  'glowing', 'golden', 'graceful', 'grand', 'hazy', 'hearty', 'highland',
  'honest', 'humble', 'indigo', 'inland', 'ivory', 'jade', 'jolly', 'joyful',
  'keen', 'kindly', 'lilac', 'little', 'lively', 'loyal', 'lucid', 'lucky',
  'luminous', 'lunar', 'marble', 'mellow', 'merry', 'midnight', 'mighty',
  'mindful', 'misty', 'morning', 'nimble', 'noble', 'northern', 'oceanic',
  'olive', 'opal', 'patient', 'peaceful', 'pearl', 'petite', 'placid',
  'pleasant', 'plucky', 'polar', 'proud', 'quick', 'quiet', 'radiant', 'rainy',
  'rapid', 'roaming', 'ruby', 'russet', 'rustic', 'sable', 'saffron', 'satin',
  'scarlet', 'serene', 'shining', 'silken', 'silver', 'simple', 'slender',
  'smooth', 'snowy', 'soaring', 'solar', 'southern', 'spirited', 'spring',
  'starlit', 'steady', 'stellar', 'stormy', 'sturdy', 'sublime', 'summer',
  'sunlit', 'sunny', 'swift', 'tall', 'teal', 'tender', 'tidal', 'timeless',
  'tiny', 'tranquil', 'trusty', 'twilit', 'umber', 'upbeat', 'upland',
  'valiant', 'vast', 'velvet', 'vernal', 'violet', 'vivid', 'wandering',
  'warm', 'western', 'whimsical', 'wide', 'wild', 'windy', 'winter', 'wintry',
  'witty', 'wondrous', 'woolly', 'zealous', 'zesty',
];

/** Nouns: animals, plants, landscape, sky, and things you can hold. */
export const PREVIEW_NOUNS: readonly string[] = [
  'acorn', 'albatross', 'alder', 'anchor', 'anvil', 'arbor', 'aspen', 'atlas',
  'aurora', 'avocet', 'badger', 'banner', 'bay', 'beacon', 'beetle', 'bell',
  'birch', 'bison', 'blossom', 'bluff', 'bobcat', 'boulder', 'bramble',
  'bridge', 'brook', 'canoe', 'canyon', 'cascade', 'cedar', 'cicada', 'cliff',
  'clover', 'cobra', 'comet', 'compass', 'condor', 'cottage', 'cove', 'coyote',
  'crane', 'creek', 'cricket', 'delta', 'dolphin', 'dragonfly', 'dune',
  'eagle', 'eclipse', 'egret', 'ember', 'falcon', 'ferret', 'ferry', 'finch',
  'firefly', 'fjord', 'forest', 'fox', 'galaxy', 'garden', 'gecko', 'glacier',
  'glade', 'gopher', 'grotto', 'grove', 'harbor', 'harp', 'heather',
  'hedgehog', 'heron', 'hollow', 'horizon', 'ibex', 'ibis', 'iguana', 'inlet',
  'island', 'ivy', 'jaguar', 'juniper', 'kayak', 'kestrel', 'kettle',
  'kingfisher', 'koala', 'lagoon', 'lantern', 'laurel', 'lemur', 'lichen',
  'lodge', 'lotus', 'lynx', 'magpie', 'maple', 'marmot', 'marsh', 'marten',
  'meadow', 'meerkat', 'mesa', 'meteor', 'mongoose', 'moose', 'mosaic', 'moss',
  'narwhal', 'nebula', 'newt', 'nova', 'oasis', 'obelisk', 'ocelot', 'orbit',
  'orchid', 'osprey', 'otter', 'owl', 'panda', 'panther', 'pebble', 'pelican',
  'penguin', 'pennant', 'pika', 'pine', 'planet', 'plover', 'poppy',
  'porcupine', 'prairie', 'puffin', 'quail', 'quarry', 'quasar', 'quill',
  'rabbit', 'raccoon', 'rapids', 'raven', 'reef', 'ribbon', 'ridge', 'river',
  'robin', 'sail', 'salmon', 'satchel', 'savanna', 'schooner', 'seahorse',
  'seal', 'sequoia', 'solstice', 'sparrow', 'spruce', 'starling', 'stork',
  'sturgeon', 'summit', 'swallow', 'tapestry', 'tapir', 'teapot', 'thicket',
  'thistle', 'tiger', 'tortoise', 'toucan', 'tower', 'tundra', 'turtle',
  'valley', 'vulture', 'walrus', 'warbler', 'weasel', 'whale', 'willow',
  'windmill', 'wombat', 'wren', 'yak', 'zebra', 'zenith',
];
