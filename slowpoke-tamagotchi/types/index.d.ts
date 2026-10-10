/** One slowpoke. Stats run 0 to 100; `poop` counts piles, 0 to 3. */
export type Pet = {
  hunger: number
  happiness: number
  poop: number
  /** Lifetime tokens spent on this pet's growth (input + output + cache writes). */
  tokens: number
  /** When the stats were last brought up to date, in ms since the epoch. */
  updatedAt: number
  /** Coins, earned by games, cleaning and every 10,000 tokens. */
  coins: number
  /** Shop items he has bought. */
  owned: ItemId[]
  /** Shop items he is wearing right now. */
  wearing: ItemId[]
}

export type ItemId = 'flower' | 'bow' | 'shades' | 'hat'

/** What the band is doing right now. `tick` advances every half second. */
export type Anim = {
  tick: number
  act: 'eat' | 'clean' | 'play' | 'evolve' | 'gasp' | 'cheer' | null
  actUntil: number
  bubble: string | null
  bubbleUntil: number
  /** When the person last did something, in ms since the epoch. */
  lastAct: number
  /** The food being eaten, while `act` is `eat`. */
  food: FoodId | null
  /** Whether the food menu is showing in place of the care buttons. */
  isMenuOpen: boolean
  /** Tool calls so far in the current turn; many of them make him tired. */
  toolCalls: number
}

export type FoodId = 'berry' | 'apple' | 'honey' | 'lettuce' | 'lemon'

/** Which game, or the shop, the band is showing: `off` for the care buttons. */
export type GameMode = 'off' | 'menu' | 'cups' | 'rps' | 'timing' | 'shop'

export type Game = {
  mode: GameMode
  /** The cup, 0 to 2, that hides the berry in Cups. */
  ball: number
  /** The tick the current game started on; Timing reads its marker from it. */
  startTick: number
}

declare module 'claude-code' {
  interface PluginState {
    'slowpoke-tamagotchi': { pet: Pet | null; anim: Anim; game: Game }
  }
}
