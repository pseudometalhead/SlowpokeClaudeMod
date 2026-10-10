/** One slowpoke. Stats run 0 to 100; `poop` counts piles, 0 to 3. */
export type Pet = {
  hunger: number
  happiness: number
  poop: number
  /** Lifetime tokens spent on this pet's growth (input + output + cache writes). */
  tokens: number
  /** When the stats were last brought up to date, in ms since the epoch. */
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'slowpoke-tamagotchi': { pet: Pet | null }
  }
}
