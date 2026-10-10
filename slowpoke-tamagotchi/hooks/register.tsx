import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Anim, Pet } from '../types'

type Engine = Parameters<Hook<'turn.complete'>>[0]
type Care = 'feed' | 'clean' | 'play'
type Pose = 'idle' | 'blink' | 'happy' | 'grumpy' | 'sleep' | 'eat' | 'clean' | 'play' | 'evolve'

const pet = atom({ plugin: 'slowpoke-tamagotchi', key: 'pet' } as const, null as Pet | null)
const anim = atom({ plugin: 'slowpoke-tamagotchi', key: 'anim' } as const, {
  tick: 0,
  act: null,
  actUntil: 0,
  bubble: null,
  bubbleUntil: 0,
  lastAct: 0,
} as Anim)

const STORE_KEY = 'pet'
const MINUTE = 60_000
const MAX_MINUTES = 7 * 24 * 60
const TICK_MS = 500
const SLEEP_AFTER = 5 * MINUTE
const STAGES = [
  { from: 0, name: 'Baby Slowpoke' },
  { from: 200_000, name: 'Slowpoke' },
  { from: 2_000_000, name: 'Elder Slowpoke' },
  { from: 10_000_000, name: 'Ancient Slowpoke' },
]

// Pixel art. One character is one pixel; two pixel rows make one terminal row.
// `.` is transparent. `k` outline, `p` pink, `c` cream belly, `w` eye white.
// Overlays add `g` shell, `y` gold, `r` berry, `x` sparkle, `z` sleep, `b` poop.
const SPRITE = [
  '................',
  '.....kkkkk......',
  '....kppppppk....',
  '...kppppppppk...',
  '..kpwwppppwwpk..',
  '..kpwkppppkwpk..',
  '..kppppppppppk..',
  '.kpppcccccccppk.',
  '.kpppccccccpppk.',
  '..kppppppppppk..',
  '..kkk....kkk....',
  '................',
]
const SLEEPY = SPRITE.map((row, i) =>
  i === 4 ? '..kpkkppppkkpk..' : i === 5 ? '..kppppppppppk..' : row,
)
// Faces by pose, rows 4 and 5 of the sprite.
const FACES: Partial<Record<Pose, [string, string]>> = {
  blink: [SLEEPY[4], SLEEPY[5]],
  sleep: [SLEEPY[4], SLEEPY[5]],
  happy: ['..kpkppppppkpk..', '..kppppppppppk..'],
  grumpy: ['..kkkkppppkkkk..', SPRITE[5]],
}

const WIDTH = 26
const ROWS = 14
const TOP = 2 // where the sprite sits, in pixel rows, when still
const PALETTE: Record<string, number> = {
  k: 0x2b2b3a,
  p: 0xf7a8c4,
  c: 0xfbe3c2,
  w: 0xffffff,
  b: 0x7a4a2a,
  g: 0x9a6b3c,
  y: 0xffd54a,
  r: 0xff4d4d,
  x: 0xd9fbff,
  z: 0x9ad0ff,
}
const DEFAULT_COLOR = 0x01000000

const clamp = (n: number) => Math.max(0, Math.min(100, n))
const stageIndex = (tokens: number) => STAGES.filter(s => tokens >= s.from).length - 1
const stageOf = (tokens: number) => STAGES[stageIndex(tokens)].name
const ACT = { feed: 'eat', clean: 'clean', play: 'play' } as const

const hatch = (now: number): Pet => ({
  hunger: 80,
  happiness: 80,
  poop: 0,
  tokens: 0,
  updatedAt: now,
})

let stopTicker: (() => void) | undefined

// Brings the stats up to date with the clock. Works minute by minute so the
// remainder of a partial minute carries over to the next call.
function decay(p: Pet, now: number): Pet {
  const elapsed = Math.floor((now - p.updatedAt) / MINUTE)
  const minutes = Math.min(elapsed, MAX_MINUTES)
  if (minutes <= 0) return p

  let { hunger, happiness, poop } = p
  for (let i = 1; i <= minutes; i++) {
    if (i % 6 === 0) hunger = clamp(hunger - 1)
    if (i % 30 === 0) poop = Math.min(3, poop + 1)
    if (i % 10 === 0) {
      const isMiserable = poop > 0 || hunger === 0
      happiness = clamp(happiness - (isMiserable ? 2 : 1))
    }
  }

  const updatedAt = elapsed > MAX_MINUTES ? now : p.updatedAt + minutes * MINUTE
  return { ...p, hunger, happiness, poop, updatedAt }
}

function care(p: Pet, what: Care): { pet: Pet; text: string } {
  if (what === 'feed') {
    if (p.hunger >= 100) {
      return { pet: p, text: 'too full... *blink*' }
    }
    return {
      pet: { ...p, hunger: clamp(p.hunger + 40), happiness: clamp(p.happiness + 3) },
      text: 'mmm, berry',
    }
  }

  if (what === 'clean') {
    if (p.poop === 0) return { pet: p, text: 'nothing to clean... *smug*' }
    return {
      pet: { ...p, poop: 0, happiness: clamp(p.happiness + 5) },
      text: 'ahh, much better',
    }
  }

  if (p.hunger < 20) return { pet: p, text: 'too hungry to play...' }
  return {
    pet: { ...p, hunger: clamp(p.hunger - 5), happiness: clamp(p.happiness + 15) },
    text: 'wheee... slowly',
  }
}

const statusLine = (p: Pet) =>
  `${stageOf(p.tokens)} · full ${p.hunger} · happy ${p.happiness} · poop ${p.poop}`

const bar = (n: number) => '█'.repeat(Math.round(n / 10)).padEnd(10, '░')

const mood = (p: Pet) => {
  if (p.hunger === 0) return 'starving'
  if (p.poop >= 2) return 'grumpy about the mess'
  if (p.happiness < 30) return 'sulking'
  if (p.happiness >= 70) return 'content'
  return 'meh'
}

function poseOf(p: Pet, a: Anim, now: number): Pose {
  if (a.act && a.tick < a.actUntil) return a.act
  if (now - a.lastAct > SLEEP_AFTER) return 'sleep'
  if (p.hunger === 0 || p.happiness < 30) return 'grumpy'
  if (p.happiness >= 70) return 'happy'
  return a.tick % 16 >= 14 ? 'blink' : 'idle'
}

// The whole band as pixels: the sprite in its pose, its evolution overlays,
// the pose's effects, and the poop piles on the ground.
function compose(p: Pet, a: Anim, now: number): string[] {
  const pose = poseOf(p, a, now)
  const flip = a.tick % 2 === 0
  const stage = stageIndex(p.tokens)

  const sprite = SPRITE.map(row => row.split(''))
  const face = FACES[pose]
  if (face) {
    sprite[4] = face[0].split('')
    sprite[5] = face[1].split('')
  }

  if (stage >= 1) {
    for (const row of [2, 3]) for (let x = 5; x <= 10; x++) sprite[row][x] = 'g'
  }
  if (stage >= 2) {
    sprite[0][6] = 'y'
    sprite[0][8] = 'y'
    sprite[0][10] = 'y'
  }
  if (pose === 'eat') {
    const mouth = flip ? [6, 7, 8, 9] : [7, 8]
    for (const x of mouth) sprite[8][x] = 'k'
    if (flip) {
      sprite[6][13] = 'r'
      sprite[6][14] = 'r'
      sprite[7][14] = 'r'
    }
  }

  const grid: string[][] = Array.from({ length: ROWS }, () => Array(WIDTH).fill('.'))
  const bob = pose === 'play' || pose === 'happy' ? (flip ? 0 : TOP) : TOP
  sprite.forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch !== '.') grid[y + bob][x] = ch
    }),
  )

  const put = (y: number, x: number, ch: string) => {
    if (y >= 0 && y < ROWS && x >= 0 && x < WIDTH) grid[y][x] = ch
  }

  for (let i = 0; i < p.poop; i++) {
    const x = 17 + i * 3
    put(12, x + 1, 'b')
    put(13, x, 'b')
    put(13, x + 1, 'b')
    put(13, x + 2, 'b')
  }

  if (pose === 'sleep') {
    if (a.tick % 8 < 4) {
      put(0, 20, 'z')
      put(0, 21, 'z')
      put(0, 22, 'z')
      put(1, 22, 'z')
    } else {
      put(1, 21, 'z')
      put(0, 23, 'z')
    }
  }

  if (pose === 'clean') {
    const spots = flip ? [[8, 18], [6, 23]] : [[10, 15], [9, 24]]
    for (const [y, x] of spots) put(y, x, 'x')
  }

  if (pose === 'evolve') {
    const colour = flip ? 'x' : 'y'
    for (const [y, x] of [[0, 0], [0, 25], [6, 0], [6, 25], [13, 0], [13, 25]]) {
      put(y, x, colour)
    }
  }

  return grid.map(row => row.join(''))
}

// Packs pixels into a Raster: two pixel rows per cell, drawn with the upper
// half block. Each cell is [codePoint, foreground, background], little-endian.
function toCells(grid: string[]): string {
  const columns = grid[0].length
  const rows = grid.length / 2
  const words = new Uint32Array(columns * rows * 3)

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const top = PALETTE[grid[r * 2][c]]
      const bottom = PALETTE[grid[r * 2 + 1][c]]
      let glyph = 0x20
      let fg = DEFAULT_COLOR
      let bg = DEFAULT_COLOR

      if (top !== undefined && bottom === undefined) {
        glyph = 0x2580
        fg = top
      } else if (top === undefined && bottom !== undefined) {
        glyph = 0x2584
        fg = bottom
      } else if (top !== undefined && bottom !== undefined) {
        glyph = 0x2580
        fg = top
        bg = bottom
      }

      words.set([glyph, fg, bg], (r * columns + c) * 3)
    }
  }

  return new Uint8Array(words.buffer).toBase64()
}

async function act($: Engine, what: Care): Promise<string> {
  const now = await $.clock.now()
  const out = {} as { pet: Pet; text: string }
  await update($, pet, prev => {
    const done = care(decay(prev ?? hatch(now), now), what)
    out.pet = done.pet
    out.text = done.text
    return done.pet
  })
  await $.store.set(STORE_KEY, out.pet)
  await update($, anim, a => ({
    ...a,
    act: ACT[what],
    actUntil: a.tick + 6,
    bubble: out.text,
    bubbleUntil: a.tick + 12,
    lastAct: now,
  }))
  $.ui.status(statusLine(out.pet))
  return out.text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'slowpoke', description: 'Show how your Slowpoke is doing' })
    await $.command.register({ name: 'slowpoke-feed', description: 'Feed your Slowpoke' })
    await $.command.register({ name: 'slowpoke-clean', description: 'Clean up after your Slowpoke' })
    await $.command.register({ name: 'slowpoke-play', description: 'Play with your Slowpoke' })

    const saved = (await $.store.get(STORE_KEY)) as Pet | undefined
    const now = await $.clock.now()
    const start = saved ? decay(saved, now) : hatch(now)
    await update($, pet, () => start)
    await update($, anim, a => ({ ...a, lastAct: now }))
    $.ui.status(statusLine(start))

    stopTicker?.()
    stopTicker = $.clock.every(TICK_MS, () => {
      void update($, anim, a => ({ ...a, tick: a.tick + 1 }))
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, anim, a => ({
      ...a,
      lastAct: now,
      bubble: 'hmm? oh, hi',
      bubbleUntil: a.tick + 8,
    }))

    return next(e)
  })

  on('command.run', { command: 'slowpoke' }, async $ => {
    const saved = await read($, pet)
    const now = await $.clock.now()
    const p = decay(saved ?? hatch(now), now)

    return { text: `${statusLine(p)} · mood: ${mood(p)} · tokens ${p.tokens.toLocaleString()}` }
  })

  on('command.run', { command: 'slowpoke-feed' }, async $ => ({
    text: await act($, 'feed'),
  }))

  on('command.run', { command: 'slowpoke-clean' }, async $ => ({
    text: await act($, 'clean'),
  }))

  on('command.run', { command: 'slowpoke-play' }, async $ => ({
    text: await act($, 'play'),
  }))

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.usage) {
      const spent =
        e.usage.input_tokens + e.usage.output_tokens + e.usage.cache_creation_input_tokens
      const out = {} as { pet: Pet; before: string; after: string }
      await update($, pet, prev => {
        const base = decay(prev ?? hatch(now), now)
        out.before = stageOf(base.tokens)
        out.pet = { ...base, tokens: base.tokens + spent }
        out.after = stageOf(out.pet.tokens)
        return out.pet
      })
      await $.store.set(STORE_KEY, out.pet)
      const evolved = out.after !== out.before
      if (evolved) $.ui.toast(`Slowpoke evolved into ${out.after}!`)
      await update($, anim, a => ({
        ...a,
        lastAct: now,
        ...(evolved
          ? {
              act: 'evolve',
              actUntil: a.tick + 12,
              bubble: `I feel different... ${out.after}!`,
              bubbleUntil: a.tick + 16,
            }
          : {}),
      }))
      $.ui.status(statusLine(out.pet))
    }

    return next(e)
  })

  // The band above the prompt: the pixel slowpoke, his speech, his stats, and his care buttons.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const saved = await read($, pet)
    if (!saved) return next(e)

    const { Box, Button, Raster, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const a = await read($, anim)
    const p = decay(saved, now)
    const pose = poseOf(p, a, now)
    const bubble =
      a.tick < a.bubbleUntil && a.bubble ? a.bubble : pose === 'sleep' ? 'zzz' : null

    return (
      <Box flexDirection="column">
        {bubble && <Text>{`💬 ${bubble}`}</Text>}
        {e.surface === 'terminal' ? (
          <Raster
            key="slowpoke"
            columns={WIDTH}
            rows={ROWS / 2}
            cells={toCells(compose(p, a, now))}
          />
        ) : (
          <Text>{pose === 'sleep' ? '🐌 zzz' : '🐌'}</Text>
        )}
        <Text dimColor>
          {stageOf(p.tokens)} · {mood(p)} · full {bar(p.hunger)} · happy {bar(p.happiness)} · {p.tokens.toLocaleString()} tokens
        </Text>
        <Box>
          <Button key="feed" label="Feed" onPress={() => act($, 'feed')} />
          <Button key="clean" label="Clean" onPress={() => act($, 'clean')} />
          <Button key="play" label="Play" onPress={() => act($, 'play')} />
        </Box>
      </Box>
    )
  })
}
