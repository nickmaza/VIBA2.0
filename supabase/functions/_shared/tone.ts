// Review tone, following the dictionary approach used for consumer product
// reviews (Jin 2023, "More than words: Can tone of consumer product reviews
// help predict firms' fundamentals?", Journal of Business Finance &
// Accounting 50(9-10)): each review's positive and negative tone is the share
// of its words that are positive or negative opinion words.
//
// Lexicon: Hu & Liu (2004) customer-review opinion lexicon (lexicon.ts).
// Negation follows Loughran & McDonald (2011): an opinion word preceded by a
// negator within three words of the same clause is negated; a negated
// positive word counts as negative, a negated negative word is not counted.
import { NEGATIVE_WORDS, POSITIVE_WORDS } from "./lexicon.ts";

const POSITIVE = new Set(POSITIVE_WORDS.split(/\s+/).filter(Boolean));
const NEGATIVE = new Set(NEGATIVE_WORDS.split(/\s+/).filter(Boolean));

// Positive only when negated: "doesn't work", "don't like", "no support".
const NEGATION_ONLY = new Set(
  "like likes liked work works worked working support supports supported supporting refund refunded".split(" "),
);

const NEGATORS = new Set(
  ("not no never none nobody nothing neither nor nowhere without hardly barely scarcely cannot cant dont doesnt " +
    "didnt isnt wasnt arent werent wont wouldnt shouldnt couldnt aint havent hasnt hadnt").split(" "),
);

// Game-world vocabulary the lexicon marks negative ("kill", "dark", "hard")
// that in game reviews describes play, not opinion. Ignored for Steam.
const GAME_NEUTRAL = new Set(
  ("kill kills killed killing killer dead death die dies died dying enemy enemies attack attacks destroy monster zombie " +
    "bloody crime criminal evil villains demon hell dark darkness hard difficult difficulty brutal insane insanely sneak " +
    "steal steals stealing murder scary creepy terror violent chaos chaotic savage danger dangerous").split(" "),
);

const TOKEN = /[a-z][a-z'+-]*/g;
// words plus the punctuation that ends a negation's scope ("doesn't work. Terrible")
const TOKEN_OR_STOP = /[a-z][a-z'+-]*|[.!?;:,()]/g;

export interface ReviewTone {
  words: number;
  pos: number;
  neg: number;
}

/** Lowercase words of a product name, ignored when scoring that product's reviews ("Affirm", "Best Buy", "Dead"). */
export function nameWords(name: string): Set<string> {
  return new Set((name.toLowerCase().match(TOKEN) ?? []).filter((w) => w.length >= 3));
}

export function scoreReview(text: string, opts: { game?: boolean; ignore?: Set<string> } = {}): ReviewTone {
  const tokens = text.toLowerCase().replace(/[‘’ʼ]/g, "'").match(TOKEN_OR_STOP) ?? [];
  let words = 0;
  let pos = 0;
  let neg = 0;
  let lastNegator = -100;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].length === 1 && ".!?;:,()".includes(tokens[i])) {
      lastNegator = -100; // a clause boundary ends the negation
      continue;
    }
    words++;
    const t = tokens[i].replace(/^['-]+|['-]+$/g, "");
    if (!t) continue;
    if (NEGATORS.has(t) || t.endsWith("n't")) {
      lastNegator = i;
      continue;
    }
    if (opts.ignore?.has(t)) continue;
    const negated = i - lastNegator <= 3;
    if (POSITIVE.has(t) || NEGATION_ONLY.has(t)) {
      if (negated) neg++;
      else if (POSITIVE.has(t)) pos++;
    } else if (NEGATIVE.has(t)) {
      if (opts.game && GAME_NEUTRAL.has(t)) continue;
      if (!negated) neg++;
    }
  }
  return { words, pos, neg };
}
