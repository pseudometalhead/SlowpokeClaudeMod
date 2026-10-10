import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Pet } from '../types'

type Engine = Parameters<Hook<'turn.complete'>>[0]
type Care = 'feed' | 'clean' | 'play'

const PANE = 'slowpoke'
const STORE_KEY = 'pet'
const pet = atom({ plugin: 'slowpoke-tamagotchi', key: 'pet' } as const, null as Pet | null)

const MINUTE = 60_000
const MAX_MINUTES = 7 * 24 * 60
const STAGES = [
  { from: 0, name: 'Baby Slowpoke' },
  { from: 200_000, name: 'Slowpoke' },
  { from: 2_000_000, name: 'Elder Slowpoke' },
  { from: 10_000_000, name: 'Ancient Slowpoke' },
]

const clamp = (n: number) => Math.max(0, Math.min(100, n))
const stageOf = (tokens: number) => {
  const passed = STAGES.filter(s => tokens >= s.from)
  return passed[passed.length - 1].name
}

const hatch = (now: number): Pet => ({
  hunger: 80,
  happiness: 80,
  poop: 0,
  tokens: 0,
  updatedAt: now,
})

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
      return { pet: p, text: 'Slowpoke is too full to eat. He blinks slowly at you.' }
    }
    return {
      pet: { ...p, hunger: clamp(p.hunger + 40), happiness: clamp(p.happiness + 3) },
      text: 'Slowpoke munches a berry, very slowly.',
    }
  }

  if (what === 'clean') {
    if (p.poop === 0) return { pet: p, text: 'Nothing to clean. Slowpoke looks smug.' }
    return {
      pet: { ...p, poop: 0, happiness: clamp(p.happiness + 5) },
      text: `Cleaned up ${p.poop} pile(s). Slowpoke sighs with relief.`,
    }
  }

  if (p.hunger < 20) return { pet: p, text: 'Slowpoke is too hungry to play.' }
  return {
    pet: { ...p, hunger: clamp(p.hunger - 5), happiness: clamp(p.happiness + 15) },
    text: 'Slowpoke rolls around happily, eventually.',
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
  $.ui.status(statusLine(out.pet))
  return out.text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'slowpoke', description: 'Show your Slowpoke in a pane' })
    await $.command.register({ name: 'slowpoke-feed', description: 'Feed your Slowpoke' })
    await $.command.register({ name: 'slowpoke-clean', description: 'Clean up after your Slowpoke' })
    await $.command.register({ name: 'slowpoke-play', description: 'Play with your Slowpoke' })

    const saved = (await $.store.get(STORE_KEY)) as Pet | undefined
    const now = await $.clock.now()
    const start = saved ? decay(saved, now) : hatch(now)
    await update($, pet, () => start)
    $.ui.status(statusLine(start))

    return next(e)
  })

  on('command.run', { command: 'slowpoke' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Slowpoke' })

    return { text: 'Slowpoke pane opened.' }
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
    if (e.usage) {
      const spent =
        e.usage.input_tokens + e.usage.output_tokens + e.usage.cache_creation_input_tokens
      const now = await $.clock.now()
      const out = {} as { pet: Pet; before: string; after: string }
      await update($, pet, prev => {
        const base = decay(prev ?? hatch(now), now)
        out.before = stageOf(base.tokens)
        out.pet = { ...base, tokens: base.tokens + spent }
        out.after = stageOf(out.pet.tokens)
        return out.pet
      })
      await $.store.set(STORE_KEY, out.pet)
      if (out.after !== out.before) $.ui.toast(`Slowpoke evolved into ${out.after}!`)
      $.ui.status(statusLine(out.pet))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const saved = await read($, pet)
    if (!saved) return <Text dimColor>Hatching...</Text>

    const p = decay(saved, await $.clock.now())

    return (
      <Box flexDirection="column">
        <Text>{stageOf(p.tokens)}</Text>
        <Text>{`   ____`}</Text>
        <Text>{`__/ -  -\\__   ${p.poop > 0 ? '💩'.repeat(p.poop) : ''}`}</Text>
        <Text>{`(____________)  is ${mood(p)}`}</Text>
        <Text dimColor>{`full      ${bar(p.hunger)} ${p.hunger}`}</Text>
        <Text dimColor>{`happy     ${bar(p.happiness)} ${p.happiness}`}</Text>
        <Text dimColor>{`tokens    ${p.tokens.toLocaleString()}`}</Text>
        <Box>
          <Button key="feed" label="Feed" onPress={() => act($, 'feed')} />
          <Button key="clean" label="Clean" onPress={() => act($, 'clean')} />
          <Button key="play" label="Play" onPress={() => act($, 'play')} />
        </Box>
      </Box>
    )
  })
}
