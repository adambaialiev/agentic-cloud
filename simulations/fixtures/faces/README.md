# Fixture faces

The pictures the simulated Workspace draws for its people and its workplace.
They exist so a screenshot shows a real face everywhere the product would, and
never the grey fallback glyph.

| File | What it is | Where it came from |
| --- | --- | --- |
| `samira.svg` | Samira, the fixture owner | DiceBear **Open Peeps**, seed `Yasmin` |
| `james.svg` | James, the landing page's owner since 2026-09-16 (note #142: Samira replaced by a white male character) | DiceBear **Open Peeps**, seed `Sam`, background `ffdfbf`, skin `ffdbb4`, heads `short1..4,pomp,flatTop` |
| `leo.svg` | Leo, the fixture member | DiceBear **Open Peeps**, seed `Ruben` |
| `priya.svg` | Priya, a member on the landing's people deck | DiceBear **Open Peeps**, seed `Priya`, background `d1f4d1` |
| `tom.svg` | Tom, a member on the landing's people deck | DiceBear **Open Peeps**, seed `Noah`, background `c0e8ff`, light skin tones |
| `northstar.svg` | The Northstar Studio mark, also its site's favicon | drawn here |

**No real person is depicted.** These are illustrated avatars, which is what
makes them safe in anything forwarded to a stranger: nobody's photograph is
being used without their say-so, and no customer's face appears in our
marketing. That is a deliberate choice, not a placeholder — see the
`claims-we-never-make` knowledge page on what may be forwarded.

**Licence.** Open Peeps is by Pablo Stanley, released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — public domain,
commercial use included, no attribution required. Fetched once through
`api.dicebear.com` (9.x) and committed here; nothing calls that API at run
time, because a simulation blocks every origin but its own fixture server.

To fetch a different one, pick a seed from the playground and keep the same
options so the set stays one family:

```sh
curl -o simulations/fixtures/faces/<name>.svg \
  'https://api.dicebear.com/9.x/open-peeps/svg?seed=<Seed>&face=smile,cheeky,calm&backgroundColor=ffdfbf'
```

**The agents' faces are not here.** Ruby and Milo wear the product's own
avatars — `backend/assets/agent-avatars/ruby.jpg` and `milo.jpg`, the same
files a real agent gets — served by the fixture at `/workspace/avatars/<slug>`,
which is the address the real backend serves them at too.
