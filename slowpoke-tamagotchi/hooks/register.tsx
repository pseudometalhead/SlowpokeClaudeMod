import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Anim, FoodId, Game, Pet } from '../types'

type Engine = Parameters<Hook<'turn.complete'>>[0]
type Care = 'clean'
type Pose = 'idle' | 'blink' | 'happy' | 'grumpy' | 'sleep' | 'eat' | 'clean' | 'play' | 'evolve'

const pet = atom({ plugin: 'slowpoke-tamagotchi', key: 'pet' } as const, null as Pet | null)
const anim = atom({ plugin: 'slowpoke-tamagotchi', key: 'anim' } as const, {
  tick: 0,
  act: null,
  actUntil: 0,
  bubble: null,
  bubbleUntil: 0,
  lastAct: 0,
  food: null,
  isMenuOpen: false,
} as Anim)

// The menu. Each food fills him by a different amount and changes his mood.
const FOODS: Record<FoodId, { label: string; hunger: number; happy: number; colour: string; says: string }> = {
  berry: { label: 'Berry', hunger: 40, happy: 3, colour: 'v', says: 'mmm, berry' },
  apple: { label: 'Apple', hunger: 25, happy: 6, colour: 'r', says: 'crunch! apple' },
  honey: { label: 'Honey', hunger: 15, happy: 15, colour: 'h', says: 'sticky... happy' },
  lettuce: { label: 'Lettuce', hunger: 30, happy: 0, colour: 'a', says: 'crunch... healthy, I guess' },
  lemon: { label: 'Lemon', hunger: 10, happy: -10, colour: 'l', says: '*puckers* ...sour!' },
}
const FOOD_IDS = Object.keys(FOODS) as FoodId[]
const isFood = (word: string): word is FoodId => word in FOODS

const game = atom({ plugin: 'slowpoke-tamagotchi', key: 'game' } as const, {
  mode: 'off',
  ball: 0,
  startTick: 0,
} as Game)
const CUPS = ['Left', 'Middle', 'Right']
const MOVES = ['Rock', 'Paper', 'Scissors']
const NO_GAME: Game = { mode: 'off', ball: 0, startTick: 0 }

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
  v: 0x8e44ad,
  a: 0x7ddc5a,
  h: 0xf2b134,
  l: 0xf7f060,
}
const DEFAULT_COLOR = 0x01000000

const clamp = (n: number) => Math.max(0, Math.min(100, n))
const stageIndex = (tokens: number) => STAGES.filter(s => tokens >= s.from).length - 1
const stageOf = (tokens: number) => STAGES[stageIndex(tokens)].name
const ACT = { clean: 'clean', play: 'play' } as const

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

function care(p: Pet): { pet: Pet; text: string } {
  if (p.poop === 0) return { pet: p, text: 'nothing to clean... *smug*' }
  return {
    pet: { ...p, poop: 0, happiness: clamp(p.happiness + 5) },
    text: 'ahh, much better',
  }
}

function feed(p: Pet, food: FoodId): { pet: Pet; text: string } {
  if (p.hunger >= 100) return { pet: p, text: 'too full... *blink*' }
  const f = FOODS[food]
  return {
    pet: { ...p, hunger: clamp(p.hunger + f.hunger), happiness: clamp(p.happiness + f.happy) },
    text: f.says,
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
    if (flip && a.food) {
      const colour = FOODS[a.food].colour
      sprite[6][13] = colour
      sprite[6][14] = colour
      sprite[7][14] = colour
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

// Runs one care action or one food. A food is eaten, and the rest are care.
async function act($: Engine, what: Care | FoodId): Promise<string> {
  const now = await $.clock.now()
  const out = {} as { pet: Pet; text: string }
  await update($, pet, prev => {
    const base = decay(prev ?? hatch(now), now)
    const done = isFood(what) ? feed(base, what) : care(base)
    out.pet = done.pet
    out.text = done.text
    return done.pet
  })
  await $.store.set(STORE_KEY, out.pet)
  await update($, anim, a => ({
    ...a,
    act: isFood(what) ? 'eat' : ACT[what],
    actUntil: a.tick + 6,
    food: isFood(what) ? what : null,
    bubble: out.text,
    bubbleUntil: a.tick + 12,
    lastAct: now,
  }))
  $.ui.status(statusLine(out.pet))
  return out.text
}

async function say($: Engine, text: string): Promise<void> {
  await update($, anim, a => ({ ...a, bubble: text, bubbleUntil: a.tick + 12 }))
}

// The Timing marker sweeps 0 to 10 and back, one step per tick.
const markerAt = (t: number) => {
  const m = ((t % 20) + 20) % 20
  return m <= 10 ? m : 20 - m
}

// Ends a game: it costs a little hunger, moves his happiness, and he says a line.
async function finishGame($: Engine, happy: number, text: string): Promise<void> {
  const now = await $.clock.now()
  const out = {} as { pet: Pet }
  await update($, pet, prev => {
    const base = decay(prev ?? hatch(now), now)
    out.pet = { ...base, hunger: clamp(base.hunger - 3), happiness: clamp(base.happiness + happy) }
    return out.pet
  })
  await $.store.set(STORE_KEY, out.pet)
  await update($, anim, a => ({
    ...a,
    act: 'play',
    actUntil: a.tick + 6,
    bubble: text,
    bubbleUntil: a.tick + 12,
    lastAct: now,
  }))
  await update($, game, () => NO_GAME)
  $.ui.status(statusLine(out.pet))
}

async function openGames($: Engine): Promise<void> {
  const p = await read($, pet)
  if (p && p.hunger < 20) return say($, 'too hungry to play...')
  await update($, game, () => ({ ...NO_GAME, mode: 'menu' }))
}

const closeGames = ($: Engine) => update($, game, () => NO_GAME)

async function startGame($: Engine, mode: 'cups' | 'rps' | 'timing'): Promise<void> {
  const a = await read($, anim)
  await update($, game, () => ({ mode, ball: Math.floor(Math.random() * 3), startTick: a.tick }))
}

async function pickCup($: Engine, cup: number): Promise<void> {
  const g = await read($, game)
  const hit = cup === g.ball
  await finishGame(
    $,
    hit ? 10 : 1,
    hit ? 'found it! *happy wobble*' : `wrong cup... it was the ${CUPS[g.ball].toLowerCase()} one`,
  )
}

// Rock (0), Paper (1), Scissors (2). The result is 0 for a tie, 1 for his loss and 2 for his win.
async function throwMove($: Engine, move: number): Promise<void> {
  const bot = Math.floor(Math.random() * 3)
  const result = (move - bot + 3) % 3
  const verdict = ['a tie, again!', 'you win! *proud*', 'I win! hehe'][result]
  await finishGame($, [4, 10, 2][result], `I threw ${MOVES[bot].toLowerCase()}... ${verdict}`)
}

async function stopTiming($: Engine): Promise<void> {
  const a = await read($, anim)
  const g = await read($, game)
  const isHit = [4, 5, 6].includes(markerAt(a.tick - g.startTick))
  await finishGame($, isHit ? 15 : 2, isHit ? 'PERFECT! *sparkle*' : 'almost...')
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

  on('command.run', { command: 'slowpoke-feed' }, async ($, e) => {
    const word = (e.args ?? '').trim().toLowerCase()
    if (!word) return { text: `Foods: ${FOOD_IDS.join(', ')}. Try /slowpoke-feed apple` }
    if (!isFood(word)) return { text: `No "${word}" on the menu. Foods: ${FOOD_IDS.join(', ')}` }

    return { text: await act($, word) }
  })

  on('command.run', { command: 'slowpoke-clean' }, async $ => ({
    text: await act($, 'clean'),
  }))

  on('command.run', { command: 'slowpoke-play' }, async $ => {
    await openGames($)

    return { text: 'Pick a game in the band above.' }
  })

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
    const g = await read($, game)
    const p = decay(saved, now)
    const track = Array.from({ length: 11 }, (_, i) =>
      i === markerAt(a.tick - g.startTick) ? '█' : i >= 4 && i <= 6 ? '▓' : '·',
    ).join('')
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
        {g.mode !== 'off' ? (
          g.mode === 'menu' ? (
            <Box>
              <Button key="cups" label="Cups" onPress={() => startGame($, 'cups')} />
              <Button key="rps" label="Rock Paper Scissors" onPress={() => startGame($, 'rps')} />
              <Button key="timing" label="Timing" onPress={() => startGame($, 'timing')} />
              <Button key="back" label="Back" onPress={() => closeGames($)} />
            </Box>
          ) : g.mode === 'cups' ? (
            <Box>
              <Text>Which cup hides the berry?</Text>
              {CUPS.map((cup, i) => (
                <Button key={cup} label={cup} onPress={() => pickCup($, i)} />
              ))}
              <Button key="cancel" label="Cancel" onPress={() => closeGames($)} />
            </Box>
          ) : g.mode === 'rps' ? (
            <Box>
              {MOVES.map((move, i) => (
                <Button key={move} label={move} onPress={() => throwMove($, i)} />
              ))}
              <Button key="cancel" label="Cancel" onPress={() => closeGames($)} />
            </Box>
          ) : (
            <Box>
              <Text>{track}</Text>
              <Button key="stop" label="Stop!" onPress={() => stopTiming($)} />
              <Button key="cancel" label="Cancel" onPress={() => closeGames($)} />
            </Box>
          )
        ) : a.isMenuOpen ? (
          <Box>
            {FOOD_IDS.map(id => (
              <Button
                key={id}
                label={FOODS[id].label}
                onPress={async () => {
                  await update($, anim, prev => ({ ...prev, isMenuOpen: false }))
                  await act($, id)
                }}
              />
            ))}
            <Button
              key="cancel"
              label="Cancel"
              onPress={() => update($, anim, prev => ({ ...prev, isMenuOpen: false }))}
            />
          </Box>
        ) : (
          <Box>
            <Button
              key="feed"
              label="Feed ▸"
              onPress={() => update($, anim, prev => ({ ...prev, isMenuOpen: true }))}
            />
            <Button key="clean" label="Clean" onPress={() => act($, 'clean')} />
            <Button key="play" label="Play ▸" onPress={() => openGames($)} />
          </Box>
        )}
      </Box>
    )
  })
}
