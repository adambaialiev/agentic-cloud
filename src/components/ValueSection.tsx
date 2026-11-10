import { H2, Screen } from './landing-kit';
import { VALUE_FACTS, VALUE_HEADING, VALUE_LEAD } from '../lib/value-copy';
import builtIn640 from '../assets/landing/value/built-in-640.webp';
import builtIn1200 from '../assets/landing/value/built-in-1200.webp';
import switchTools from '../assets/landing/value/switch-tools.svg';

/* One picture over each fact (note #1131, Adam, 10 Nov 2026, 11:26 UTC: the
   pair he picked of three candidates each). "Built in" was made with fal.ai
   (Recraft V4.1 Pro, prompts on note #1131): two lossless WebP files with the
   page colour (#fcfcfb) baked in, so no box shows, 640 px for a phone at
   1x/2x and 1200 px for a desk or a 3x phone. The drawing fills 60% of its
   frame's height, since Adam found it "too much enlarged" at 84% (12:40 UTC).
   "Switch tools, keep the context" was redrawn by hand as an SVG on one true
   isometric grid after Adam asked that its shapes be "aligned with each
   other" (12:40 UTC): every plate the same footprint on one vertical axis,
   the blue cap docked on top, the two spare caps on the same ground. The
   words under each picture say everything it shows, so both are decorative
   (alt=""). */
const ART: Readonly<Record<string, { src: string; srcSet?: string }>> = {
  'Built in': { src: builtIn1200, srcSet: `${builtIn640} 640w, ${builtIn1200} 1200w` },
  'Switch tools, keep the context': { src: switchTools },
};

/* The value in one breath (note #1085): its words live in lib/value-copy. */
export default function ValueSection() {
  return (
    <Screen id="value" label="Your agents, your cloud, your data">
      <h2 className={`[text-wrap:balance] ${H2}`}>{VALUE_HEADING}</h2>
      <p className="mt-4 type-base text-hint sm:mt-5 sm:type-md-sm [text-wrap:pretty] sm:w-3/5">{VALUE_LEAD}</p>
      {/* Two facts, a hairline over each: two columns from sm, one on a
          phone. A definition list, not cards (landing-copy-rules: no grid of
          identical cards, no eyebrows, no numbers). */}
      <dl className="mt-8 grid gap-x-10 sm:mt-10 sm:grid-cols-2">
        {VALUE_FACTS.map(({ title, line }) => {
          const art = ART[title]!;
          return (
            <div key={title} data-value-fact className="border-t border-hint/16 py-4 sm:py-5">
              <img
                data-value-art
                src={art.src}
                srcSet={art.srcSet}
                sizes={art.srcSet ? '(min-width: 640px) 50vw, 100vw' : undefined}
                alt=""
                width={1200}
                height={825}
                loading="lazy"
                decoding="async"
                className="mb-3 aspect-[16/11] h-auto w-full select-none sm:mb-4"
              />
              <dt className="type-base font-semibold text-white">{title}</dt>
              <dd className="mt-1 type-sm text-hint sm:type-base [text-wrap:pretty]">{line}</dd>
            </div>
          );
        })}
      </dl>
    </Screen>
  );
}
