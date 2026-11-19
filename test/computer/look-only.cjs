// CHAT_V2_FAKE_COMPUTER for live runs on a real desktop: the real platform, with everything that
// would change the desktop refused (input, focus changes, opening and revealing). Looking, the
// window list, the control tree and file search still run. Each refusal prints "[look-only] …".
const refuse = (what) => async () => {
  console.log(`[look-only] refused ${what}`)
  throw new Error(`${what} is off in this test run.`)
}

const ACTS = ['restoreFocus', 'focusWindow', 'click', 'drag', 'scroll', 'type', 'keys', 'invoke', 'setValue', 'open', 'reveal']

exports.wrap = (platform) => {
  const looked = { ...platform }
  for (const name of ACTS) looked[name] = refuse(name)
  return looked
}
