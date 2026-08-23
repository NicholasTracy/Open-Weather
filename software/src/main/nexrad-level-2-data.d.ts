declare module 'nexrad-level-2-data' {
  const Level2Radar: new (file: Uint8Array, options?: { logger?: boolean | object }) => unknown
  export default Level2Radar
}
