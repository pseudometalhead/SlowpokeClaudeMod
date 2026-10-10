import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

// Nothing beneath the mod answers the engine's own events, so the test does.
const answerCommands = (on: On) => {
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
}

const start = () => ({ cwd: '/tmp', surface: 'terminal' as const, isInteractive: false })

const usage = (input: number) => ({
  input_tokens: input,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'test-model',
})

const pet = (overrides: Record<string, unknown>) => ({
  hunger: 80,
  happiness: 80,
  poop: 0,
  tokens: 0,
  updatedAt: 0,
  coins: 0,
  owned: [],
  wearing: [],
  ...overrides,
})

const status = async ($: Engine) => (await $.command.run({ command: 'slowpoke', args: '' })).text

describe('slowpoke', () => {
  test('a new session hatches a baby with no coins', async ($, on) => {
    answerCommands(on)
    mock.clock(on, { now: 0 })
    mock.store(on)
    await $.session.start(start())

    const text = await status($)
    expect(text).toContain('Baby Slowpoke')
    expect(text).toContain('coins 0')
  })

  test('an apple adds 25 hunger and 6 happiness', async ($, on) => {
    answerCommands(on)
    mock.clock(on, { now: 0 })
    mock.store(on, { pet: pet({ hunger: 50, happiness: 50 }) })
    await $.session.start(start())

    const reply = await $.command.run({ command: 'slowpoke-feed', args: 'apple' })
    expect(reply.text).toContain('crunch! apple')
    expect(await status($)).toContain('full 75')
    expect(await status($)).toContain('happy 56')
  })

  test('lemon is sour and costs him happiness', async ($, on) => {
    answerCommands(on)
    mock.clock(on, { now: 0 })
    mock.store(on, { pet: pet({ hunger: 50, happiness: 50 }) })
    await $.session.start(start())

    await $.command.run({ command: 'slowpoke-feed', args: 'lemon' })
    expect(await status($)).toContain('happy 40')
  })

  test('an unknown food gets the menu back', async ($, on) => {
    answerCommands(on)
    mock.clock(on, { now: 0 })
    mock.store(on)
    await $.session.start(start())

    const reply = await $.command.run({ command: 'slowpoke-feed', args: 'pizza' })
    expect(reply.text).toContain('No "pizza" on the menu')
  })

  // Advancing an hour runs about 7,200 ticks, so this one needs more than the default 5 seconds.
  test('an hour away costs him ten hunger', { timeoutMs: 30_000 }, async ($, on) => {
    answerCommands(on)
    const clock = mock.clock(on, { now: 0 })
    mock.store(on, { pet: pet({ hunger: 80 }) })
    await $.session.start(start())

    await clock.advance(60 * 60_000)
    expect(await status($)).toContain('full 70')
  })

  test('every 10,000 tokens pays a coin and grows him', async ($, on) => {
    answerCommands(on)
    mock.clock(on, { now: 0 })
    mock.store(on)
    await $.session.start(start())

    await $.turn.complete({
      answer: '',
      durationMs: 1,
      isAborted: false,
      turnId: 'turn-1',
      reason: 'answer',
      usage: usage(25_000),
    })
    expect(await status($)).toContain('coins 2')
  })
})

describe('the band', () => {
  test('draws on the terminal and Feed opens the food menu', async ($, on) => {
    answerCommands(on)
    mock.clock(on, { now: 0 })
    mock.store(on, { pet: pet({}) })
    await $.session.start(start())

    const band = await $.ui.mount({
      plugin: 'slowpoke-tamagotchi',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false },
    })

    expect(await band.find({ key: 'slowpoke' })).toBeDefined()
    expect(await band.find({ key: 'berry' })).toBeUndefined()

    await band.press({ key: 'feed' })
    expect(await band.find({ key: 'berry' })).toBeDefined()
    expect(await band.find({ key: 'lemon' })).toBeDefined()
  })

  test('the shop sells a bow once, then wears it', async ($, on) => {
    answerCommands(on)
    mock.clock(on, { now: 0 })
    mock.store(on, { pet: pet({ coins: 20 }) })
    await $.session.start(start())

    const band = await $.ui.mount({
      plugin: 'slowpoke-tamagotchi',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false },
    })

    await band.press({ key: 'shop' })
    expect((await band.find({ key: 'bow' }))?.text).toContain('Bow 10c')

    await band.press({ key: 'bow' })
    expect(await status($)).toContain('coins 10')
    expect((await band.find({ key: 'bow' }))?.text).toContain('take off Bow')
  })

  test('a game ends back on the care buttons after one choice', async ($, on) => {
    answerCommands(on)
    mock.clock(on, { now: 0 })
    mock.store(on, { pet: pet({}) })
    await $.session.start(start())

    const band = await $.ui.mount({
      plugin: 'slowpoke-tamagotchi',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false },
    })

    await band.press({ key: 'play' })
    await band.press({ key: 'rps' })
    expect(await band.find({ key: 'Rock' })).toBeDefined()

    await band.press({ key: 'Rock' })
    expect(await band.find({ key: 'Rock' })).toBeUndefined()
    expect(await band.find({ key: 'feed' })).toBeDefined()
  })

  test('draws the sprite as an SVG on mobile', async ($, on) => {
    answerCommands(on)
    mock.clock(on, { now: 0 })
    mock.store(on, { pet: pet({}) })
    await $.session.start(start())

    const band = await $.ui.mount({
      plugin: 'slowpoke-tamagotchi',
      surface: 'mobile',
      component: 'AbovePrompt',
      props: { hasSurvey: false },
    })

    expect(await band.find({ key: 'feed' })).toBeDefined()
    expect(JSON.stringify(await band.drawn())).toContain('<svg')
  })

  test('every food on the menu has its own picture on mobile', async ($, on) => {
    answerCommands(on)
    mock.clock(on, { now: 0 })
    mock.store(on, { pet: pet({}) })
    await $.session.start(start())

    const band = await $.ui.mount({
      plugin: 'slowpoke-tamagotchi',
      surface: 'mobile',
      component: 'AbovePrompt',
      props: { hasSurvey: false },
    })

    await band.press({ key: 'feed' })
    const drawn = JSON.stringify(await band.drawn())
    expect(drawn.split('<svg').length - 1).toBeGreaterThanOrEqual(6)
    expect(await band.find({ key: 'lemon' })).toBeDefined()
  })
})
